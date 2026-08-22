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
const SECRET = "reply-routing-secret";

type Call = { method: string; path: string; body: unknown };

let port: number;
let apiCalls: Call[] = [];
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

/** Stands in for api.github.com so reply routing can be asserted exactly. */
function startGitHubStub(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      apiCalls.push({
        method: request.method ?? "",
        path: (request.url ?? "").split("?")[0] ?? "",
        body: raw === "" ? undefined : JSON.parse(raw),
      });
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

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mf-reply-routing-"));
  port = await freePort();
  const stub = await startGitHubStub();
  api = stub.server;

  // Answers only when there is something to answer, so the silent path is exercised too.
  const responder = join(workspace, "responder.cjs");
  writeFileSync(
    responder,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const m = JSON.parse(Buffer.concat(chunks).toString());
  if (m.prompt !== "") fs.appendFileSync(m.replyFile, "on it: " + m.prompt + "\\n");
});
`,
  );
  chmodSync(responder, 0o755);

  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      command: ["node", responder],
      port,
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

async function deliver(event: string, delivery: string, payload: unknown): Promise<void> {
  const body = JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${port}/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  assert.equal(response.status, 200);
}

const repository = { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } };

function replyCalls(): Call[] {
  return apiCalls.filter((call) => call.method === "POST" && call.path !== "/graphql");
}

test("a review comment mention is answered inside its review thread", async () => {
  apiCalls = [];
  await deliver("pull_request_review_comment", "rc-1", {
    action: "created",
    comment: {
      id: 555,
      body: "@my-bot explain this line",
      html_url: "https://github.com/acme/widgets/pull/42#discussion_r555",
      node_id: "PRRC_555",
      user: { login: "suchipi", type: "User" },
    },
    pull_request: { number: 42, title: "Refactor" },
    repository,
  });

  await waitFor(() => replyCalls().length > 0, "the reply to be posted");
  const [call] = replyCalls();
  assert.ok(call);
  assert.equal(
    call.path,
    "/repos/acme/widgets/pulls/42/comments/555/replies",
    "the reply must go to the review comment's own thread, not the PR conversation",
  );
  assert.deepEqual(call.body, { body: "on it: explain this line" });
});

test("an issue comment mention is answered on the issue", async () => {
  apiCalls = [];
  await deliver("issue_comment", "ic-1", {
    action: "created",
    comment: {
      id: 900,
      body: "@my-bot take a look",
      html_url: "https://github.com/acme/widgets/issues/7#issuecomment-900",
      node_id: "IC_900",
      user: { login: "suchipi", type: "User" },
    },
    issue: { number: 7, title: "Bug" },
    repository,
  });

  await waitFor(() => replyCalls().length > 0, "the reply to be posted");
  const [call] = replyCalls();
  assert.ok(call);
  assert.equal(call.path, "/repos/acme/widgets/issues/7/comments");
  assert.deepEqual(call.body, { body: "on it: take a look" });
});

test("a commit comment mention is answered on the commit", async () => {
  apiCalls = [];
  await deliver("commit_comment", "cc-1", {
    action: "created",
    comment: {
      id: 12,
      commit_id: "abc123def456",
      body: "@my-bot why this change",
      html_url: "https://github.com/acme/widgets/commit/abc123def456#commitcomment-12",
      node_id: "CC_12",
      user: { login: "suchipi", type: "User" },
    },
    repository,
  });

  await waitFor(() => replyCalls().length > 0, "the reply to be posted");
  const [call] = replyCalls();
  assert.ok(call);
  assert.equal(call.path, "/repos/acme/widgets/commits/abc123def456/comments");
});

test("a command that writes nothing posts no reply", async () => {
  apiCalls = [];
  await deliver("issue_comment", "ic-silent", {
    action: "created",
    comment: {
      id: 901,
      body: "@my-bot",
      html_url: "https://github.com/acme/widgets/issues/8#issuecomment-901",
      node_id: "IC_901",
      user: { login: "suchipi", type: "User" },
    },
    issue: { number: 8, title: "Quiet" },
    repository,
  });

  // Nothing follows the trigger phrase, so the responder leaves the reply file empty.
  // The reaction still fires, which proves the mention was handled at all.
  await waitFor(() => apiCalls.some((call) => call.path === "/graphql"), "the acknowledgement reaction");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(replyCalls(), [], "an empty reply file means no comment is posted");
});
