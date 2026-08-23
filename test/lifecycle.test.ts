import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SECRET = "lifecycle-secret";

type Record_ = { pid: number; key: string; prompt: string; argv: string[] };

const running: Array<ReturnType<typeof spawn>> = [];
after(() => {
  for (const child of running) child.kill("SIGKILL");
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Reads newline-delimited mentions and stays alive, as a long-lived command must. */
const SESSION_RECORDER = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const out = process.argv[process.argv.length - 1];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(out, JSON.stringify({ pid: process.pid, key: m.conversationKey, prompt: m.prompt, argv: process.argv.slice(2) }) + "\\n");
});
`;

/** Reads one whole mention until EOF, as a short-lived command does. */
const ONESHOT_RECORDER = `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
const out = process.argv[process.argv.length - 1];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const m = JSON.parse(Buffer.concat(chunks).toString());
  fs.appendFileSync(out, JSON.stringify({ pid: process.pid, key: m.conversationKey, prompt: m.prompt, argv: process.argv.slice(2) }) + "\\n");
});
`;

async function startForwarder(lifecycle: "per-mention" | "per-conversation", recorderSource: string) {
  const workspace = mkdtempSync(join(tmpdir(), `mf-${lifecycle}-`));
  const recorder = join(workspace, "recorder.cjs");
  const recordPath = join(workspace, "records.jsonl");
  writeFileSync(recorder, recorderSource);
  chmodSync(recorder, 0o755);
  const port = await freePort();

  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      command: ["node", recorder, "--first", "{{prompt}}", recordPath],
      port,
      lifecycle,
      logLevel: "info",
      github: { triggerPhrases: ["@my-bot"] },
    }),
  );
  writeFileSync(join(workspace, ".env"), `GITHUB_WEBHOOK_SECRET=${SECRET}\n`);

  const child = spawn(
    process.execPath,
    [CLI, "--config", join(workspace, "config.json"), "--env-file", join(workspace, ".env")],
    { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
  );
  running.push(child);
  await waitFor(async () => {
    try {
      // Any answer means the port is bound; the forwarder serves no route at /.
      await fetch(`http://127.0.0.1:${port}/`);
      return true;
    } catch {
      return false;
    }
  }, `${lifecycle} forwarder startup`);

  const records = (): Record_[] =>
    existsSync(recordPath)
      ? readFileSync(recordPath, "utf8")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => JSON.parse(line) as Record_)
      : [];

  async function mention(issue: number, text: string, delivery: string): Promise<void> {
    const body = JSON.stringify({
      action: "created",
      comment: {
        body: text,
        html_url: `https://github.com/acme/widgets/issues/${issue}#issuecomment-${delivery}`,
        node_id: `N${delivery}`,
        user: { login: "suchipi", type: "User" },
      },
      issue: { number: issue, title: "T" },
      repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
    });
    const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "issue_comment",
        "x-github-delivery": delivery,
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
      },
      body,
    });
    assert.equal(response.status, 200);
  }

  return { records, mention, waitForCount: (n: number) => waitFor(() => records().length === n, `${n} records`) };
}

test("per-conversation keeps one process per thread and streams mentions to its stdin", async () => {
  const forwarder = await startForwarder("per-conversation", SESSION_RECORDER);

  await forwarder.mention(1, "@my-bot first on one", "c1");
  await forwarder.waitForCount(1);
  await forwarder.mention(1, "@my-bot second on one", "c2");
  await forwarder.waitForCount(2);
  await forwarder.mention(2, "@my-bot only on two", "c3");
  await forwarder.waitForCount(3);

  const records = forwarder.records();
  const [first, second, third] = records as [Record_, Record_, Record_];

  assert.equal(first.prompt, "first on one");
  assert.equal(second.prompt, "second on one", "later mentions arrive on the same stdin, in order");
  assert.equal(third.prompt, "only on two");

  assert.equal(first.pid, second.pid, "both mentions on issue 1 reached one long-lived process");
  assert.notEqual(third.pid, first.pid, "a different conversation gets its own process");

  assert.deepEqual(first.argv.slice(0, 2), ["--first", "first on one"]);
  assert.deepEqual(
    second.argv.slice(0, 2),
    ["--first", "first on one"],
    "argv is fixed by whichever mention started the process",
  );
});

test("per-mention spawns a fresh process for every mention in the same thread", async () => {
  const forwarder = await startForwarder("per-mention", ONESHOT_RECORDER);

  await forwarder.mention(1, "@my-bot first", "m1");
  await forwarder.waitForCount(1);
  await forwarder.mention(1, "@my-bot second", "m2");
  await forwarder.waitForCount(2);

  const [first, second] = forwarder.records() as [Record_, Record_];
  assert.equal(first.prompt, "first");
  assert.equal(second.prompt, "second");
  assert.notEqual(first.pid, second.pid, "each mention gets its own process");
  assert.deepEqual(second.argv.slice(0, 2), ["--first", "second"], "argv reflects the mention that spawned it");
});
