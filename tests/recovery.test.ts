import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { validate } from "../src/schema.ts";
import { execute } from "../src/runner.ts";
import { saveReport } from "../src/report.ts";

const checkpoint = ".agent-ledger-checkpoint.json";
const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ledger-recovery-"));
  roots.push(root);
  return root;
}
test.after(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});
const command = (id: string, code: string, extra = {}) => ({
  id,
  command: [process.execPath, "-e", code],
  ...extra,
});
const workflow = (tasks: unknown[], concurrency = 2) =>
  validate({
    version: 1,
    name: "recovery",
    concurrency,
    tasks,
  });
async function waitFor(file: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {
      /* Owned fixture not ready. */
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw Error("Fixture did not become ready: " + file);
}
const producer = command(
  "producer",
  `const fs=require('node:fs');fs.copyFileSync('input','artifact');fs.appendFileSync('count','x');`,
  {
    inputs: ["input"],
    artifacts: [{ path: "artifact" }],
  },
);
const slow = command(
  "slow",
  `const fs=require('node:fs');fs.writeFileSync('ready',String(process.pid));setTimeout(()=>fs.writeFileSync('child-finished','yes'),1500);`,
  { deps: ["producer"] },
);
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
async function interrupt(root: string, resume = false) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "flow.json",
      "--execute",
      "--out",
      "report",
      ...(resume ? ["--resume"] : []),
    ],
    { cwd: root, stdio: "pipe" },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<void>((resolve) =>
    child.on("close", () => resolve()),
  );
  try {
    await waitFor(path.join(root, "ready"));
    assert.equal(
      await fs.readFile(path.join(root, "artifact"), "utf8"),
      await fs.readFile(path.join(root, "input"), "utf8"),
    );
    child.kill("SIGKILL");
    await closed;
    // The detached command owns a bounded timer; never assume parent death stops it.
    await waitFor(path.join(root, "child-finished"));
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
  assert.equal(stderr, "");
}
test("completed tasks resume before a final report exists", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "input"), "a");
  const spec = workflow([producer]);
  await execute(spec, { root, out: "report" });
  const recovered = await execute(spec, { root, out: "report", resume: true });
  assert.equal(recovered.tasks[0]!.status, "cached");
  assert.equal(await fs.readFile(path.join(root, "count"), "utf8"), "x");
});
test("SIGKILL recovery reuses a completed producer in fresh and resumed runs", async () => {
  for (const resumed of [false, true]) {
    const root = await fixture();
    await fs.writeFile(path.join(root, "input"), "a");
    const spec = workflow([producer, slow]);
    await fs.writeFile(
      path.join(root, "flow.json"),
      JSON.stringify({ version: 1, name: "recovery", tasks: [producer, slow] }),
    );
    if (resumed) {
      await saveReport(
        await execute(spec, { root, out: "report" }),
        path.join(root, "report"),
      );
      await fs.rm(path.join(root, "ready"));
      await fs.rm(path.join(root, "child-finished"));
      await fs.writeFile(path.join(root, "input"), "b");
    }
    await interrupt(root, resumed);
    const before = await fs.readFile(path.join(root, "count"), "utf8");
    const report = await execute(spec, { root, out: "report", resume: true });
    assert.equal(report.tasks[0]!.status, "cached");
    assert.equal(report.tasks[1]!.status, "success");
    assert.equal(await fs.readFile(path.join(root, "count"), "utf8"), before);
  }
});
test("an unfinished rerun cannot revive an older success after restoring identical bytes", async () => {
  const root = await fixture();
  await fs.writeFile(path.join(root, "input"), "original");
  const rewrite = command(
    "producer",
    `const fs=require('node:fs');fs.copyFileSync('input','artifact');fs.appendFileSync('count','x');fs.writeFileSync('ready',String(process.pid));setTimeout(()=>fs.writeFileSync('child-finished','yes'),1500);`,
    {
      inputs: ["input"],
      artifacts: [{ path: "artifact" }],
    },
  );
  const spec = workflow([rewrite]);
  await fs.writeFile(
    path.join(root, "flow.json"),
    JSON.stringify({ version: 1, name: "recovery", tasks: [rewrite] }),
  );
  await saveReport(
    await execute(spec, { root, out: "report" }),
    path.join(root, "report"),
  );
  const previousReport = await fs.readFile(
    path.join(root, "report/report.json"),
  );
  await fs.rm(path.join(root, "ready"));
  await fs.rm(path.join(root, "child-finished"));
  await fs.writeFile(path.join(root, "artifact"), "tampered");
  await interrupt(root, true);
  assert.deepEqual(
    await fs.readFile(path.join(root, "report/report.json")),
    previousReport,
  );
  const partial = JSON.parse(
    await fs.readFile(path.join(root, "report", checkpoint), "utf8"),
  );
  assert.deepEqual(partial.records, [{ id: "producer", state: "in-flight" }]);
  const report = await execute(spec, { root, out: "report", resume: true });
  assert.equal(report.tasks[0]!.status, "success");
  assert.equal(await fs.readFile(path.join(root, "count"), "utf8"), "xxx");
});
test("concurrent completions retain all settled records before dependent launch", async () => {
  const root = await fixture();
  const commands = Array.from({ length: 8 }, (_, i) =>
    command("Task_" + i, `setTimeout(()=>{},${(7 - i) * 5})`),
  );
  const dependent = command(
    "dependent",
    `const fs=require('node:fs');const cp=JSON.parse(fs.readFileSync('report/${checkpoint}'));if(cp.records.filter(x=>x.state==='settled').length!==8)process.exit(7);`,
    { deps: commands.map((entry) => entry.id) },
  );
  const report = await execute(workflow([...commands, dependent], 8), {
    root,
    out: "report",
  });
  assert.equal(report.status, "passed");
  const persisted = JSON.parse(
    await fs.readFile(path.join(root, "report", checkpoint), "utf8"),
  );
  assert.equal(persisted.records.length, 9);
  assert.ok(
    persisted.records.every(
      (record: { state: string }) => record.state === "settled",
    ),
  );
});
test("checkpoint persistence failure aborts owned children and preserves the final report", async () => {
  const root = await fixture();
  const starter = workflow([command("old", "")]);
  await saveReport(
    await execute(starter, { root, out: "report" }),
    path.join(root, "report"),
  );
  const original = await fs.readFile(path.join(root, "report/report.json"));
  const sibling = command(
    "sibling",
    `const fs=require('node:fs');fs.writeFileSync('sibling-ready',String(process.pid));process.on('SIGTERM',()=>{fs.writeFileSync('stopped','yes');process.exit(0)});setTimeout(()=>process.exit(0),2000);`,
  );
  const sabotage = command(
    "sabotage",
    `const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync('sibling-ready')){clearInterval(timer);fs.unlinkSync('report/${checkpoint}');fs.mkdirSync('report/${checkpoint}');}},10);setTimeout(()=>process.exit(0),2000).unref();`,
  );
  await assert.rejects(
    execute(workflow([sibling, sabotage]), {
      root,
      out: "report",
      resume: true,
    }),
    /Cannot persist recovery checkpoint/,
  );
  assert.equal(await fs.readFile(path.join(root, "stopped"), "utf8"), "yes");
  assert.deepEqual(
    await fs.readFile(path.join(root, "report/report.json")),
    original,
  );
});
test("default checkpoint privacy strips previous output; legacy reports remain usable", async () => {
  const root = await fixture();
  const spec = workflow([
    command("task", "console.log('private-captured-text')"),
  ]);
  const first = await execute(spec, {
    root,
    out: "report",
    includeOutput: true,
  });
  await saveReport(first, path.join(root, "report"));
  assert.match(
    await fs.readFile(path.join(root, "report", checkpoint), "utf8"),
    /private-captured-text/,
  );
  await fs.rm(path.join(root, "report", checkpoint));
  const legacy = await execute(spec, { root, out: "report", resume: true });
  assert.equal(legacy.tasks[0]!.status, "cached");
  assert.equal(legacy.tasks[0]!.output, undefined);
  const persisted = JSON.parse(
    await fs.readFile(path.join(root, "report", checkpoint), "utf8"),
  );
  assert.equal(persisted.records[0].result.output, undefined);
  assert.equal(persisted.records[0].result.outputTruncated, undefined);
});
test("invalid authoritative checkpoints never fall back to a successful report", async () => {
  const corruptions = [
    "{",
    '{"schema":"agent-ledger-checkpoint-v1","records":[]}',
    " ".repeat(8 * 1024 * 1024 + 1),
  ];
  for (const corruption of corruptions) {
    const root = await fixture();
    const spec = workflow([
      command("task", "require('node:fs').appendFileSync('count','x')"),
    ]);
    await saveReport(
      await execute(spec, { root, out: "report" }),
      path.join(root, "report"),
    );
    await fs.writeFile(path.join(root, "report", checkpoint), corruption);
    await assert.rejects(execute(spec, { root, out: "report", resume: true }));
    assert.equal(await fs.readFile(path.join(root, "count"), "utf8"), "x");
  }
  const root = await fixture();
  const spec = workflow([command("task", "")]);
  await saveReport(
    await execute(spec, { root, out: "report" }),
    path.join(root, "report"),
  );
  const cp = path.join(root, "report", checkpoint);
  const valid = await fs.readFile(cp, "utf8");
  for (const field of ["state", "status", "verdict"]) {
    const malformed = JSON.parse(valid);
    if (field === "state") malformed.records[0].state = ["in-flight"];
    if (field === "status") malformed.records[0].result.status = ["success"];
    if (field === "verdict")
      malformed.records[0].result.modelOpinion = {
        verdict: ["approve"],
        rationale: "invalid enum",
      };
    await fs.writeFile(cp, JSON.stringify(malformed));
    await assert.rejects(
      execute(spec, { root, out: "report", resume: true }),
      /Invalid/,
    );
  }
  const parsed = JSON.parse(valid);
  parsed.records.push(parsed.records[0]);
  await fs.writeFile(cp, JSON.stringify(parsed));
  await assert.rejects(
    execute(spec, { root, out: "report", resume: true }),
    /duplicate/i,
  );
  await fs.writeFile(
    cp,
    valid.replace(
      '"state": "settled"',
      '"state": "in-flight", "state": "settled"',
    ),
  );
  await assert.rejects(
    execute(spec, { root, out: "report", resume: true }),
    /Duplicate JSON key/,
  );
  await fs.rm(cp);
  await fs.symlink("report.json", cp);
  await assert.rejects(
    execute(spec, { root, out: "report", resume: true }),
    /Symlink/,
  );
  await fs.rm(cp);
  await fs.mkdir(cp);
  await assert.rejects(
    execute(spec, { root, out: "report", resume: true }),
    /Invalid/,
  );
});
