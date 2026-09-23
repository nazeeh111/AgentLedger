# AgentLedger design

A versioned JSON DAG defines trusted local commands, explicit dependencies, input files, expected output artifacts and verification. Imported manifests are planned without running anything; execution and Codex tasks require separate explicit flags. This is a bounded coordinator, not a security sandbox: reviewed commands retain ordinary OS access.

Concurrency, retries, task timeouts, task count, input/artifact sizes and output capture are bounded. POSIX process groups are terminated on timeout/cancellation. Dependency failures propagate as skipped tasks. Declared artifacts are regular files confined to the selected root, never symlinks; output reports occupy a separate new managed directory. No unrelated files are removed.

Task fingerprints include its specification, declared input hashes, upstream task fingerprints/artifact hashes, and runtime identity. Resume only reuses earlier successful command tasks after artifacts still match. Review gates rerun; Codex opinions are not cached as proof. Undeclared inputs and external environment changes are outside resume guarantees.

An explicit review task names successful command checks and freshly rehashed artifacts, with an optional separately reported Codex opinion. Model approval never substitutes for command evidence. Reports are self-contained escaped HTML plus JSON; child output is omitted by default. Codex uses the installed CLI and existing sign-in, read-only native sandbox, default user model and no bypass flags. Development tests the adapter using a fake CLI; a real offline graph proves scheduler and artifact behavior without a model call.
