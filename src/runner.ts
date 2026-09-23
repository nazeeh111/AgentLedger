import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { canonical, hash, confined, fileHash, atomic } from "./files.ts";
import type { Workflow, Task } from "./schema.ts";
export type Status =
  | "success"
  | "failed"
  | "timeout"
  | "cancelled"
  | "skipped"
  | "cached";
export type Evidence = { path: string; sha256: string; bytes: number };
export type Opinion = {
  verdict: "approve" | "changes" | "inconclusive";
  rationale: string;
};
export type Result = {
  id: string;
  dependencies: string[];
  cwd: string;
  expectedExit: number;
  status: Status;
  attempts: number;
  durationMs: number;
  fingerprint: string;
  exitCode: number | null;
  artifacts: Evidence[];
  command?: string[];
  reason?: string;
  output?: string;
  outputTruncated?: boolean;
  modelOpinion?: Opinion;
  automatedProof?: { checks: string[]; artifacts: Evidence[] };
};
export type RunReport = {
  schema: "agent-ledger-v1";
  name: string;
  node: string;
  startedAt: string;
  finishedAt: string;
  status: "passed" | "failed" | "cancelled";
  tasks: Result[];
};
export type Options = {
  root: string;
  out: string;
  allowCodex?: boolean;
  resume?: boolean;
  includeOutput?: boolean;
  signal?: AbortSignal;
  codexExecutable?: string;
};
const passed = (r: Result | undefined) =>
  r?.status === "success" || r?.status === "cached";
const environment = () =>
  Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "SystemRoot",
      "CODEX_HOME",
    ].flatMap((k) =>
      process.env[k] === undefined ? [] : [[k, process.env[k]!]],
    ),
  );

export async function processTask(
  command: string[],
  cwd: string,
  timeout: number,
  signal?: AbortSignal,
  stdin?: string,
): Promise<{
  status: Status;
  exitCode: number | null;
  output: string;
  truncated: boolean;
}> {
  if (process.platform === "win32")
    throw Error(
      "Execution currently requires POSIX process groups (macOS/Linux)",
    );
  return new Promise((resolve) => {
    let output = Buffer.alloc(0),
      truncated = false,
      status: Status = "success",
      settled = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = spawn(command[0]!, command.slice(1), {
      cwd,
      env: environment(),
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const capture = (chunk: Buffer) => {
      const room = 65536 - output.length;
      if (chunk.length > room) truncated = true;
      if (room > 0) output = Buffer.concat([output, chunk.subarray(0, room)]);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, sig);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") status = "failed";
        }
    };
    const stop = (why: Status) => {
      if (status === "timeout" || status === "cancelled") return;
      status = why;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 150);
    };
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    timer = setTimeout(() => stop("timeout"), timeout);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const done = () => {
        kill("SIGKILL");
        if (killTimer) clearTimeout(killTimer);
        resolve({
          status,
          exitCode: code,
          output: output.toString("utf8"),
          truncated,
        });
      };
      if (status === "timeout" || status === "cancelled") setTimeout(done, 170);
      else done();
    };
    child.on("error", () => {
      status = "failed";
      finish(null);
    });
    child.on("close", finish);
  });
}
const opinionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "rationale"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes", "inconclusive"] },
    rationale: { type: "string" },
  },
};
export function parseOpinion(text: string): Opinion {
  if (Buffer.byteLength(text) > 16384) throw Error("Opinion exceeds limit");
  const v = JSON.parse(text);
  if (
    !v ||
    typeof v !== "object" ||
    Object.keys(v).sort().join(",") !== "rationale,verdict" ||
    !["approve", "changes", "inconclusive"].includes(v.verdict) ||
    typeof v.rationale !== "string" ||
    v.rationale.length > 4000
  )
    throw Error("Invalid model opinion schema");
  return v;
}
export function codexCommand(
  executable: string,
  cwd: string,
  schema: string,
  output: string,
) {
  return [
    executable,
    "exec",
    "--json",
    "--output-schema",
    schema,
    "-s",
    "read-only",
    "-C",
    cwd,
    "--output-last-message",
    output,
    "-",
  ];
}

export async function execute(
  workflow: Workflow,
  options: Options,
): Promise<RunReport> {
  const extension = path.extname(new URL(import.meta.url).pathname);
  const implementation = hash(
    Buffer.concat(
      await Promise.all(
        ["runner", "schema", "files"].map((name) =>
          fs.readFile(new URL(`./${name}${extension}`, import.meta.url)),
        ),
      ),
    ),
  );
  const root = await fs.realpath(options.root),
    output = await confined(root, options.out, false);
  if (output === root) throw Error("Report directory cannot be the root");
  for (const t of workflow.tasks) {
    const cwdPath = await confined(root, t.cwd);
    if (!(await fs.stat(cwdPath)).isDirectory())
      throw Error("Task cwd must be a directory");
    for (const p of [...t.inputs, ...t.artifacts.map((a) => a.path)]) {
      const full = path.resolve(root, p);
      if (
        full === output ||
        full.startsWith(output + path.sep) ||
        output.startsWith(full + path.sep)
      )
        throw Error("Task data conflicts with report directory");
    }
  }
  if (workflow.tasks.some((t) => t.codex) && !options.allowCodex)
    throw Error("Codex tasks require explicit --allow-codex");
  const marker = path.join(output, ".agent-ledger");
  let previous: RunReport | undefined;
  if (options.resume) {
    await confined(root, path.posix.join(options.out, ".agent-ledger"));
    await confined(root, path.posix.join(options.out, "report.json"));
    const markerStat = await fs.stat(marker),
      reportStat = await fs.stat(path.join(output, "report.json"));
    if (
      !markerStat.isFile() ||
      markerStat.size > 32 ||
      !reportStat.isFile() ||
      reportStat.size > 8 * 1024 * 1024
    )
      throw Error("Invalid or oversized resume metadata");
    if ((await fs.readFile(marker, "utf8")) !== "agent-ledger-v1\n")
      throw Error("Not an AgentLedger report directory");
    const prev = await fs.readFile(path.join(output, "report.json"), "utf8");
    if (Buffer.byteLength(prev) > 8 * 1024 * 1024)
      throw Error("Previous report exceeds limit");
    previous = JSON.parse(prev);
    if (
      previous?.schema !== "agent-ledger-v1" ||
      !Array.isArray(previous.tasks)
    )
      throw Error("Invalid previous report");
  } else {
    await fs.mkdir(output, { recursive: false, mode: 0o700 });
    await fs.writeFile(marker, "agent-ledger-v1\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  const results = new Map<string, Result>(),
    running = new Map<string, Promise<void>>();
  const start = new Date().toISOString();
  const blank = (t: Task, status: Status, reason: string): Result => ({
    id: t.id,
    dependencies: t.deps,
    cwd: t.cwd,
    expectedExit: t.expectedExit,
    status,
    attempts: 0,
    durationMs: 0,
    fingerprint: "",
    exitCode: null,
    artifacts: [],
    reason,
    ...(t.command ? { command: t.command } : {}),
  });
  async function task(t: Task): Promise<Result> {
    const began = performance.now();
    let fingerprint = "";
    try {
      const cwd = await confined(root, t.cwd);
      const inputs = await Promise.all(t.inputs.map((p) => fileHash(root, p)));
      const verifyInputs = async () => {
        const current = await Promise.all(
          t.inputs.map((p) => fileHash(root, p)),
        );
        if (canonical(current) !== canonical(inputs))
          throw Error(
            "Declared input changed during execution; rerun with stable inputs",
          );
      };
      fingerprint = hash(
        canonical({
          task: t,
          root,
          cwd,
          inputs,
          dependencies: t.deps.map((id) => ({
            fingerprint: results.get(id)!.fingerprint,
            artifacts: results.get(id)!.artifacts,
          })),
          node: process.version,
          runner: "0.1.0",
          implementation,
        }),
      );
      if (t.command && previous) {
        const old = previous.tasks.find((x) => x.id === t.id);
        if (passed(old) && old!.fingerprint === fingerprint) {
          try {
            const artifacts = await collect(t);
            if (canonical(artifacts) === canonical(old!.artifacts)) {
              await verifyInputs();
              const cached: Result = {
                ...old!,
                dependencies: t.deps,
                cwd: t.cwd,
                expectedExit: t.expectedExit,
                status: "cached",
                durationMs: performance.now() - began,
                attempts: 0,
              };
              if (!options.includeOutput) {
                delete cached.output;
                delete cached.outputTruncated;
              }
              return cached;
            }
          } catch {
            /* Changed or missing artifact means rerun. */
          }
        }
      }
      if (t.review) {
        const refs: Evidence[] = [];
        for (const a of t.review.artifacts) {
          const original = results
            .get(a.task)!
            .artifacts.find((x) => x.path === a.path)!;
          const current = await fileHash(root, a.path);
          if (current.sha256 !== original.sha256)
            throw Error("Review artifact changed after production");
          refs.push(current);
        }
        if (!t.review.checks.every((id) => passed(results.get(id))))
          throw Error("Automated checks did not pass");
        const opinion = t.review.opinion
          ? results.get(t.review.opinion)?.modelOpinion
          : undefined;
        const accepted = !t.review.opinion || opinion?.verdict === "approve";
        return {
          id: t.id,
          dependencies: t.deps,
          cwd: t.cwd,
          expectedExit: t.expectedExit,
          status: accepted ? "success" : "failed",
          attempts: 1,
          durationMs: performance.now() - began,
          fingerprint,
          exitCode: null,
          artifacts: [],
          automatedProof: { checks: t.review.checks, artifacts: refs },
          ...(opinion ? { modelOpinion: opinion } : {}),
          ...(!accepted
            ? {
                reason:
                  "Model opinion did not approve; automated proof remains separately recorded",
              }
            : {}),
        };
      }
      let command = t.command!,
        stdin: string | undefined,
        opinionPath: string | undefined;
      if (t.codex) {
        const schema = path.join(output, `${t.id}-schema.json`);
        opinionPath = path.join(output, `${t.id}-opinion-${randomUUID()}.json`);
        await atomic(schema, JSON.stringify(opinionSchema));
        try {
          await fs.lstat(opinionPath);
          throw Error(
            "Opinion output already exists; use a new run directory for Codex",
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        command = codexCommand(
          options.codexExecutable ?? "codex",
          cwd,
          schema,
          opinionPath,
        );
        stdin = t.codex.prompt;
      }
      let last: Result = blank(t, "failed", "Task did not run");
      for (let attempt = 1; attempt <= t.retries + 1; attempt++) {
        if (options.signal?.aborted)
          return { ...blank(t, "cancelled", "Run cancelled"), fingerprint };
        await verifyInputs();
        const run = await processTask(
          command,
          cwd,
          t.timeoutMs,
          options.signal,
          stdin,
        );
        last = {
          id: t.id,
          dependencies: t.deps,
          cwd: t.cwd,
          expectedExit: t.expectedExit,
          status: run.status,
          attempts: attempt,
          durationMs: performance.now() - began,
          fingerprint,
          exitCode: run.exitCode,
          artifacts: [],
          command,
          ...(options.includeOutput
            ? { output: run.output, outputTruncated: run.truncated }
            : {}),
        };
        try {
          await verifyInputs();
        } catch {
          return {
            ...last,
            status: "failed",
            reason:
              "Declared input changed or became unreadable during execution; rerun with stable inputs",
          };
        }
        if (run.status === "success" && run.exitCode !== t.expectedExit) {
          last.status = "failed";
          last.reason = "Exit code did not match expected criterion";
        }
        if (last.status === "success") {
          try {
            last.artifacts = await collect(t);
            if (t.codex) {
              const st = await fs.lstat(opinionPath!);
              if (!st.isFile() || st.isSymbolicLink() || st.size > 16384)
                throw Error("Invalid opinion output");
              last.modelOpinion = parseOpinion(
                await fs.readFile(opinionPath!, "utf8"),
              );
            }
            await verifyInputs();
            return last;
          } catch {
            last.status = "failed";
            last.reason = "Artifact verification or structured opinion failed";
          }
        }
        if (last.status === "cancelled" || last.status === "timeout") break;
      }
      return last;
    } catch (e) {
      return {
        ...blank(t, "failed", (e as Error).message),
        fingerprint,
        durationMs: performance.now() - began,
      };
    }
  }
  async function collect(t: Task) {
    const artifacts = await Promise.all(
      t.artifacts.map((a) => fileHash(root, a.path)),
    );
    for (let i = 0; i < artifacts.length; i++) {
      const expected = t.artifacts[i]!.sha256;
      if (expected && artifacts[i]!.sha256 !== expected)
        throw Error("Artifact hash mismatch");
    }
    return artifacts;
  }
  while (results.size < workflow.tasks.length) {
    for (const t of workflow.tasks) {
      if (results.has(t.id) || running.has(t.id)) continue;
      if (options.signal?.aborted) {
        results.set(t.id, blank(t, "cancelled", "Run cancelled before start"));
        continue;
      }
      if (!t.deps.every((id) => results.has(id))) continue;
      if (t.deps.some((id) => !passed(results.get(id)))) {
        results.set(
          t.id,
          blank(t, "skipped", "An upstream dependency did not pass"),
        );
        continue;
      }
      if (running.size >= workflow.concurrency) break;
      const promise = task(t)
        .then((r) => {
          results.set(t.id, r);
        })
        .finally(() => {
          running.delete(t.id);
        });
      running.set(t.id, promise);
    }
    if (running.size) await Promise.race(running.values());
    else if (results.size < workflow.tasks.length)
      throw Error("Scheduler made no progress");
  }
  const tasks = workflow.tasks.map((t) => results.get(t.id)!);
  return {
    schema: "agent-ledger-v1",
    name: workflow.name,
    node: process.version,
    startedAt: start,
    finishedAt: new Date().toISOString(),
    status: tasks.some((t) => t.status === "cancelled")
      ? "cancelled"
      : tasks.every(passed)
        ? "passed"
        : "failed",
    tasks,
  };
}
