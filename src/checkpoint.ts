import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomic, confined, parseManifest } from "./files.ts";
import { relative } from "./schema.ts";
import type { Workflow } from "./schema.ts";
import type { Result } from "./runner.ts";

export const checkpointName = ".agent-ledger-checkpoint.json";
const limit = 8 * 1024 * 1024;
type Record = {
  id: string;
  state: "candidate" | "in-flight" | "settled";
  result?: Result;
};
type Checkpoint = {
  schema: "agent-ledger-checkpoint-v1";
  runId: string;
  name: string;
  node: string;
  startedAt: string;
  updatedAt: string;
  records: Record[];
};
export class CheckpointPersistenceError extends Error {}
const success = (result: Result) =>
  result.status === "success" || result.status === "cached";
const object = (value: unknown): value is { [key: string]: unknown } =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 16384): value is string =>
  typeof value === "string" && value.length <= max;
const integer = (value: unknown, min: number, max: number) =>
  Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
const id = (value: unknown): value is string =>
  text(value, 64) && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);
const digest = (value: unknown) =>
  text(value, 64) && /^[a-f0-9]{64}$/.test(value);
const ids = (value: unknown) =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every(id) &&
  new Set(value).size === value.length;
function keys(value: { [key: string]: unknown }, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("Unknown resume metadata field");
}
function evidence(value: unknown) {
  if (!Array.isArray(value) || value.length > 64) return false;
  return value.every((entry) => {
    if (!object(entry)) return false;
    keys(entry, ["path", "sha256", "bytes"]);
    if (
      !text(entry.path) ||
      !digest(entry.sha256) ||
      !integer(entry.bytes, 0, 32 * 1024 * 1024)
    )
      return false;
    relative(entry.path);
    return true;
  });
}
function result(value: unknown): Result {
  if (!object(value)) throw Error("Invalid resume task record");
  keys(value, [
    "id",
    "dependencies",
    "cwd",
    "expectedExit",
    "status",
    "attempts",
    "durationMs",
    "fingerprint",
    "exitCode",
    "artifacts",
    "command",
    "reason",
    "output",
    "outputTruncated",
    "modelOpinion",
    "automatedProof",
  ]);
  if (
    !id(value.id) ||
    !ids(value.dependencies) ||
    !text(value.cwd) ||
    !integer(value.expectedExit, 0, 255) ||
    typeof value.status !== "string" ||
    ![
      "success",
      "cached",
      "failed",
      "timeout",
      "cancelled",
      "skipped",
    ].includes(value.status) ||
    !integer(value.attempts, 0, 3) ||
    typeof value.durationMs !== "number" ||
    !Number.isFinite(value.durationMs) ||
    value.durationMs < 0 ||
    !(value.fingerprint === "" || digest(value.fingerprint)) ||
    !(value.exitCode === null || integer(value.exitCode, 0, 255)) ||
    !evidence(value.artifacts)
  )
    throw Error("Invalid resume task record");
  relative(value.cwd);
  if (
    (value.status === "success" || value.status === "cached") &&
    !digest(value.fingerprint)
  )
    throw Error("Successful resume task lacks fingerprint");
  if (
    value.command !== undefined &&
    (!Array.isArray(value.command) ||
      value.command.length < 1 ||
      value.command.length > 128 ||
      !value.command.every((arg) => text(arg)))
  )
    throw Error("Invalid resume command");
  if (value.reason !== undefined && !text(value.reason))
    throw Error("Invalid resume reason");
  // Capture is bounded in raw bytes; decoding can expand UTF-8 byte length.
  if (value.output !== undefined && !text(value.output, 65536))
    throw Error("Invalid resume output");
  if (
    value.outputTruncated !== undefined &&
    typeof value.outputTruncated !== "boolean"
  )
    throw Error("Invalid resume output flag");
  if (value.modelOpinion !== undefined) {
    const opinion = value.modelOpinion;
    if (!object(opinion)) throw Error("Invalid resume opinion");
    keys(opinion, ["verdict", "rationale"]);
    if (
      typeof opinion.verdict !== "string" ||
      !["approve", "changes", "inconclusive"].includes(opinion.verdict) ||
      !text(opinion.rationale, 4000)
    )
      throw Error("Invalid resume opinion");
  }
  if (value.automatedProof !== undefined) {
    const proof = value.automatedProof;
    if (!object(proof)) throw Error("Invalid resume proof");
    keys(proof, ["checks", "artifacts"]);
    if (!ids(proof.checks) || !evidence(proof.artifacts))
      throw Error("Invalid resume proof");
  }
  return value as Result;
}
function results(value: unknown): Result[] {
  if (!Array.isArray(value) || value.length > 64)
    throw Error("Invalid resume task list");
  const parsed = value.map(result);
  if (new Set(parsed.map((entry) => entry.id)).size !== parsed.length)
    throw Error("Duplicate resume task");
  return parsed;
}
async function read(root: string, rel: string, max: number): Promise<string> {
  const full = await confined(root, rel);
  const before = await fs.lstat(full);
  if (!before.isFile() || before.size > max)
    throw Error("Invalid or oversized resume metadata");
  const handle = await fs.open(
    full,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const initial = await handle.stat();
    if (
      !initial.isFile() ||
      initial.size > max ||
      initial.ino !== before.ino ||
      initial.dev !== before.dev
    )
      throw Error("Resume metadata changed before reading");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      highWaterMark: 65536,
    })) {
      bytes += chunk.length;
      if (bytes > max)
        throw Error("Resume metadata exceeded limit while reading");
      chunks.push(chunk);
    }
    const end = await handle.stat();
    if (
      bytes !== initial.size ||
      end.size !== initial.size ||
      end.mtimeMs !== initial.mtimeMs
    )
      throw Error("Resume metadata changed while reading");
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}
export async function resumeCandidates(
  root: string,
  out: string,
): Promise<Result[]> {
  if (
    (await read(root, path.posix.join(out, ".agent-ledger"), 32)) !==
    "agent-ledger-v1\n"
  )
    throw Error("Not an AgentLedger report directory");
  const checkpointPath = path.posix.join(out, checkpointName);
  let present = true;
  try {
    await fs.lstat(await confined(root, checkpointPath, false));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    present = false;
  }
  if (!present) {
    const previous = parseManifest(
      await read(root, path.posix.join(out, "report.json"), limit),
      limit,
    );
    if (!object(previous) || previous.schema !== "agent-ledger-v1")
      throw Error("Invalid previous report");
    return results(previous.tasks).filter(success);
  }
  const previous = parseManifest(
    await read(root, checkpointPath, limit),
    limit,
  );
  if (!object(previous)) throw Error("Invalid checkpoint");
  keys(previous, [
    "schema",
    "runId",
    "name",
    "node",
    "startedAt",
    "updatedAt",
    "records",
  ]);
  if (
    previous.schema !== "agent-ledger-checkpoint-v1" ||
    !text(previous.runId, 64) ||
    !text(previous.name, 200) ||
    !text(previous.node, 64) ||
    !text(previous.startedAt, 64) ||
    !text(previous.updatedAt, 64) ||
    !Array.isArray(previous.records) ||
    previous.records.length > 64
  )
    throw Error("Invalid checkpoint");
  const seen = new Set<string>();
  const candidates: Result[] = [];
  for (const entry of previous.records) {
    if (!object(entry)) throw Error("Invalid checkpoint record");
    keys(entry, ["id", "state", "result"]);
    if (
      !id(entry.id) ||
      seen.has(entry.id) ||
      typeof entry.state !== "string" ||
      !["candidate", "in-flight", "settled"].includes(entry.state)
    )
      throw Error("Invalid or duplicate checkpoint record");
    seen.add(entry.id);
    if (entry.state === "in-flight") {
      if (entry.result !== undefined)
        throw Error("In-flight task cannot have a reusable result");
    } else {
      const parsed = result(entry.result);
      if (
        parsed.id !== entry.id ||
        (entry.state === "candidate" && !success(parsed))
      )
        throw Error("Invalid checkpoint candidate");
      if (success(parsed)) candidates.push(parsed);
    }
  }
  return candidates;
}

/** Serializes state mutation and publication, so snapshots cannot overtake each other. */
export class RecoveryCheckpoint {
  private value: Checkpoint;
  private target: string;
  private includeOutput: boolean;
  private queue: Promise<void> = Promise.resolve();
  constructor(
    output: string,
    workflow: Workflow,
    candidates: Result[],
    startedAt: string,
    includeOutput = false,
  ) {
    this.target = path.join(output, checkpointName);
    this.includeOutput = includeOutput;
    this.value = {
      schema: "agent-ledger-checkpoint-v1",
      runId: randomUUID(),
      name: workflow.name,
      node: process.version,
      startedAt,
      updatedAt: startedAt,
      records: workflow.tasks
        .filter((task) => task.command)
        .flatMap((task) => {
          const previous = candidates.find((entry) => entry.id === task.id);
          return previous
            ? [
                {
                  id: task.id,
                  state: "candidate" as const,
                  result: this.privateResult(previous),
                },
              ]
            : [];
        }),
    };
  }
  private privateResult(value: Result): Result {
    const copy = structuredClone(value);
    if (!this.includeOutput) {
      delete copy.output;
      delete copy.outputTruncated;
    }
    return copy;
  }
  private persist(change: () => void): Promise<void> {
    this.queue = this.queue.then(async () => {
      try {
        change();
        this.value.updatedAt = new Date().toISOString();
        const serialized = JSON.stringify(this.value, null, 2) + "\n";
        if (Buffer.byteLength(serialized) > limit)
          throw Error("Checkpoint exceeds 8 MiB");
        await atomic(this.target, serialized);
      } catch (error) {
        throw new CheckpointPersistenceError(
          "Cannot persist recovery checkpoint: " + (error as Error).message,
          { cause: error },
        );
      }
    });
    return this.queue;
  }
  initialize() {
    return this.persist(() => {});
  }
  inFlight(id: string) {
    return this.persist(() => this.replace({ id, state: "in-flight" }));
  }
  settled(result: Result) {
    return this.persist(() =>
      this.replace({
        id: result.id,
        state: "settled",
        result: this.privateResult(result),
      }),
    );
  }
  private replace(record: Record) {
    const index = this.value.records.findIndex(
      (entry) => entry.id === record.id,
    );
    if (index === -1) this.value.records.push(record);
    else this.value.records[index] = record;
  }
}
