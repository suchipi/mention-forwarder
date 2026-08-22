import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SECRET = "streaming-secret";

let port: number;
const replies: string[] = [];
let api: Server;
let forwarder: ReturnType<typeof spawn>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      const { port: found } = address;
      probe.close(() => resolve(found));
    });
  });
}

function startGitHubStub(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (path.endsWith("/comments") && request.method === "POST") {
        replies.push((JSON.parse(Buffer.concat(chunks).toString()) as { body: string }).body);
      }
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: 1, data: {} }));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mf-streaming-"));
  port = await freePort();
  const stub = await startGitHubStub();
  api = stub.server;

  // A long-lived agent stand-in: stays alive, and answers each mention in two
  // instalments so the watcher has to notice more than once.
  const agent = join(workspace, "agent.cjs");
  writeFileSync(
    agent,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  fs.appendFileSync(m.replyFile, "starting on " + m.prompt + "\\n");
  setTimeout(() => fs.appendFileSync(m.replyFile, "finished " + m.prompt + "\\n"), 600);
});
`,
  );
  chmodSync(agent, 0o755);

  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      command: ["node", agent],
      port,
      lifecycle: "per-conversation",
      replyDebounceMs: 100,
      logLevel: "info",
      github: { triggerPhrases: ["@my-bot"], apiUrl: stub.url },
    }),
  );
  writeFileSync(join(workspace, ".env"), `GITHUB_WEBHOOK_SECRET=${SECRET}\nGITHUB_TOKEN=ghp-stub-token\n`);

  forwarder = spawn(
    process.execPath,
    [CLI, "--config", join(workspace, "config.json"), "--env-file", join(workspace, ".env")],
    { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/`)).ok;
    } catch {
      return false;
    }
  }, "forwarder startup");
});

after(() => {
  forwarder?.kill("SIGKILL");
  api?.close();
});

test("a long-lived command's reply file is watched, posting each update separately", async () => {
  const body = JSON.stringify({
    action: "created",
    comment: {
      id: 700,
      body: "@my-bot the audit",
      html_url: "https://github.com/acme/widgets/issues/9#issuecomment-700",
      node_id: "IC_700",
      user: { login: "suchipi", type: "User" },
    },
    issue: { number: 9, title: "Audit" },
    repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
  });
  const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "issue_comment",
      "x-github-delivery": "stream-1",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(response.status, 200);

  await waitFor(() => replies.length >= 2, `two replies (got ${replies.length}: ${JSON.stringify(replies)})`);
  assert.deepEqual(
    replies.slice(0, 2),
    ["starting on the audit", "finished the audit"],
    "each reply carries only the newly written text, not the whole file",
  );
});
