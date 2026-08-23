import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

const GITHUB_SECRET = "github-test-secret";
const SLACK_SECRET = "slack-test-secret";
const LINEAR_SECRET = "linear-test-secret";

let workspace: string;
let recordPath: string;
let port: number;
let server: ChildProcessByStdio<null, Readable, Readable>;
let slackApi: Server;
let slackCalls: Array<{ method: string; body: string }>;
let serverOutput = "";

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

/** Every forwarded mention appends one JSON line, capturing all three delivery channels. */
function writeRecorder(path: string, outputPath: string): void {
  writeFileSync(
    path,
    `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  require("node:fs").appendFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
    argv: process.argv.slice(2),
    stdin: JSON.parse(Buffer.concat(chunks).toString()),
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("MENTION_") || k === "EXTRA")),
  }) + "\\n");
  process.stdout.write("recorded\\n");
});
`,
  );
  chmodSync(path, 0o755);
}

function records(): Array<{ argv: string[]; stdin: Record<string, unknown>; env: Record<string, string> }> {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Stands in for slack.com so the Slack leg is deterministic and offline. */
function startSlackStub(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    const method = (request.url ?? "").split("?")[0]?.replace(/^.*\//, "") ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      slackCalls.push({ method, body: Buffer.concat(chunks).toString() });
      const payload =
        method === "auth.test"
          ? { ok: true, user: "my-bot", user_id: "U999BOT", team: "Acme", bot_id: "B1" }
          : method === "users.info"
            ? { ok: true, user: { id: "U456", name: "lily", real_name: "Lily Skye", profile: { display_name: "Lily Skye" } } }
            : method === "chat.getPermalink"
              ? { ok: true, permalink: "https://acme.slack.com/archives/C789/p1700000000000100" }
              : { ok: true };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      resolve({ server, url: `http://127.0.0.1:${address.port}/api/` });
    });
  });
}

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), "mention-forwarder-e2e-"));
  recordPath = join(workspace, "records.jsonl");
  const recorder = join(workspace, "recorder.cjs");
  writeRecorder(recorder, recordPath);
  port = await freePort();

  slackCalls = [];
  const stub = await startSlackStub();
  slackApi = stub.server;

  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      command: ["node", recorder, "--from", "{{platform}}", "--url", "{{url}}", "{{prompt}}"],
      env: { EXTRA: "kind={{kind}}" },
      port,
      logLevel: "debug",
      maxConcurrentConversations: 2,
      // Pinned so the guard does not reach for api.github.com/meta mid-test.
      github: { triggerPhrases: ["@my-bot"], allowedSources: ["203.0.113.0/24"] },
      linear: { triggerPhrases: ["@my-bot"] },
      slack: { apiUrl: stub.url, triggerPhrases: ["@my-bot"] },
      logPayloads: true,
    }),
  );
  writeFileSync(
    join(workspace, ".env"),
    [
      `GITHUB_WEBHOOK_SECRET=${GITHUB_SECRET}`,
      `SLACK_SIGNING_SECRET=${SLACK_SECRET}`,
      `SLACK_BOT_TOKEN=xoxb-not-a-real-token`,
      `LINEAR_WEBHOOK_SECRET=${LINEAR_SECRET}`,
      "",
    ].join("\n"),
  );

  server = spawn(process.execPath, [CLI, "--config", join(workspace, "config.json"), "--env-file", join(workspace, ".env")], {
    cwd: workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.setEncoding("utf8");
  server.stderr.setEncoding("utf8");
  server.stdout.on("data", (chunk: string) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk: string) => {
    serverOutput += chunk;
  });
  await waitFor(
    () => serverOutput.includes(`listening on http://localhost:${port}`),
    `server startup (got: ${serverOutput})`,
  );
});

after(() => {
  server?.kill("SIGKILL");
  slackApi?.close();
});

function post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function githubHeaders(body: string, event: string, delivery: string): Record<string, string> {
  return {
    "x-github-event": event,
    "x-github-delivery": delivery,
    "x-hub-signature-256": `sha256=${createHmac("sha256", GITHUB_SECRET).update(body).digest("hex")}`,
  };
}

function githubIssueComment(commentBody: string): string {
  return JSON.stringify({
    action: "created",
    comment: {
      body: commentBody,
      html_url: "https://github.com/acme/widgets/issues/7#issuecomment-100",
      node_id: "IC_node100",
      user: { login: "suchipi", type: "User" },
    },
    issue: { number: 7, title: "Flaky test" },
    repository: { full_name: "acme/widgets", name: "widgets", owner: { login: "acme" } },
  });
}

test("the root path answers nothing and names no platforms", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-powered-by"), null);

  const body = await response.text();
  for (const platform of ["github", "linear", "slack"]) {
    assert.ok(!body.includes(platform), `the 404 body should not name ${platform}`);
  }
});

test("rejects a GitHub webhook with a bad signature", async () => {
  const body = githubIssueComment("@my-bot should never run");
  const response = await post("/github/webhooks", body, {
    "x-github-event": "issue_comment",
    "x-github-delivery": "bad-signature",
    "x-hub-signature-256": "sha256=deadbeef",
  });
  assert.equal(response.ok, false);
  assert.equal(records().length, 0);
});

test("forwards a mentioning GitHub comment through argv, stdin, and env", async () => {
  const body = githubIssueComment("@my-bot please fix the flaky test");
  const response = await post("/github/webhooks", body, githubHeaders(body, "issue_comment", "gh-1"));
  assert.equal(response.status, 200);

  await waitFor(() => records().length === 1, "the github mention to be forwarded");
  const [record] = records();
  assert.ok(record);

  assert.deepEqual(record.argv, [
    "--from",
    "github",
    "--url",
    "https://github.com/acme/widgets/issues/7#issuecomment-100",
    "please fix the flaky test",
  ]);
  assert.equal(record.stdin.platform, "github");
  assert.equal(record.stdin.kind, "issue_comment");
  assert.equal(record.stdin.text, "@my-bot please fix the flaky test");
  assert.equal(record.stdin.prompt, "please fix the flaky test");
  assert.equal(record.stdin.author, "suchipi");
  assert.equal(record.stdin.title, "Flaky test");
  assert.equal(record.stdin.conversationKey, "github:acme/widgets#7");
  assert.equal(record.stdin.raw, undefined, "raw payload is opt-in");
  assert.equal(record.env.MENTION_PLATFORM, "github");
  assert.equal(record.env.MENTION_PROMPT, "please fix the flaky test");
  assert.equal(record.env.MENTION_URL, "https://github.com/acme/widgets/issues/7#issuecomment-100");
  assert.equal(record.env.EXTRA, "kind=issue_comment");
});

test("ignores a GitHub comment with no trigger phrase", async () => {
  const before = records().length;
  const body = githubIssueComment("just a normal comment");
  const response = await post("/github/webhooks", body, githubHeaders(body, "issue_comment", "gh-2"));
  assert.equal(response.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(records().length, before);
});

test("drops a redelivery of the same GitHub event", async () => {
  const before = records().length;
  const body = githubIssueComment("@my-bot retry me");
  const headers = githubHeaders(body, "issue_comment", "gh-retry");
  assert.equal((await post("/github/webhooks", body, headers)).status, 200);
  await waitFor(() => records().length === before + 1, "the first delivery");
  assert.equal((await post("/github/webhooks", body, headers)).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(records().length, before + 1, "the retry must not run the command twice");
});

test("forwards a mentioning Linear comment", async () => {
  const before = records().length;
  const body = JSON.stringify({
    action: "create",
    type: "Comment",
    actor: { id: "user-1", type: "user", name: "Lily Skye" },
    url: "https://linear.app/acme/issue/ACM-12/thing#comment-abc",
    createdAt: "2026-08-19T00:00:00.000Z",
    organizationId: "org-1",
    webhookId: "hook-1",
    webhookTimestamp: Date.now(),
    data: {
      id: "comment-abc",
      body: "@my-bot triage this",
      updatedAt: "2026-08-19T00:00:00.000Z",
      issueId: "issue-xyz",
      issue: { id: "issue-xyz", identifier: "ACM-12", title: "Thing is broken", url: "https://linear.app/acme/issue/ACM-12/thing" },
    },
  });
  const response = await post("/linear/webhooks", body, {
    "linear-signature": createHmac("sha256", LINEAR_SECRET).update(body).digest("hex"),
  });
  assert.equal(response.status, 200);

  await waitFor(() => records().length === before + 1, "the linear mention to be forwarded");
  const record = records().at(-1);
  assert.ok(record);
  assert.equal(record.stdin.platform, "linear");
  assert.equal(record.stdin.kind, "comment");
  assert.equal(record.stdin.prompt, "triage this");
  assert.equal(record.stdin.author, "Lily Skye");
  assert.equal(record.stdin.title, "Thing is broken");
  assert.equal(record.stdin.url, "https://linear.app/acme/issue/ACM-12/thing#comment-abc");
  assert.equal(record.stdin.conversationKey, "linear:issue-xyz");
});

test("rejects a Linear webhook with a bad signature", async () => {
  const before = records().length;
  const body = JSON.stringify({ action: "create", type: "Comment", webhookTimestamp: Date.now(), data: { body: "@my-bot hi" } });
  const response = await post("/linear/webhooks", body, { "linear-signature": "00".repeat(32) });
  assert.equal(response.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(records().length, before);
});

test("forwards a Slack app_mention that carries no trigger phrase", async () => {
  const before = records().length;
  const body = JSON.stringify({
    token: "verification",
    team_id: "T123",
    event_id: "Ev123",
    type: "event_callback",
    event: {
      type: "app_mention",
      user: "U456",
      text: "<@U999BOT> summarize the thread",
      ts: "1700000000.000100",
      channel: "C789",
      event_ts: "1700000000.000100",
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await post("/slack/events", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`,
  });
  assert.equal(response.status, 200);

  await waitFor(() => records().length === before + 1, "the slack mention to be forwarded");
  const record = records().at(-1);
  assert.ok(record);
  assert.equal(record.stdin.platform, "slack");
  assert.equal(record.stdin.kind, "app_mention");
  assert.equal(record.stdin.text, "<@U999BOT> summarize the thread");
  assert.equal(record.stdin.prompt, "summarize the thread", "the bot mention token is stripped");
  assert.equal(record.stdin.conversationKey, "slack:T123:C789:1700000000.000100");
  assert.equal(record.stdin.author, "Lily Skye", "the author id is resolved to a display name");
  assert.equal(record.stdin.url, "https://acme.slack.com/archives/C789/p1700000000000100");

  assert.match(serverOutput, /\[payload\] slack\n/, "logPayloads records the Slack event body");
  assert.match(serverOutput, /"event_id": "Ev123"/);

  const reaction = slackCalls.find((call) => call.method === "reactions.add");
  assert.ok(reaction, "the mention should be acknowledged with a reaction");
  const params = new URLSearchParams(reaction.body);
  assert.equal(params.get("channel"), "C789");
  assert.equal(params.get("timestamp"), "1700000000.000100");
  assert.equal(params.get("name"), "eyes");
});

test("rejects a Slack request with a bad signature", async () => {
  const before = records().length;
  const body = JSON.stringify({ team_id: "T123", event_id: "EvBad", event: { type: "app_mention", text: "<@U999BOT> no" } });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await post("/slack/events", body, {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": "v0=deadbeef",
  });
  assert.equal(response.ok, false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(records().length, before);
});

function slackEnvelope(eventId: string, event: Record<string, unknown>): string {
  return JSON.stringify({ token: "verification", team_id: "T123", event_id: eventId, type: "event_callback", event });
}

function slackHeaders(body: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${createHmac("sha256", SLACK_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`,
  };
}

test("forwards a Slack DM with no mention or trigger phrase", async () => {
  const before = records().length;
  const body = slackEnvelope("EvDM1", {
    type: "message",
    channel_type: "im",
    channel: "D999",
    user: "U456",
    text: "just do the thing",
    ts: "1700000001.000200",
    event_ts: "1700000001.000200",
  });
  assert.equal((await post("/slack/events", body, slackHeaders(body))).status, 200);

  await waitFor(() => records().length === before + 1, "the DM to be forwarded");
  const record = records().at(-1);
  assert.ok(record);
  assert.equal(record.stdin.platform, "slack");
  assert.equal(record.stdin.kind, "message.im");
  assert.equal(record.stdin.text, "just do the thing");
  assert.equal(record.stdin.prompt, "just do the thing", "a DM needs no trigger phrase");
  assert.equal(record.stdin.prompt, record.stdin.text, "prompt and text are equivalent for a DM");
  assert.equal(record.stdin.conversationKey, "slack:T123:D999", "the whole DM is one conversation");
});

test("a DM containing a bot mention keeps the mention in prompt", async () => {
  const before = records().length;
  const body = slackEnvelope("EvDM2", {
    type: "message",
    channel_type: "im",
    channel: "D999",
    user: "U456",
    text: "<@U999BOT> hello there",
    ts: "1700000002.000300",
    event_ts: "1700000002.000300",
  });
  assert.equal((await post("/slack/events", body, slackHeaders(body))).status, 200);

  await waitFor(() => records().length === before + 1, "the DM to be forwarded");
  const record = records().at(-1);
  assert.ok(record);
  assert.equal(record.stdin.text, "<@U999BOT> hello there");
  assert.equal(record.stdin.prompt, record.stdin.text, "nothing is stripped from a DM");
});

test("forwards a channel message that carries the trigger phrase but no mention", async () => {
  const before = records().length;
  const body = slackEnvelope("EvCh2", {
    type: "message",
    channel_type: "channel",
    channel: "C789",
    user: "U456",
    text: "@my-bot summarize the backlog",
    ts: "1700000005.000600",
    event_ts: "1700000005.000600",
  });
  assert.equal((await post("/slack/events", body, slackHeaders(body))).status, 200);

  await waitFor(() => records().length === before + 1, "the phrase-only channel message to be forwarded");
  const record = records().at(-1);
  assert.ok(record);
  assert.equal(record.stdin.kind, "message.channels");
  assert.equal(record.stdin.prompt, "summarize the backlog", "the trigger phrase is stripped");
  assert.equal(record.stdin.conversationKey, "slack:T123:C789:1700000005.000600");
});

test("forwards a phrase-carrying message inside a thread into that thread", async () => {
  const before = records().length;
  const body = slackEnvelope("EvCh3", {
    type: "message",
    channel_type: "channel",
    channel: "C789",
    user: "U456",
    text: "@my-bot and this one too",
    ts: "1700000006.000700",
    thread_ts: "1700000000.000100",
    event_ts: "1700000006.000700",
  });
  assert.equal((await post("/slack/events", body, slackHeaders(body))).status, 200);

  await waitFor(() => records().length === before + 1, "the threaded channel message to be forwarded");
  const record = records().at(-1);
  assert.ok(record);
  assert.equal(record.stdin.conversationKey, "slack:T123:C789:1700000000.000100", "the thread is the conversation");
});

test("leaves a channel message that both mentions the bot and carries the phrase to app_mention", async () => {
  const before = records().length;
  const body = slackEnvelope("EvCh4", {
    type: "message",
    channel_type: "channel",
    channel: "C789",
    user: "U456",
    text: "<@U999BOT> @my-bot do it once",
    ts: "1700000007.000800",
    event_ts: "1700000007.000800",
  });
  assert.equal((await post("/slack/events", body, slackHeaders(body))).status, 200);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(records().length, before, "Slack sends app_mention for this one as well, so it must not double up");
});

test("ignores channel messages with no trigger phrase, and edited DMs", async () => {
  const before = records().length;

  const inChannel = slackEnvelope("EvCh1", {
    type: "message",
    channel_type: "channel",
    channel: "C789",
    user: "U456",
    text: "chatting without mentioning anyone",
    ts: "1700000003.000400",
    event_ts: "1700000003.000400",
  });
  assert.equal((await post("/slack/events", inChannel, slackHeaders(inChannel))).status, 200);

  const edited = slackEnvelope("EvDM3", {
    type: "message",
    subtype: "message_changed",
    channel_type: "im",
    channel: "D999",
    user: "U456",
    text: "edited text",
    ts: "1700000004.000500",
    event_ts: "1700000004.000500",
  });
  assert.equal((await post("/slack/events", edited, slackHeaders(edited))).status, 200);

  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(records().length, before, "neither should reach the command");
});
