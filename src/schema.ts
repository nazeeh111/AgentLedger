import path from "node:path";
export type Artifact = { path: string; sha256?: string };
export type Review = {
  checks: string[];
  artifacts: { task: string; path: string }[];
  opinion?: string;
};
export type Task = {
  id: string;
  deps: string[];
  cwd: string;
  timeoutMs: number;
  retries: number;
  inputs: string[];
  artifacts: Artifact[];
  command?: string[];
  expectedExit: number;
  codex?: { prompt: string };
  review?: Review;
};
export type Workflow = {
  version: 1;
  name: string;
  concurrency: number;
  tasks: Task[];
};
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function keys(o: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(o).some((k) => !allowed.includes(k)))
    throw Error("Unknown workflow field");
}
function text(v: unknown, max = 4096): v is string {
  return (
    typeof v === "string" &&
    v.length > 0 &&
    v.length <= max &&
    !v.includes("\0")
  );
}
function integer(v: unknown, min: number, max: number) {
  return Number.isInteger(v) && Number(v) >= min && Number(v) <= max;
}
export function relative(v: unknown): string {
  if (
    !text(v) ||
    path.isAbsolute(v) ||
    v.includes("\\") ||
    v.split("/").some((p) => p === ".." || p === "") ||
    v.startsWith("~")
  )
    throw Error("Paths must be nonempty confined relative paths");
  return path.posix.normalize(v);
}
function strings(v: unknown, max: number) {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => text(x)))
    throw Error("Invalid string list");
  return v as string[];
}
export function validate(value: unknown): Workflow {
  if (!object(value)) throw Error("Workflow must be an object");
  keys(value, ["version", "name", "concurrency", "tasks"]);
  if (
    value.version !== 1 ||
    !text(value.name, 120) ||
    !integer(value.concurrency ?? 2, 1, 8) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length < 1 ||
    value.tasks.length > 64
  )
    throw Error("Invalid workflow header or task count");
  const tasks: Task[] = value.tasks.map((raw) => {
    if (!object(raw)) throw Error("Task must be an object");
    keys(raw, [
      "id",
      "deps",
      "cwd",
      "timeoutMs",
      "retries",
      "inputs",
      "artifacts",
      "command",
      "expectedExit",
      "codex",
      "review",
    ]);
    if (!text(raw.id, 64) || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(raw.id))
      throw Error("Invalid task ID");
    const deps = strings(raw.deps ?? [], 64);
    if (new Set(deps).size !== deps.length) throw Error("Duplicate dependency");
    const inputs = strings(raw.inputs ?? [], 32).map(relative);
    if (new Set(inputs).size !== inputs.length)
      throw Error("Duplicate input path");
    if (
      !integer(raw.timeoutMs ?? 30000, 50, 300000) ||
      !integer(raw.retries ?? 0, 0, 2) ||
      !integer(raw.expectedExit ?? 0, 0, 255)
    )
      throw Error("Invalid execution bounds");
    const artifacts = raw.artifacts ?? [];
    if (!Array.isArray(artifacts) || artifacts.length > 16)
      throw Error("Invalid artifacts");
    const mapped = artifacts.map((a) => {
      if (!object(a)) throw Error("Artifact must be object");
      keys(a, ["path", "sha256"]);
      if (
        a.sha256 !== undefined &&
        (typeof a.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.sha256))
      )
        throw Error("Invalid expected artifact hash");
      return {
        path: relative(a.path),
        ...(a.sha256 ? { sha256: a.sha256 as string } : {}),
      };
    });
    const modes = [raw.command, raw.codex, raw.review].filter(
      (v) => v !== undefined,
    );
    if (modes.length !== 1)
      throw Error("Each task needs exactly one command, codex or review");
    const t: Task = {
      id: raw.id,
      deps,
      cwd: relative(raw.cwd ?? "."),
      timeoutMs: Number(raw.timeoutMs ?? 30000),
      retries: Number(raw.retries ?? 0),
      inputs,
      artifacts: mapped,
      expectedExit: Number(raw.expectedExit ?? 0),
    };
    if (raw.command !== undefined) {
      const command = raw.command;
      if (
        !Array.isArray(command) ||
        !command.length ||
        command.length > 64 ||
        !text(command[0]) ||
        !command.every(
          (x) => typeof x === "string" && x.length <= 4096 && !x.includes("\0"),
        ) ||
        command.reduce((n, s) => n + s.length, 0) > 16384
      )
        throw Error("Invalid command");
      t.command = command as string[];
    }
    if (raw.codex !== undefined) {
      if (!object(raw.codex)) throw Error("Invalid Codex task");
      keys(raw.codex, ["prompt"]);
      if (!text(raw.codex.prompt, 16000)) throw Error("Invalid prompt");
      if (mapped.length || t.retries || raw.expectedExit !== undefined)
        throw Error(
          "Codex opinions cannot declare automated artifacts, retries or exit criteria",
        );
      t.codex = { prompt: raw.codex.prompt };
    }
    if (raw.review !== undefined) {
      if (!object(raw.review)) throw Error("Invalid review");
      keys(raw.review, ["checks", "artifacts", "opinion"]);
      const checks = strings(raw.review.checks, 64);
      if (
        !checks.length ||
        !Array.isArray(raw.review.artifacts) ||
        raw.review.artifacts.length < 1 ||
        raw.review.artifacts.length > 64
      )
        throw Error("Review needs checks and artifacts");
      const refs = raw.review.artifacts.map((a) => {
        if (!object(a)) throw Error("Invalid review artifact");
        keys(a, ["task", "path"]);
        if (!text(a.task, 64)) throw Error("Invalid artifact task");
        return { task: a.task, path: relative(a.path) };
      });
      if (raw.review.opinion !== undefined && !text(raw.review.opinion, 64))
        throw Error("Invalid opinion task");
      if (mapped.length || t.retries || raw.expectedExit !== undefined)
        throw Error("Review cannot declare command outputs or retries");
      t.review = {
        checks,
        artifacts: refs,
        ...(raw.review.opinion
          ? { opinion: raw.review.opinion as string }
          : {}),
      };
    }
    return t;
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length) throw Error("Duplicate task ID");
  const active = new Set<string>(),
    done = new Set<string>();
  function visit(t: Task) {
    if (active.has(t.id)) throw Error("Dependency cycle");
    if (done.has(t.id)) return;
    active.add(t.id);
    for (const d of t.deps) {
      const dep = byId.get(d);
      if (!dep) throw Error("Missing dependency");
      visit(dep);
    }
    active.delete(t.id);
    done.add(t.id);
  }
  tasks.forEach(visit);
  const producers = new Map<string, string>();
  for (const t of tasks)
    for (const a of t.artifacts) {
      if (producers.has(a.path))
        throw Error("Multiple declarations write the same artifact");
      producers.set(a.path, t.id);
    }
  const ancestry = new Map<string, Set<string>>();
  function ancestors(t: Task): Set<string> {
    const found = ancestry.get(t.id);
    if (found) return found;
    const result = new Set(
      t.deps.flatMap((d) => [d, ...ancestors(byId.get(d)!)]),
    );
    ancestry.set(t.id, result);
    return result;
  }
  for (const t of tasks) {
    const upstream = ancestors(t);
    for (const input of t.inputs) {
      const producer = producers.get(input);
      if (producer && !upstream.has(producer))
        throw Error("Artifact inputs require an upstream producer");
    }
    if (t.review) {
      for (const id of t.review.checks) {
        if (!t.deps.includes(id) || !byId.get(id)?.command)
          throw Error("Review checks must name direct command dependencies");
      }
      for (const a of t.review.artifacts) {
        if (
          !t.deps.includes(a.task) ||
          !byId.get(a.task)?.artifacts.some((x) => x.path === a.path)
        )
          throw Error(
            "Review artifacts must name declared direct dependency outputs",
          );
      }
      if (
        t.review.opinion &&
        (!t.deps.includes(t.review.opinion) ||
          !byId.get(t.review.opinion)?.codex)
      )
        throw Error("Opinion must name a direct Codex dependency");
    }
  }
  if (tasks.reduce((n, t) => n + t.timeoutMs * (t.retries + 1), 0) > 3600000)
    throw Error("Combined timeout budget exceeds one hour");
  return {
    version: 1,
    name: value.name,
    concurrency: Number(value.concurrency ?? 2),
    tasks,
  };
}
