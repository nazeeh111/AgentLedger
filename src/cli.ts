#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { parseManifest, confined } from "./files.ts";
import { validate } from "./schema.ts";
import { execute } from "./runner.ts";
import { saveReport } from "./report.ts";
export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        execute: { type: "boolean" },
        "allow-codex": { type: "boolean" },
        resume: { type: "boolean" },
        "include-output": { type: "boolean" },
        root: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: node src/cli.ts WORKFLOW.json [--root DIR] [--out report-dir] [--execute] [--resume] [--allow-codex] [--include-output]\nDefault: validate and show plan only. Execution runs reviewed, trusted commands with your OS permissions.",
      );
      return 0;
    }
    if (positionals.length !== 1)
      throw Error("Provide exactly one workflow JSON path; use --help");
    const manifest = path.resolve(positionals[0]!);
    const st = await fs.lstat(manifest);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024)
      throw Error("Manifest must be a regular file no larger than 1 MiB");
    const workflow = validate(
      parseManifest(await fs.readFile(manifest, "utf8")),
    );
    const root = await fs.realpath(values.root ?? process.cwd());
    const out = values.out ?? "ledger-report";
    await confined(root, out, false);
    for (const t of workflow.tasks) {
      const cwdPath = await confined(root, t.cwd);
      if (!(await fs.stat(cwdPath)).isDirectory())
        throw Error("Task cwd must be a directory");
      for (const p of [...t.inputs, ...t.artifacts.map((a) => a.path)])
        await confined(root, p, false);
    }
    if (!values.execute) {
      console.log(
        JSON.stringify(
          {
            mode: "plan-only",
            name: workflow.name,
            root,
            output: out,
            concurrency: workflow.concurrency,
            tasks: workflow.tasks.map((t) => ({
              id: t.id,
              dependsOn: t.deps,
              cwd: t.cwd,
              kind: t.command
                ? "command"
                : t.codex
                  ? "codex-opinion"
                  : "review",
              command: t.command,
              timeoutMs: t.timeoutMs,
              retries: t.retries,
              inputs: t.inputs,
              artifacts: t.artifacts,
              review: t.review,
              codex: t.codex,
            })),
            notice:
              "No commands executed. Inspect commands before rerunning with --execute. Codex additionally requires --allow-codex.",
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const report = await execute(workflow, {
        root,
        out,
        allowCodex: values["allow-codex"],
        resume: values.resume,
        includeOutput: values["include-output"],
        signal: controller.signal,
      });
      await saveReport(report, path.resolve(root, out));
      console.log(
        `AgentLedger: ${report.status}; ${report.tasks.length} tasks. Open ${path.join(out, "index.html")}`,
      );
      return report.status === "passed"
        ? 0
        : report.status === "cancelled"
          ? 130
          : 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch (e) {
    console.error(`AgentLedger: ${(e as Error).message}`);
    return 2;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = await main();
