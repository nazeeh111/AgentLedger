import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { relative } from "./schema.ts";
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export async function confined(
  root: string,
  rel: string,
  mustExist = true,
): Promise<string> {
  const normalized = relative(rel),
    full = path.resolve(root, normalized);
  if (full !== root && !full.startsWith(root + path.sep))
    throw Error("Path leaves root");
  let current = root;
  for (const segment of normalized.split("/")) {
    if (segment === ".") continue;
    current = path.join(current, segment);
    try {
      const s = await fs.lstat(current);
      if (s.isSymbolicLink()) throw Error("Symlink paths are not permitted");
    } catch (e) {
      if (!mustExist && (e as NodeJS.ErrnoException).code === "ENOENT")
        continue;
      throw e;
    }
  }
  return full;
}
export async function fileHash(
  root: string,
  rel: string,
): Promise<{ path: string; sha256: string; bytes: number }> {
  const full = await confined(root, rel);
  const before = await fs.lstat(full);
  if (!before.isFile() || before.size > 32 * 1024 * 1024)
    throw Error("Artifacts and inputs must be regular files at most 32 MiB");
  const handle = await fs.open(
    full,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const st = await handle.stat();
    if (
      !st.isFile() ||
      st.size > 32 * 1024 * 1024 ||
      st.ino !== before.ino ||
      st.dev !== before.dev
    )
      throw Error("Artifacts and inputs must be regular files at most 32 MiB");
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 65536,
    })) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024)
        throw Error("File exceeded size bound while reading");
      digest.update(chunk);
    }
    const end = await handle.stat();
    if (end.size !== st.size || end.mtimeMs !== st.mtimeMs || bytes !== st.size)
      throw Error("File changed during hashing");
    return { path: rel, sha256: digest.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}
export async function atomic(target: string, data: string): Promise<void> {
  try {
    const s = await fs.lstat(target);
    if (!s.isFile() || s.isSymbolicLink())
      throw Error("Refusing unsafe report target");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const tmp = target + "." + randomUUID() + ".tmp";
  await fs.writeFile(tmp, data, { flag: "wx", mode: 0o600 });
  try {
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
export function parseManifest(text: string): unknown {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw Error("Manifest exceeds 1 MiB");
  const parsed: unknown = JSON.parse(text);
  let i = 0;
  const ws = () => {
    while (/\s/.test(text[i] ?? "") && i < text.length) i++;
  };
  const string = () => {
    const start = i++;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i++] === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw Error("Malformed string");
  };
  function walk(depth: number) {
    if (depth > 32) throw Error("Manifest nesting exceeds 32");
    ws();
    if (text[i] === "{") {
      i++;
      ws();
      const seen = new Set<string>();
      while (text[i] !== "}") {
        const key = string();
        if (seen.has(key)) throw Error("Duplicate JSON key");
        seen.add(key);
        ws();
        i++;
        walk(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          ws();
        } else break;
      }
      i++;
    } else if (text[i] === "[") {
      i++;
      ws();
      while (text[i] !== "]") {
        walk(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          ws();
        } else break;
      }
      i++;
    } else if (text[i] === '"') string();
    else {
      while (i < text.length && !/[\s,}\]]/.test(text[i]!)) i++;
    }
  }
  walk(0);
  return parsed;
}
