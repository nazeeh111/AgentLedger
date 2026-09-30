# AgentLedger design

A versioned JSON DAG defines trusted local commands, explicit dependencies, input files, expected output artifacts and verification. Imported manifests are planned without running anything; execution and Codex tasks require separate explicit flags. This is a bounded coordinator, not a security sandbox: reviewed commands retain ordinary OS access.

Concurrency, retries, task timeouts, task count, input/artifact sizes and output capture are bounded. POSIX process groups are terminated on timeout/cancellation. Dependency failures propagate as skipped tasks. Declared artifacts are regular files confined to the selected root, never symlinks; output reports occupy a separate new managed directory. No unrelated files are removed.

Task fingerprints include its specification, declared input hashes, upstream task fingerprints/artifact hashes, and runtime identity. Resume only reuses earlier successful command tasks after artifacts still match. Review gates rerun; Codex opinions are not cached as proof. Undeclared inputs and external environment changes are outside resume guarantees.

An explicit review task names successful command checks and freshly rehashed artifacts, with an optional separately reported Codex opinion. Model approval never substitutes for command evidence. Reports are self-contained escaped HTML plus JSON; child output is omitted by default. Codex uses the installed CLI and existing sign-in, read-only native sandbox, default user model and no bypass flags. Automated tests use a fake CLI; the offline graph verifies scheduler and artifact behavior without a model call. A separate five-task live Codex integration check passed on September 23, 2026 using the same native read-only adapter.

## Recovery checkpoints

The internal `agent-ledger-checkpoint-v1` document is separate from the public `agent-ledger-v1` report. It has a fresh run ID, runtime/timestamps and at most one record per task. A `candidate` holds a prior successful command result pending the existing fingerprint and artifact checks; `in-flight` has no reusable result; `settled` holds a terminal result from the current run. Reviews and Codex opinions always rerun. Candidates from removed tasks are omitted.

A single promise queue performs state mutation, snapshot construction and atomic replacement together. Initialization is awaited before scheduling, in-flight invalidation before every command attempt, and settled publication before exposing the result to dependent tasks. A failed write makes the queue fail closed: the scheduler stops, aborts current owned process groups, waits for their settlement and propagates an execution error. The checkpoint helper is included in the implementation fingerprint.

Resume validates the managed marker, confined nonsymlink regular files, bounded reads, duplicate JSON keys, schema and unique task records. The checkpoint is authoritative whenever present; only its absence permits legacy report fallback. In-flight or failed records cannot fall back to older successes. Output capture is removed from candidates and settled records by default; explicitly included output keeps the existing bound. Structured opinions retain the same privacy limits as final reports.

Atomic replacement is not a power-loss guarantee or exactly-once execution. Side effects before publication can be repeated. A hard-killed coordinator may leave old children running; callers must settle them before recovery. Concurrent coordinators sharing one output directory are unsupported. Final reports describe the last completed run, while the checkpoint may describe a newer partial run. The Pages workflow publishes only final HTML and JSON, excluding internal recovery metadata.
