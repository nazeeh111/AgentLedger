import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validate } from "../src/schema.ts";
import { parseManifest, hash, fileHash } from "../src/files.ts";
import {
  execute,
  processTask,
  codexCommand,
  parseOpinion,
} from "../src/runner.ts";
import { saveReport, html } from "../src/report.ts";
const roots: string[] = [];
async function root() {
  const r = await fs.mkdtemp(path.join(os.tmpdir(), "agent-ledger-test-"));
  roots.push(r);
  return r;
}
test.after(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});
const spec = (tasks: unknown[], concurrency = 2) =>
  validate({ version: 1, name: "test", concurrency, tasks });
const cmd = (id: string, js: string, more = {}) => ({
  id,
  command: [process.execPath, "-e", js],
  ...more,
});
test("schema rejects ambiguous graphs, paths, unknown fields and oversized budgets", () => {
  const cases = [
    { version: 2, name: "x", tasks: [] },
    { version: 1, name: "x", tasks: [cmd("x", ""), cmd("x", "")] },
    { version: 1, name: "x", tasks: [cmd("x", "", { deps: ["missing"] })] },
    {
      version: 1,
      name: "x",
      tasks: [cmd("x", "", { deps: ["y"] }), cmd("y", "", { deps: ["x"] })],
    },
    ...["../escape", "/absolute", "a/../b", "a\\b"].map((cwd) => ({
      version: 1,
      name: "x",
      tasks: [cmd("x", "", { cwd })],
    })),
    { version: 1, name: "x", tasks: [{ ...cmd("x", ""), typo: true }] },
    { version: 1, name: "x", tasks: [{ ...cmd("x", ""), timeoutMs: 300001 }] },
    { version: 1, name: "x", tasks: [{ ...cmd("x", ""), retries: 3 }] },
    {
      version: 1,
      name: "x",
      tasks: [{ ...cmd("x", ""), review: { checks: [], artifacts: [] } }],
    },
  ];
  for (const value of cases) assert.throws(() => validate(value));
  assert.throws(() =>
    spec(
      Array.from({ length: 64 }, (_, i) =>
        cmd("t" + i, "process.exit(0)", { timeoutMs: 300000, retries: 2 }),
      ),
    ),
  );
});
test("JSON duplicate keys, oversized input and nesting rejected", () => {
  assert.throws(() => parseManifest('{"version":1,"version":2}'));
  assert.throws(() => parseManifest('{"x":{"a":1,"\\u0061":2}}'));
  assert.throws(() => parseManifest(" ".repeat(1024 * 1024 + 1)));
  assert.throws(() => parseManifest("[".repeat(40) + "0" + "]".repeat(40)));
  assert.deepEqual(parseManifest('{"x":"a\\\"b","y":[true,null,2]}'), {
    x: 'a"b',
    y: [true, null, 2],
  });
});
test("bounded concurrency and dependencies execute for real", async () => {
  const r = await root();
  const action = (id: string) =>
    `const fs=require('node:fs');fs.appendFileSync('events',JSON.stringify({id:'${id}',event:'start',time:Date.now()})+'\\n');setTimeout(()=>fs.appendFileSync('events',JSON.stringify({id:'${id}',event:'end',time:Date.now()})+'\\n'),80)`;
  const report = await execute(
    spec(
      [
        cmd("a", action("a")),
        cmd("b", action("b")),
        cmd("c", action("c")),
        cmd("d", action("d"), { deps: ["a", "b", "c"] }),
      ],
      2,
    ),
    { root: r, out: "report" },
  );
  assert.equal(report.status, "passed");
  const events = (await fs.readFile(path.join(r, "events"), "utf8"))
    .trim()
    .split("\n")
    .map((x) => JSON.parse(x));
  let active = 0,
    max = 0;
  for (const e of events) {
    active += e.event === "start" ? 1 : -1;
    max = Math.max(max, active);
  }
  assert.equal(max, 2);
  assert.equal(events.at(-2).id, "d");
});
test("failure propagates downstream while independent work completes", async () => {
  const r = await root();
  const report = await execute(
    spec([
      cmd("bad", "process.exit(7)"),
      cmd("child", 'throw Error("must not run")', { deps: ["bad"] }),
      cmd("good", "process.exit(0)"),
    ]),
    { root: r, out: "report" },
  );
  assert.deepEqual(
    report.tasks.map((t) => t.status),
    ["failed", "skipped", "success"],
  );
  assert.equal(report.tasks[0]!.exitCode, 7);
});
test("expected exit criterion is explicit and retries strictly capped", async () => {
  const r = await root();
  const action = `const fs=require('node:fs');let n=fs.existsSync('count')?Number(fs.readFileSync('count')):0;fs.writeFileSync('count',String(++n));process.exit(n<3?1:0)`;
  const report = await execute(
    spec([
      cmd("retry", action, { retries: 2 }),
      cmd("expected", "process.exit(4)", { expectedExit: 4 }),
    ]),
    { root: r, out: "report" },
  );
  assert.equal(report.status, "passed");
  assert.equal(report.tasks[0]!.attempts, 3);
});
test("timeout kills process group and skips dependent work", async () => {
  const r = await root();
  const action = `const{spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync('pid',String(c.pid));setInterval(()=>{},1000)`;
  const report = await execute(
    spec([
      cmd("slow", action, { timeoutMs: 250 }),
      cmd("after", "process.exit(0)", { deps: ["slow"] }),
    ]),
    { root: r, out: "report" },
  );
  assert.equal(report.tasks[0]!.status, "timeout");
  assert.equal(report.tasks[1]!.status, "skipped");
  const pid = Number(await fs.readFile(path.join(r, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0));
});
test("abort cancels active and pending work", async () => {
  const r = await root();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const report = await execute(
      spec(
        [
          cmd("a", "setInterval(()=>{},1000)"),
          cmd("b", "process.exit(0)", { deps: ["a"] }),
        ],
        1,
      ),
      { root: r, out: "report", signal: controller.signal },
    );
    assert.equal(report.status, "cancelled");
    assert.ok(report.tasks.every((t) => t.status === "cancelled"));
  } finally {
    clearTimeout(timer);
  }
});
test("arguments preserve shell metacharacters literally", async () => {
  const r = await root();
  const literal = "$(touch injected); & <not-a-shell>";
  const report = await execute(
    spec([
      {
        id: "arg",
        command: [
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync('arg.txt',process.argv[1])`,
          literal,
        ],
        artifacts: [{ path: "arg.txt", sha256: hash(literal) }],
      },
    ]),
    { root: r, out: "report" },
  );
  assert.equal(report.status, "passed");
  assert.equal(await fs.readFile(path.join(r, "arg.txt"), "utf8"), literal);
  await assert.rejects(fs.stat(path.join(r, "injected")));
});
test("artifact missing, hash mismatch, symlink and oversized files fail safely", async () => {
  const r = await root();
  await fs.writeFile(path.join(r, "existing"), "data");
  await fs.symlink("existing", path.join(r, "linked"));
  const large = await fs.open(path.join(r, "large"), "w");
  await large.truncate(32 * 1024 * 1024 + 1);
  await large.close();
  for (const [i, artifact] of [
    { path: "missing" },
    { path: "existing", sha256: "0".repeat(64) },
    { path: "linked" },
    { path: "large" },
  ].entries()) {
    const report = await execute(
      spec([cmd("x", "process.exit(0)", { artifacts: [artifact] })]),
      { root: r, out: "r" + i },
    );
    assert.equal(report.status, "failed");
  }
  await assert.rejects(fileHash(r, "linked"));
});
test("report directory is new, confined and separate from declared data", async () => {
  const r = await root();
  await fs.mkdir(path.join(r, "existing"));
  await assert.rejects(
    execute(spec([cmd("x", "process.exit(0)")]), { root: r, out: "existing" }),
  );
  await assert.rejects(
    execute(spec([cmd("x", "process.exit(0)")]), {
      root: r,
      out: "../outside",
    }),
  );
  await assert.rejects(
    execute(
      spec([
        cmd("x", "process.exit(0)", { artifacts: [{ path: "report/data" }] }),
      ]),
      { root: r, out: "report" },
    ),
  );
});
test("resume reuses exact input/artifact evidence and invalidates changes downstream", async () => {
  const r = await root();
  await fs.writeFile(path.join(r, "input"), "one");
  const workflow = spec([
    cmd(
      "build",
      `const fs=require('node:fs');fs.writeFileSync('artifact',fs.readFileSync('input'))`,
      { inputs: ["input"], artifacts: [{ path: "artifact" }] },
    ),
    cmd("check", "process.exit(0)", { deps: ["build"], inputs: ["artifact"] }),
  ]);
  let result = await execute(workflow, { root: r, out: "report" });
  await saveReport(result, path.join(r, "report"));
  result = await execute(workflow, { root: r, out: "report", resume: true });
  assert.ok(result.tasks.every((t) => t.status === "cached"));
  await fs.writeFile(path.join(r, "input"), "two");
  result = await execute(workflow, { root: r, out: "report", resume: true });
  assert.ok(result.tasks.every((t) => t.status === "success"));
  assert.equal(await fs.readFile(path.join(r, "artifact"), "utf8"), "two");
  await saveReport(result, path.join(r, "report"));
  await fs.writeFile(path.join(r, "artifact"), "tampered");
  result = await execute(workflow, { root: r, out: "report", resume: true });
  assert.equal(result.tasks[0]!.status, "success");
  assert.equal(await fs.readFile(path.join(r, "artifact"), "utf8"), "two");
});
test("review requires automated checks and freshly verified artifact evidence", async () => {
  const r = await root();
  const workflow = spec([
    cmd("build", `require('node:fs').writeFileSync('artifact','correct')`, {
      artifacts: [{ path: "artifact" }],
    }),
    cmd(
      "check",
      `require('node:assert').equal(require('node:fs').readFileSync('artifact','utf8'),'correct')`,
      { deps: ["build"], inputs: ["artifact"] },
    ),
    {
      id: "review",
      deps: ["build", "check"],
      review: {
        checks: ["check"],
        artifacts: [{ task: "build", path: "artifact" }],
      },
    },
  ]);
  const report = await execute(workflow, { root: r, out: "report" });
  assert.equal(report.status, "passed");
  assert.deepEqual(report.tasks[2]!.automatedProof?.checks, ["check"]);
  assert.equal(
    report.tasks[2]!.automatedProof?.artifacts[0]?.sha256,
    hash("correct"),
  );
});
test("review detects artifact tampering after producing task", async () => {
  const r = await root();
  const workflow = spec([
    cmd("build", `require('node:fs').writeFileSync('artifact','a')`, {
      artifacts: [{ path: "artifact" }],
    }),
    cmd("mutate", `require('node:fs').writeFileSync('artifact','b')`, {
      deps: ["build"],
    }),
    {
      id: "review",
      deps: ["build", "mutate"],
      review: {
        checks: ["mutate"],
        artifacts: [{ task: "build", path: "artifact" }],
      },
    },
  ]);
  const report = await execute(workflow, { root: r, out: "report" });
  assert.equal(report.tasks[2]!.status, "failed");
});
test("stdout is omitted by default, bounded when explicitly included", async () => {
  const r = await root();
  await fs.writeFile(
    path.join(r, "print.mjs"),
    `console.log('PRIVATE_SAMPLE');console.log('x'.repeat(100000));`,
  );
  const workflow = spec([
    {
      id: "print",
      command: [process.execPath, "print.mjs"],
      inputs: ["print.mjs"],
    },
  ]);
  const a = await execute(workflow, { root: r, out: "a" });
  assert.equal(a.tasks[0]!.output, undefined);
  assert.ok(!JSON.stringify(a).includes("PRIVATE_SAMPLE"));
  const b = await execute(workflow, { root: r, out: "b", includeOutput: true });
  assert.equal(b.tasks[0]!.outputTruncated, true);
  assert.ok(Buffer.byteLength(b.tasks[0]!.output!) <= 65536);
});
test("HTML report escapes names, arguments and opinions without remote resources", async () => {
  const r = await root();
  const report = await execute(spec([cmd("ok", "process.exit(0)")]), {
    root: r,
    out: "report",
  });
  report.name = "<script>alert(1)</script>";
  report.tasks[0]!.modelOpinion = {
    verdict: "approve",
    rationale: "<img src=x onerror=alert(1)>",
  };
  const document = html(report);
  assert.ok(document.includes("&lt;script&gt;"));
  assert.ok(!document.includes("<script>"));
  assert.ok(!document.includes("<img"));
  assert.ok(document.includes("Model review"));
  assert.ok(document.includes("Model reviews do not change command outcomes."));
});
test("Codex requires separate opt-in; fake CLI respects native flags and structured opinion", async () => {
  const r = await root();
  const fake = path.join(r, "fake-codex");
  await fs.writeFile(
    fake,
    `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[a.indexOf('-s')+1]!=='read-only'||a.includes('--model')||a.some(x=>x.includes('bypass')))process.exit(9);let prompt='';process.stdin.on('data',c=>prompt+=c);process.stdin.on('end',()=>{if(!prompt)process.exit(8);fs.writeFileSync(a[a.indexOf('--output-last-message')+1],JSON.stringify({verdict:'approve',rationale:'Fake CLI opinion; not proof.'}));console.log('{}');});`,
    { mode: 0o700 },
  );
  const workflow = spec([
    { id: "opinion", codex: { prompt: "Inspect synthetic fixture only." } },
  ]);
  await assert.rejects(
    execute(workflow, { root: r, out: "denied" }),
    /allow-codex/,
  );
  const report = await execute(workflow, {
    root: r,
    out: "report",
    allowCodex: true,
    codexExecutable: fake,
  });
  assert.equal(report.status, "passed");
  assert.equal(report.tasks[0]!.modelOpinion?.verdict, "approve");
  assert.equal(report.tasks[0]!.automatedProof, undefined);
  await saveReport(report, path.join(r, "report"));
  const resumed = await execute(workflow, {
    root: r,
    out: "report",
    resume: true,
    allowCodex: true,
    codexExecutable: fake,
  });
  assert.equal(resumed.tasks[0]!.status, "success");
  assert.equal(resumed.tasks[0]!.attempts, 1);
  assert.notDeepEqual(resumed.tasks[0]!.command, report.tasks[0]!.command);
  assert.throws(() => parseOpinion('{"verdict":"approve","rationale":1}'));
  assert.deepEqual(codexCommand("codex", "root", "schema", "out"), [
    "codex",
    "exec",
    "--json",
    "--output-schema",
    "schema",
    "-s",
    "read-only",
    "-C",
    "root",
    "--output-last-message",
    "out",
    "-",
  ]);
});
test("default CLI plan runs no task", async () => {
  const r = await root();
  const manifest = path.join(r, "graph.json");
  await fs.writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      name: "dry",
      tasks: [
        cmd("write", `require('node:fs').writeFileSync('bad','executed')`),
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    [path.resolve("src/cli.ts"), manifest, "--root", r],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plan-only/);
  await assert.rejects(fs.stat(path.join(r, "bad")));
  await assert.rejects(fs.stat(path.join(r, "ledger-report")));
});
test("spawn failure returns failed, never hangs", async () => {
  const result = await processTask(["/no/such/executable"], await root(), 1000);
  assert.equal(result.status, "failed");
});

test("empty argument remains an empty argument", async () => {
  const r = await root();
  const workflow = spec([
    {
      id: "arg",
      command: [
        process.execPath,
        "-e",
        `require('node:assert/strict').equal(process.argv[1],'')`,
        "",
      ],
    },
  ]);
  assert.equal(
    (await execute(workflow, { root: r, out: "report" })).status,
    "passed",
  );
});
test("resume rejects symlinked metadata before reading it", async () => {
  const r = await root();
  await fs.mkdir(path.join(r, "report"));
  await fs.writeFile(path.join(r, "other"), "agent-ledger-v1\n");
  await fs.symlink("../other", path.join(r, "report", ".agent-ledger"));
  await assert.rejects(
    execute(spec([cmd("x", "process.exit(0)")]), {
      root: r,
      out: "report",
      resume: true,
    }),
    /Symlink/,
  );
});
test("wide DAG ancestry validation is bounded", () => {
  const tasks = Array.from({ length: 60 }, (_, i) =>
    cmd("t" + i, "process.exit(0)", {
      deps: Array.from({ length: i }, (_, j) => "t" + j),
      timeoutMs: 50,
    }),
  );
  const start = performance.now();
  assert.equal(spec(tasks).tasks.length, 60);
  assert.ok(performance.now() - start < 1000);
});
test("model approval cannot turn a failed command into automated success", async () => {
  const r = await root();
  const workflow = spec([
    cmd("build", `require('node:fs').writeFileSync('artifact','x')`, {
      artifacts: [{ path: "artifact" }],
    }),
    cmd("check", "process.exit(9)", { deps: ["build"] }),
    {
      id: "review",
      deps: ["build", "check"],
      review: {
        checks: ["check"],
        artifacts: [{ task: "build", path: "artifact" }],
      },
    },
  ]);
  const report = await execute(workflow, { root: r, out: "report" });
  assert.equal(report.status, "failed");
  assert.equal(report.tasks[2]!.status, "skipped");
  assert.equal(report.tasks[2]!.automatedProof, undefined);
});

test("resume does not carry old captured output into a default-redacted report", async () => {
  const r = await root();
  await fs.writeFile(
    path.join(r, "print.mjs"),
    `console.log('PRIOR_PRIVATE_OUTPUT')`,
  );
  const workflow = spec([
    {
      id: "print",
      command: [process.execPath, "print.mjs"],
      inputs: ["print.mjs"],
    },
  ]);
  const first = await execute(workflow, {
    root: r,
    out: "report",
    includeOutput: true,
  });
  await saveReport(first, path.join(r, "report"));
  const resumed = await execute(workflow, {
    root: r,
    out: "report",
    resume: true,
  });
  assert.equal(resumed.tasks[0]!.status, "cached");
  assert.equal(resumed.tasks[0]!.output, undefined);
  assert.ok(!JSON.stringify(resumed).includes("PRIOR_PRIVATE_OUTPUT"));
});

test("resume rejects oversized metadata before loading it", async () => {
  const r = await root();
  await fs.mkdir(path.join(r, "report"));
  await fs.writeFile(
    path.join(r, "report", ".agent-ledger"),
    "agent-ledger-v1\n",
  );
  const f = await fs.open(path.join(r, "report", "report.json"), "w");
  await f.truncate(8 * 1024 * 1024 + 1);
  await f.close();
  await assert.rejects(
    execute(spec([cmd("x", "process.exit(0)")]), {
      root: r,
      out: "report",
      resume: true,
    }),
    /oversized/,
  );
});

test("FIFO artifacts are rejected without opening a blocking stream", async () => {
  const r = await root();
  const made = spawnSync("mkfifo", [path.join(r, "pipe")]);
  assert.equal(made.status, 0);
  const started = performance.now();
  await assert.rejects(fileHash(r, "pipe"), /regular files/);
  assert.ok(performance.now() - started < 1000);
});

test("invalid working directories fail preflight before any command starts", async () => {
  const r = await root();
  await fs.writeFile(path.join(r, "not-directory"), "x");
  await assert.rejects(
    execute(
      spec([
        cmd("first", `require('node:fs').writeFileSync('started','yes')`),
        cmd("bad", "process.exit(0)", { cwd: "not-directory" }),
      ]),
      { root: r, out: "report" },
    ),
    /cwd/,
  );
  await assert.rejects(fs.stat(path.join(r, "started")));
});

test("input mutation fails without retry and cannot become a cached success", async () => {
  for (const exit of [0, 1]) {
    const r = await root();
    await fs.writeFile(path.join(r, "input"), "original");
    const workflow = spec([
      cmd(
        "mutate",
        `const fs=require('node:fs'); if(!fs.existsSync('once')) {fs.writeFileSync('once','yes');fs.writeFileSync('input','edited');}fs.copyFileSync('input','artifact');process.exit(${exit});`,
        { inputs: ["input"], artifacts: [{ path: "artifact" }], retries: 2 },
      ),
    ]);
    const first = await execute(workflow, { root: r, out: "report" });
    assert.equal(first.tasks[0]!.status, "failed");
    assert.equal(first.tasks[0]!.attempts, 1);
    assert.match(first.tasks[0]!.reason!, /[Ii]nput.*changed/);
    await saveReport(first, path.join(r, "report"));
    await fs.writeFile(path.join(r, "input"), "original");
    const resumed = await execute(workflow, {
      root: r,
      out: "report",
      resume: true,
    });
    assert.notEqual(resumed.tasks[0]!.status, "cached");
    assert.equal(
      await fs.readFile(path.join(r, "artifact"), "utf8"),
      "original",
    );
  }
});
test("resume invalidates a copied workspace with a different execution root", async () => {
  const a = await root(),
    b = await root();
  const workflow = spec([
    cmd(
      "location",
      `require('node:fs').writeFileSync('artifact',process.cwd())`,
      { artifacts: [{ path: "artifact" }] },
    ),
  ]);
  const first = await execute(workflow, { root: a, out: "report" });
  await saveReport(first, path.join(a, "report"));
  await fs.cp(a, b, { recursive: true });
  const resumed = await execute(workflow, {
    root: b,
    out: "report",
    resume: true,
  });
  assert.equal(resumed.tasks[0]!.status, "success");
  assert.equal(
    await fs.readFile(path.join(b, "artifact"), "utf8"),
    await fs.realpath(b),
  );
});
