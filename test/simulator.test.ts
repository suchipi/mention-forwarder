import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const FORWARDER = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SIMULATOR = fileURLToPath(new URL("../simulator/cli.ts", import.meta.url));

type Platform = "github" | "slack" | "linear";
const PREFIX = "> posted by a bot\n\n";
const PLATFORMS: Platform[] = ["github", "slack", "linear"];

type Mention = { platform: string; kind: string; prompt: string; author: string; title: string; conversationKey: string };

type Message = {
  threadId: string;
  direction: "sent" | "received";
  author: string;
  isBot: boolean;
  kind: string;
  text: string;
  reactions: string[];
  delivery: { ok: boolean; status: number | null; detail: string } | null;
  request: { body: unknown } | null;
};

const ports: Record<Platform, number> = { github: 0, slack: 0, linear: 0 };
const running: Array<ReturnType<typeof spawn>> = [];
let recordPath: string;
let output = "";

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

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}\n${output}`);
}

function launch(argv: string[], cwd: string): void {
  const child = spawn(process.execPath, argv, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  running.push(child);
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      output += chunk;
    });
  }
}

function mentions(): Mention[] {
  if (!existsSync(recordPath)) return [];
  return readFileSync(recordPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Mention);
}

function mentionOf(prompt: string): Mention | undefined {
  return mentions().find((mention) => mention.prompt === prompt);
}

async function post(platform: Platform, body: { threadId: string; kind: string; authorId: string; text: string }) {
  const response = await fetch(`http://127.0.0.1:${ports[platform]}/sim/post`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `the simulator refused to send ${body.kind}: ${await response.text()}`);
}

async function clearBoard(platform: Platform) {
  const response = await fetch(`http://127.0.0.1:${ports[platform]}/sim/clear`, { method: "POST" });
  assert.equal(response.status, 200, `the ${platform} simulator refused to clear`);
}

async function messagesIn(platform: Platform, threadId: string): Promise<Message[]> {
  const response = await fetch(`http://127.0.0.1:${ports[platform]}/sim/state`);
  const state = (await response.json()) as { messages: Message[] };
  return state.messages.filter((message) => message.threadId === threadId);
}

/** Sends one message and waits for the command to receive it, returning what the command got. */
async function forwarded(platform: Platform, thread: string, kind: string, author: string, prompt: string): Promise<Mention> {
  const prefix = platform === "slack" ? (thread === "dm" ? "" : "<@U0SIMBOT> ") : "@sim-bot ";
  await post(platform, { threadId: thread, kind, authorId: author, text: `${prefix}${prompt}` });
  await waitFor(() => mentionOf(prompt) !== undefined, `${platform} ${kind} to reach the command`);
  return mentionOf(prompt) as Mention;
}

/** Asserts nothing was forwarded and nothing was acknowledged, which is what being ignored looks like. */
async function ignored(platform: Platform, thread: string, kind: string, author: string, text: string, marker: string) {
  await post(platform, { threadId: thread, kind, authorId: author, text });
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(mentionOf(marker), undefined, `${marker} should not have reached the command`);
  const message = (await messagesIn(platform, thread)).find((candidate) => candidate.text === text);
  assert.ok(message, "the simulator should still show what it sent");
  assert.deepEqual(message.reactions, [], "an ignored mention is never acknowledged");
  assert.equal(message.delivery?.status, 200, "the forwarder accepts the delivery even when it ignores it");
}

before(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mention-forwarder-sim-"));
  recordPath = join(workspace, "mentions.jsonl");

  // Records what it was handed and answers, so one message exercises both directions.
  const command = join(workspace, "recorder.cjs");
  writeFileSync(
    command,
    `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const mention = JSON.parse(Buffer.concat(chunks).toString());
  fs.appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify(mention) + "\\n");
  if (mention.prompt !== "") fs.appendFileSync(mention.replyFile, "answering: " + mention.prompt + "\\n");
});
`,
  );
  chmodSync(command, 0o755);

  const forwarderPort = await freePort();
  for (const platform of PLATFORMS) ports[platform] = await freePort();

  const configPath = join(workspace, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      command: ["node", command],
      port: forwarderPort,
      logLevel: "info",
      replyDir: join(workspace, "replies"),
      github: { triggerPhrases: ["@sim-bot"], apiUrl: `http://127.0.0.1:${ports.github}/api/github`, replyPrefix: PREFIX },
      slack: { apiUrl: `http://127.0.0.1:${ports.slack}/api/slack/` },
      linear: {
        triggerPhrases: ["@sim-bot"],
        apiUrl: `http://127.0.0.1:${ports.linear}/api/linear/graphql`,
        replyPrefix: PREFIX,
      },
    }),
  );

  const envPath = join(workspace, "sim.env");
  writeFileSync(
    envPath,
    [
      "GITHUB_WEBHOOK_SECRET=sim-test-github",
      "GITHUB_TOKEN=ghp-sim-test",
      "SLACK_SIGNING_SECRET=sim-test-slack",
      "SLACK_BOT_TOKEN=xoxb-sim-test",
      "LINEAR_WEBHOOK_SECRET=sim-test-linear",
      "LINEAR_API_KEY=lin_api_sim_test",
      "",
    ].join("\n"),
  );

  // Simulators first, so the forwarder's startup call to auth.test has a Slack to answer it.
  for (const platform of PLATFORMS) {
    launch(
      [SIMULATOR, "--platform", platform, "--port", String(ports[platform]), "--config", configPath, "--env-file", envPath],
      workspace,
    );
  }
  for (const platform of PLATFORMS) {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${ports[platform]}/sim/state`)).ok;
      } catch {
        return false;
      }
    }, `the ${platform} simulator to start`);
  }

  launch([FORWARDER, "--config", configPath, "--env-file", envPath], workspace);
  await waitFor(async () => {
    try {
      // Any answer means the port is bound; the forwarder serves no route at /.
      await fetch(`http://127.0.0.1:${forwarderPort}/`);
      return true;
    } catch {
      return false;
    }
  }, "the forwarder to start");
});

after(() => {
  for (const child of running) child.kill("SIGKILL");
});

const GITHUB_EVENTS = [
  { thread: "issue-7", kind: "issue_comment.created", mentionKind: "issue_comment", conversation: "github:acme/widgets#7" },
  { thread: "pull-42", kind: "issue_comment.created", mentionKind: "issue_comment", conversation: "github:acme/widgets#42" },
  {
    thread: "pull-42",
    kind: "pull_request_review_comment.created",
    mentionKind: "pull_request_review_comment",
    conversation: "github:acme/widgets#42",
  },
  {
    thread: "pull-42",
    kind: "pull_request_review.submitted",
    mentionKind: "pull_request_review",
    conversation: "github:acme/widgets#42",
  },
  {
    thread: "commit",
    kind: "commit_comment.created",
    mentionKind: "commit_comment",
    conversation: "github:acme/widgets@abc123def4567890abc123def4567890abc123de",
  },
  {
    thread: "discussion-3",
    kind: "discussion_comment.created",
    mentionKind: "discussion_comment",
    conversation: "github:acme/widgets/discussions/3",
  },
  {
    thread: "discussion-3",
    kind: "discussion_comment.created.reply",
    mentionKind: "discussion_comment",
    conversation: "github:acme/widgets/discussions/3",
  },
];

test("github: every event a thread offers reaches the command", async () => {
  for (const event of GITHUB_EVENTS) {
    const prompt = `gh ${event.kind} on ${event.thread}`;
    const mention = await forwarded("github", event.thread, event.kind, "lily", prompt);
    assert.equal(mention.platform, "github");
    assert.equal(mention.kind, event.mentionKind);
    assert.equal(mention.author, "lily");
    assert.equal(mention.conversationKey, event.conversation);
  }
});

test("github: the reaction and the reply come back into the thread", async () => {
  const prompt = "gh round trip";
  const mention = await forwarded("github", "issue-7", "issue_comment.created", "lily", prompt);
  assert.equal(mention.title, "Flaky test in CI");

  await waitFor(
    async () => (await messagesIn("github", "issue-7")).some((message) => message.text.includes(`answering: ${prompt}`)),
    "the github reply to come back",
  );

  const messages = await messagesIn("github", "issue-7");
  const sent = messages.find((message) => message.text.endsWith(prompt));
  assert.ok(sent);
  assert.equal(sent.delivery?.ok, true);
  assert.deepEqual(sent.reactions, ["eyes"]);

  const reply = messages.find((message) => message.text.includes(`answering: ${prompt}`));
  assert.ok(reply);
  assert.equal(reply.direction, "received");
  assert.equal(reply.kind, "issues.createComment #7", "an issue mention is answered on the issue");
  assert.ok(reply.text.startsWith(PREFIX), `github sets a replyPrefix, so its reply must lead with it: ${reply.text}`);
});

// Octokit spaces notification-triggering writes three seconds apart for github.com's rate limits,
// and the forwarder drops that pacing when github.apiUrl points elsewhere. With it back on, three
// replies on one thread would take upwards of six seconds, because each mention waits for the last
// reply to post.
test("github: replies on one thread are not paced by Octokit's write throttle", async () => {
  const prompts = ["gh pace one", "gh pace two", "gh pace three"];
  const startedAt = Date.now();
  for (const prompt of prompts) await forwarded("github", "commit", "commit_comment.created", "lily", prompt);
  await waitFor(async () => {
    const messages = await messagesIn("github", "commit");
    return prompts.every((prompt) => messages.some((message) => message.text.includes(`answering: ${prompt}`)));
  }, "all three github replies to come back");

  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 3000, `three replies on one thread took ${elapsed}ms; is the write throttle back on?`);
});

test("github: a mention inside a discussion reply is answered under that reply's parent", async () => {
  await forwarded("github", "discussion-3", "discussion_comment.created", "lily", "gh discussion parent");
  const prompt = "gh discussion reply";
  await forwarded("github", "discussion-3", "discussion_comment.created.reply", "riley", prompt);

  await waitFor(
    async () =>
      (await messagesIn("github", "discussion-3")).some((message) => message.text.includes(`answering: ${prompt}`)),
    "the answer to the discussion reply to come back",
  );

  const messages = await messagesIn("github", "discussion-3");
  const sent = messages.find((message) => message.text.endsWith(prompt));
  assert.equal(sent?.kind, "discussion_comment.created.reply");

  const reply = messages.find((message) => message.text.includes(`answering: ${prompt}`));
  // Naming the reply itself is what GitHub refuses, so an unthreaded answer here means the parent was never resolved.
  assert.equal(reply?.kind, "addDiscussionComment (threaded)");
});

test("github: bots and comments without the phrase are ignored", async () => {
  await ignored("github", "issue-7", "issue_comment.created", "release-bot", "@sim-bot gh from a bot", "gh from a bot");
  await ignored("github", "issue-7", "issue_comment.created", "lily", "gh with no phrase", "gh with no phrase");
});

test("slack: every event a thread offers reaches the command", async () => {
  const inChannel = await forwarded("slack", "general", "app_mention", "U0LILY", "slack in the channel");
  assert.equal(inChannel.platform, "slack");
  assert.equal(inChannel.kind, "app_mention");
  assert.equal(inChannel.author, "Lily Skye", "the author id is resolved through the stand-in users.info");
  assert.match(inChannel.conversationKey, /^slack:T0SIMTEAM:C0GENERAL:\d+\.\d+$/);

  const inThread = await forwarded("slack", "general-thread", "app_mention", "U0RILEY", "slack in the thread");
  assert.equal(inThread.conversationKey, "slack:T0SIMTEAM:C0GENERAL:1700000000.000100");

  const dm = await forwarded("slack", "dm", "message.im", "U0LILY", "slack in a dm");
  assert.equal(dm.kind, "message.im");
  assert.equal(dm.conversationKey, "slack:T0SIMTEAM:D0LILY", "the whole DM is one conversation");
});

test("slack: the reaction and the reply come back into the thread", async () => {
  const prompt = "slack round trip";
  await forwarded("slack", "general-thread", "app_mention", "U0LILY", prompt);

  await waitFor(
    async () =>
      (await messagesIn("slack", "general-thread")).some((message) => message.text.includes(`answering: ${prompt}`)),
    "the slack reply to come back",
  );

  const messages = await messagesIn("slack", "general-thread");
  const sent = messages.find((message) => message.text.endsWith(prompt));
  assert.ok(sent);
  assert.deepEqual(sent.reactions, ["eyes"]);

  const reply = messages.find((message) => message.text.includes(`answering: ${prompt}`));
  assert.ok(reply);
  assert.equal(reply.kind, "chat.postMessage", "a mention in a thread is answered in that same thread");
  assert.ok(reply.text.startsWith("answering: "), `slack sets no replyPrefix, so its reply goes out as written: ${reply.text}`);
});

test("slack: bots and channel messages without a mention are ignored", async () => {
  await ignored("slack", "general", "app_mention", "U0ROBOT", "<@U0SIMBOT> slack from a bot", "slack from a bot");
  await ignored("slack", "general", "message.channel", "U0LILY", "slack with no mention", "slack with no mention");
});

test("slack: asking for app_mention without the mention sends a plain message", async () => {
  await ignored("slack", "general", "app_mention", "U0LILY", "slack chatter in a channel", "slack chatter in a channel");
  await ignored("slack", "general-thread", "app_mention", "U0LILY", "slack chatter in a thread", "slack chatter in a thread");

  const inChannel = (await messagesIn("slack", "general")).find((message) => message.text === "slack chatter in a channel");
  assert.equal(inChannel?.kind, "message.channel", "the simulator records what Slack would have sent");
});

test("linear: every event a thread offers reaches the command", async () => {
  const comment = await forwarded("linear", "acm-12", "Comment.create", "user-lily", "linear comment");
  assert.equal(comment.platform, "linear");
  assert.equal(comment.kind, "comment");
  assert.equal(comment.author, "Lily Skye");
  assert.equal(comment.title, "Retries fire twice on a slow webhook");
  assert.equal(comment.conversationKey, "linear:issue-sim-acm-12");

  const reply = await forwarded("linear", "acm-12", "Comment.create.reply", "user-riley", "linear threaded comment");
  assert.equal(reply.conversationKey, "linear:issue-sim-acm-12");
});

test("linear: the reaction and the reply come back into the thread", async () => {
  const prompt = "linear round trip";
  await forwarded("linear", "acm-13", "Comment.create", "user-lily", prompt);

  await waitFor(
    async () => (await messagesIn("linear", "acm-13")).some((message) => message.text.includes(`answering: ${prompt}`)),
    "the linear reply to come back",
  );

  const messages = await messagesIn("linear", "acm-13");
  const sent = messages.find((message) => message.text.endsWith(prompt));
  assert.ok(sent);
  assert.deepEqual(sent.reactions, ["eyes"]);

  const reply = messages.find((message) => message.text.includes(`answering: ${prompt}`));
  assert.ok(reply);
  assert.equal(reply.direction, "received");
  assert.ok(reply.text.startsWith(PREFIX), `linear sets a replyPrefix, so its reply must lead with it: ${reply.text}`);
});

test("linear: a threaded reply with nothing above it is sent as a top-level comment", async () => {
  // The rule is about a reply with no comment above it, so the board has to start empty.
  await clearBoard("linear");
  const prompt = "linear reply with no parent";
  await forwarded("linear", "acm-13", "Comment.create.reply", "user-lily", prompt);

  const sent = (await messagesIn("linear", "acm-13")).find((message) => message.text.endsWith(prompt));
  assert.equal(sent?.kind, "Comment.create", "the simulator records what Linear would have sent");
  const data = (sent?.request?.body as { data?: { parentId?: string } } | undefined)?.data;
  assert.equal(data?.parentId, undefined, "a reply with no parent is not a reply");
});

test("linear: bots and comments without the phrase are ignored", async () => {
  await ignored("linear", "acm-12", "Comment.create", "app-deploy", "@sim-bot linear from a bot", "linear from a bot");
  await ignored("linear", "acm-12", "Comment.create", "user-lily", "linear with no phrase", "linear with no phrase");
});
