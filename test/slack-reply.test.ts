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
const SECRET = "slack-reply-secret";
const PREFIX = "> posted by a bot\n\n";

/** Past what `markdown_text` holds, so the reply has to go out as plain text instead. */
const OVER_THE_LIMIT = "x".repeat(12_001);

type Call = { method: string; params: URLSearchParams };

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

/** Stands in for slack.com so what a reply is actually posted as can be asserted. */
function startSlackStub(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    const method = (request.url ?? "").split("?")[0]?.replace(/^.*\//, "") ?? "";
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      apiCalls.push({ method, params: new URLSearchParams(Buffer.concat(chunks).toString()) });
      const payload =
        method === "auth.test"
          ? { ok: true, user: "my-bot", user_id: "U999BOT", team: "Acme", bot_id: "B1" }
          : method === "users.info"
            ? { ok: true, user: { id: "U456", name: "lily", profile: { display_name: "Lily Skye" } } }
            : method === "chat.getPermalink"
              ? { ok: true, permalink: "https://acme.slack.com/archives/C789/p1700000000000100" }
              : { ok: true, ts: "1700000000.000200" };
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

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

before(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mf-slack-reply-"));
  port = await freePort();
  const stub = await startSlackStub();
  api = stub.server;

  // A prompt of "long" answers with more than markdown_text will hold.
  const responder = join(workspace, "responder.cjs");
  writeFileSync(
    responder,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const m = JSON.parse(Buffer.concat(chunks).toString());
  fs.appendFileSync(m.replyFile, m.prompt === "long" ? ${JSON.stringify(OVER_THE_LIMIT)} : "**on it**: " + m.prompt + "\\n");
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
      slack: { triggerPhrases: ["@my-bot"], apiUrl: stub.url, replyPrefix: PREFIX },
    }),
  );
  writeFileSync(join(workspace, ".env"), `SLACK_SIGNING_SECRET=${SECRET}\nSLACK_BOT_TOKEN=xoxb-stub-token\n`);

  forwarder = spawn(
    process.execPath,
    [CLI, "--config", join(workspace, "config.json"), "--env-file", join(workspace, ".env")],
    { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
  );
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return true;
    } catch {
      return false;
    }
  }, "forwarder startup");
});

after(() => {
  forwarder?.kill("SIGKILL");
  api?.close();
});

async function mention(eventId: string, text: string): Promise<void> {
  const body = JSON.stringify({
    team_id: "T123",
    event_id: eventId,
    type: "event_callback",
    event: {
      type: "app_mention",
      user: "U456",
      text,
      ts: "1700000000.000100",
      channel: "C789",
      event_ts: "1700000000.000100",
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const response = await fetch(`http://127.0.0.1:${port}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`,
    },
    body,
  });
  assert.equal(response.status, 200);
}

function replies(): Call[] {
  return apiCalls.filter((call) => call.method === "chat.postMessage");
}

test("a reply is posted as markdown, in the thread it was asked in", async () => {
  apiCalls = [];
  await mention("Ev-md", "<@U999BOT> summarize the thread");

  await waitFor(() => replies().length > 0, "the reply to be posted");
  const [call] = replies();
  assert.ok(call);
  assert.equal(call.params.get("markdown_text"), `${PREFIX}**on it**: summarize the thread`);
  assert.equal(call.params.get("text"), null, "sending both is what the API refuses");
  assert.equal(call.params.get("thread_ts"), "1700000000.000100");
  assert.equal(call.params.get("link_names"), "false");
});

test("a reply too long to render goes out as plain text rather than not at all", async () => {
  apiCalls = [];
  await mention("Ev-long", "<@U999BOT> long");

  await waitFor(() => replies().length > 0, "the reply to be posted");
  const [call] = replies();
  assert.ok(call);
  assert.equal(call.params.get("text"), PREFIX + OVER_THE_LIMIT);
  assert.equal(call.params.get("markdown_text"), null);
});
