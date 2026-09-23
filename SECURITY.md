# Security model

AgentLedger coordinates **trusted local commands**. It is not a sandbox, privilege boundary, remote execution service, or a substitute for code review. Default plan mode does not execute a workflow. `--execute` authorizes reviewed command arguments; model tasks additionally require `--allow-codex`.

## Implemented controls

- Strict versioned schema, unknown-field rejection, duplicate JSON key rejection, DAG validation, bounded task count/concurrency/retries/timeouts and bounded manifest nesting/size.
- No implicit command shell. Argument-array contents are passed directly to the selected executable. A manifest can explicitly request a shell, and any executable can perform arbitrary actions under its OS permissions.
- POSIX process-group termination on timeout, cancellation and completion. A malicious process can intentionally escape its group; this tool does not prevent that. Windows execution is intentionally unsupported.
- Root-relative, non-symlink regular input/artifact files; 32 MiB limit and streamed hashing. Declared writers cannot collide and artifact consumers must depend on their producer. Trusted commands must respect declarations; undeclared writes cannot be inferred from arbitrary programs.
- Reports occupy a new managed directory; default reports omit captured child output. Files use mode0600 and the directory0700 on Unix. Report JSON/HTML are each replaced atomically, not as a multi-file transaction.
- HTML escapes all text and carries restrictive CSP. No report JavaScript, remote resources or analytics. Model opinions are a separate report field and cannot override failed automated dependencies.
- Codex uses native read-only sandbox flags and the existing user-selected model; no bypass, ignore-rules, credential inspection or global configuration change.

## Residual risks

Commands can access the filesystem, network and credentials allowed to the current account. A minimal inherited environment is not an OS security boundary. Native Codex policy governs model tool access. Never submit secrets intentionally in manifests/prompts/arguments/output; exact command arguments and artifact paths/hashes remain report content. `--include-output` may expose sensitive child output; a model's rationale can expose information it reads. Generated structured Codex response files remain in the managed run directory.

The workspace and filesystem are trusted against concurrent hostile mutation. Symlink checks and stable-file hashing do not constitute a race-proof filesystem sandbox. A compromised local account can change artifacts or falsify reports. Resume metadata is unsigned and trusts earlier local evidence, then rechecks declared artifacts. Unknown inputs, external services and non-Node executable/environment changes require an explicit fresh run.

Limits do not impose memory/CPU quotas on arbitrary commands. Large programs can exhaust resources before their timeout. Tasks must not launch detached daemons or intentionally evade process groups. A report surviving cancellation is best effort; abrupt termination/power loss can leave a partial run without a reusable report.

For security reports, use private vulnerability reporting when available. Do not attach credentials, private manifests, real secrets or raw sensitive model output to a public issue. This project claims no independent security audit or bug bounty.
