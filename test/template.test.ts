import assert from "node:assert/strict";
import { test } from "node:test";
import { envVars, findUnknownPlaceholders, render } from "../src/template.ts";
import type { Mention } from "../src/types.ts";

const mention: Mention = {
  id: "abc",
  platform: "github",
  kind: "issue_comment",
  url: "https://github.com/o/r/issues/1#issuecomment-2",
  text: "@my-bot fix it",
  prompt: "fix it",
  author: "suchipi",
  title: "Flaky test",
  conversationKey: "github:o/r#1",
  receivedAt: "2026-08-19T00:00:00.000Z",
  replyFile: "/tmp/mention-forwarder-x/abc.md",
};

test("substitutes known placeholders", () => {
  assert.equal(render("From {{url}}: {{prompt}}", mention), `From ${mention.url}: fix it`);
  assert.equal(render("{{ platform }}/{{kind}}", mention), "github/issue_comment");
});

test("leaves unknown placeholders untouched", () => {
  assert.equal(render("{{nope}}", mention), "{{nope}}");
});

test("json placeholder round-trips the whole mention", () => {
  assert.deepEqual(JSON.parse(render("{{json}}", mention)), mention);
});

test("findUnknownPlaceholders reports only unknown names", () => {
  assert.deepEqual(findUnknownPlaceholders("{{prompt}} {{nope}} {{url}} {{alsoNope}}"), ["nope", "alsoNope"]);
  assert.deepEqual(findUnknownPlaceholders("no placeholders here"), []);
});

test("env vars mirror the placeholders in SCREAMING_SNAKE_CASE", () => {
  const vars = envVars(mention);
  assert.equal(vars.MENTION_PROMPT, "fix it");
  assert.equal(vars.MENTION_CONVERSATION_KEY, "github:o/r#1");
  assert.equal(vars.MENTION_RECEIVED_AT, "2026-08-19T00:00:00.000Z");
  assert.equal(vars.MENTION_URL, mention.url);
  assert.equal(vars.MENTION_REPLY_FILE, "/tmp/mention-forwarder-x/abc.md");
});

test("a placeholder naming an Object property is left alone", () => {
  assert.equal(render("{{constructor}}", mention), "{{constructor}}");
  assert.equal(render("{{toString}} {{hasOwnProperty}}", mention), "{{toString}} {{hasOwnProperty}}");
});
