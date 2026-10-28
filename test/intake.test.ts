import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Config } from "../src/config.ts";
import { createSeenIds } from "../src/dedupe.ts";
import { type Candidate, createIntake } from "../src/intake.ts";
import { createLogger } from "../src/logger.ts";
import { createKeyedQueue } from "../src/queue.ts";
import { createReplyMailbox } from "../src/reply.ts";
import type { Mention } from "../src/types.ts";

const silent = createLogger("error");

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    command: ["true"],
    cwd: "/tmp",
    env: {},
    port: 0,
    maxPayloadBytes: 5 * 1024 * 1024,
    trustedProxies: ["loopback"],
    timeoutMs: 0,
    lifecycle: "per-mention",
    sessionIdleMs: 0,
    replyDebounceMs: 1500,
    replyDir: undefined,
    includeRawPayload: false,
    logPayloads: false,
    logLevel: "error",
    maxConcurrentConversations: 4,
    reactionEmoji: "eyes",
    ignoreAuthors: [],
    github: undefined,
    slack: undefined,
    linear: undefined,
    ...overrides,
  };
}

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: "delivery-1",
    platform: "github",
    kind: "issue_comment",
    url: "https://github.com/o/r/issues/1#issuecomment-2",
    text: "@my-bot go",
    prompt: "go",
    author: "suchipi",
    title: "Title",
    conversationKey: "github:o/r#1",
    raw: { hello: "world" },
    postReply: async () => {},
    ...overrides,
  };
}

function githubSettings(allowedAuthors: string[]): NonNullable<Config["github"]> {
  return {
    path: "/github/webhooks",
    triggerPhrases: ["@my-bot"],
    allowedAuthors,
    allowedSources: undefined,
    replyPrefix: "",
    apiUrl: undefined,
    webhookSecret: "s",
    auth: { kind: "none" },
  };
}

function harness(config: Config) {
  const forwarded: Mention[] = [];
  const queue = createKeyedQueue(config.maxConcurrentConversations, () => assert.fail("no task should throw"));
  const mailbox = createReplyMailbox(mkdtempSync(join(tmpdir(), "mf-intake-")), 10, silent);
  const intake = createIntake(
    config,
    queue,
    createSeenIds(16),
    mailbox,
    async ({ mention }) => {
      forwarded.push(mention);
    },
    silent,
  );
  return { intake, forwarded };
}

test("accepts a mention and stamps receivedAt", async () => {
  const { intake, forwarded } = harness(baseConfig());
  assert.equal(intake(candidate(), { isSelf: false }), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(forwarded.length, 1);
  const mention = forwarded[0];
  assert.ok(mention);
  assert.equal(mention.prompt, "go");
  assert.doesNotThrow(() => new Date(mention.receivedAt).toISOString());
  assert.match(mention.replyFile, /delivery-1\.md$/, "each mention gets its own reply file path");
});

test("drops the raw payload unless includeRawPayload is on", async () => {
  const off = harness(baseConfig());
  off.intake(candidate(), { isSelf: false });
  const on = harness(baseConfig({ includeRawPayload: true }));
  on.intake(candidate(), { isSelf: false });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(off.forwarded[0]?.raw, undefined);
  assert.deepEqual(on.forwarded[0]?.raw, { hello: "world" });
});

test("the same delivery id is only forwarded once", async () => {
  const { intake, forwarded } = harness(baseConfig());
  assert.equal(intake(candidate({ id: "same" }), { isSelf: false }), true);
  assert.equal(intake(candidate({ id: "same" }), { isSelf: false }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test("our own post is skipped, and another bot's is not", async () => {
  const { intake, forwarded } = harness(baseConfig());
  assert.equal(intake(candidate(), { isSelf: true }), false);
  assert.equal(intake(candidate({ id: "two", author: "nightly-automation" }), { isSelf: false }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test("ignoreAuthors matches a bot by its id as well as its name", async () => {
  const { intake, forwarded } = harness(baseConfig({ ignoreAuthors: ["B0NOISY"] }));
  assert.equal(intake(candidate({ author: "Noisy App" }), { isSelf: false, botId: "b0noisy" }), false);
  assert.equal(intake(candidate({ id: "two", author: "Quiet App" }), { isSelf: false, botId: "B0QUIET" }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test("ignoreAuthors matches regardless of case", async () => {
  const { intake, forwarded } = harness(baseConfig({ ignoreAuthors: ["Noisy-Bot"] }));
  assert.equal(intake(candidate({ author: "noisy-bot" }), { isSelf: false }), false);
  assert.equal(intake(candidate({ id: "other", author: "suchipi" }), { isSelf: false }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test("allowedAuthors narrows to a list, case-insensitively", async () => {
  const { intake, forwarded } = harness(baseConfig({ github: githubSettings(["Suchipi", "riley"]) }));
  assert.equal(intake(candidate({ author: "SUCHIPI" }), { isSelf: false }), true);
  assert.equal(intake(candidate({ id: "two", author: "riley" }), { isSelf: false }), true);
  assert.equal(intake(candidate({ id: "three", author: "a-stranger" }), { isSelf: false }), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 2);
});

test("an empty allowedAuthors leaves everyone able to trigger", async () => {
  const { intake, forwarded } = harness(baseConfig({ github: githubSettings([]) }));
  assert.equal(intake(candidate({ author: "anyone-at-all" }), { isSelf: false }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test("one platform's allowlist does not narrow another's", async () => {
  const { intake, forwarded } = harness(baseConfig({ github: githubSettings(["suchipi"]) }));
  assert.equal(intake(candidate({ platform: "linear", author: "a-stranger" }), { isSelf: false }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
});

test("a NUL byte is stripped rather than costing the mention its run", async () => {
  const { intake, forwarded } = harness(baseConfig());
  const nul = String.fromCharCode(0);
  assert.equal(
    intake(candidate({ text: `@my-bot go${nul}now`, prompt: `go${nul}now`, author: `su${nul}chipi` }), { isSelf: false }),
    true,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.prompt, "gonow");
  assert.equal(forwarded[0]?.text, "@my-bot gonow");
  assert.equal(forwarded[0]?.author, "suchipi");
});

test("a NUL byte cannot smuggle an author past ignoreAuthors", async () => {
  const { intake } = harness(baseConfig({ ignoreAuthors: ["noisy-bot"] }));
  assert.equal(intake(candidate({ author: `noisy-${String.fromCharCode(0)}bot` }), { isSelf: false }), false);
});
