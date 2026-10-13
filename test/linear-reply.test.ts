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
const SECRET = "linear-reply-routing-secret";
const PREFIX = "> posted by a bot\n\n";

type Mutation = { operation: string; input: Record<string, unknown> };

let port: number;
let mutations: Mutation[] = [];
let api: Server;
let forwarder: ReturnType<typeof spawn>;
let commentIds = 0;

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

/** Stands in for Linear's GraphQL endpoint so reply routing can be asserted exactly. */
function startLinearStub(): Promise<{ server: Server; url: string }> {
  const server = createHttpServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const { query, variables } = JSON.parse(Buffer.concat(chunks).toString()) as {
        query?: string;
        variables?: { input?: Record<string, unknown> };
      };
      const operation = (query ?? "").includes("commentCreate") ? "commentCreate" : "reactionCreate";
      mutations.push({ operation, input: variables?.input ?? {} });

      commentIds += 1;
      const now = new Date().toISOString();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          operation === "commentCreate"
            ? {
                data: {
                  commentCreate: {
                    __typename: "CommentPayload",
                    comment: { id: `comment-${commentIds}` },
                    lastSyncId: commentIds,
                    success: true,
                  },
                },
              }
            : {
                data: {
                  reactionCreate: {
                    __typename: "ReactionPayload",
                    lastSyncId: commentIds,
                    success: true,
                    reaction: { __typename: "Reaction", id: `reaction-${commentIds}`, emoji: "eyes", createdAt: now, updatedAt: now },
                  },
                },
              },
        ),
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      resolve({ server, url: `http://127.0.0.1:${address.port}/graphql` });
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
  const workspace = mkdtempSync(join(tmpdir(), "mf-linear-reply-"));
  port = await freePort();
  const stub = await startLinearStub();
  api = stub.server;

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
      linear: { triggerPhrases: ["@my-bot"], apiUrl: stub.url, replyPrefix: PREFIX },
    }),
  );
  writeFileSync(join(workspace, ".env"), `LINEAR_WEBHOOK_SECRET=${SECRET}\nLINEAR_API_KEY=lin_api_stub\n`);

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

async function comment(options: {
  id: string;
  issueId: string;
  body: string;
  parentId?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const payload = {
    action: "create",
    actor: { id: "user-lily", type: "user", name: "Lily Skye" },
    createdAt: now,
    organizationId: "org-test",
    webhookId: "webhook-test",
    webhookTimestamp: Date.now(),
    type: "Comment",
    url: `https://linear.app/acme/issue/ACM-12/thing#comment-${options.id}`,
    data: {
      id: options.id,
      body: options.body,
      createdAt: now,
      updatedAt: now,
      issueId: options.issueId,
      userId: "user-lily",
      ...(options.parentId === undefined ? {} : { parentId: options.parentId }),
      issue: { id: options.issueId, identifier: "ACM-12", title: "Thing is broken", url: "https://linear.app/acme/issue/ACM-12/thing" },
    },
  };

  const body = JSON.stringify(payload);
  const response = await fetch(`http://127.0.0.1:${port}/linear/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
    },
    body,
  });
  assert.equal(response.status, 200);
}

function replies(): Mutation[] {
  return mutations.filter((mutation) => mutation.operation === "commentCreate");
}

async function nextReply(): Promise<Mutation> {
  await waitFor(() => replies().length > 0, "the reply to be posted");
  const [reply] = replies();
  assert.ok(reply);
  return reply;
}

test("a mention is answered under the comment that made it", async () => {
  mutations = [];
  await comment({ id: "comment-a", issueId: "issue-one", body: "@my-bot take a look" });

  const reply = await nextReply();
  assert.deepEqual(reply.input, {
    issueId: "issue-one",
    parentId: "comment-a",
    body: `${PREFIX}on it: take a look`,
  });
});

test("a later mention elsewhere on the issue is answered in the thread the conversation started in", async () => {
  mutations = [];
  await comment({ id: "comment-b", issueId: "issue-one", body: "@my-bot one more thing" });

  const reply = await nextReply();
  assert.equal(
    reply.input.parentId,
    "comment-a",
    "the conversation started under comment-a, so its answers stay there rather than opening a thread under comment-b",
  );
  assert.equal(reply.input.body, `${PREFIX}on it: one more thing`);
});

test("a mention written as a threaded reply starts the conversation under that thread's root", async () => {
  mutations = [];
  await comment({ id: "comment-d", issueId: "issue-two", body: "@my-bot and this", parentId: "comment-c" });

  const reply = await nextReply();
  assert.equal(reply.input.parentId, "comment-c", "Linear threads are one level deep, so the root is the only place to reply");
});
