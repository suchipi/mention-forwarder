import assert from "node:assert/strict";
import { test } from "node:test";
import { createTriggerMatcher } from "../src/trigger.ts";

const matcher = createTriggerMatcher(["@my-bot"]);

test("matches a standalone phrase anywhere in the body", () => {
  assert.ok(matcher.test("@my-bot please look"));
  assert.ok(matcher.test("hey @my-bot please look"));
  assert.ok(matcher.test("wrapped in punctuation (@my-bot) here"));
  assert.ok(matcher.test("MY-BOT is case insensitive: @MY-BOT"));
});

test("does not match inside a longer token", () => {
  assert.ok(!matcher.test("@my-botswana"));
  assert.ok(!matcher.test("@my-bot-2 is someone else"));
  assert.ok(!matcher.test("mail me at someone@my-bot"));
  assert.ok(!matcher.test("no mention at all"));
});

test("strip removes the phrase and the space after it", () => {
  assert.equal(matcher.strip("@my-bot fix the flaky test"), "fix the flaky test");
  assert.equal(matcher.strip("hey @my-bot fix it"), "hey fix it");
  assert.equal(matcher.strip("thanks @my-bot"), "thanks");
});

test("strip preserves indentation in the rest of the body", () => {
  const body = "@my-bot make this pass:\n\n```js\n  if (x) {\n    return 1;\n  }\n```";
  assert.equal(matcher.strip(body), "make this pass:\n\n```js\n  if (x) {\n    return 1;\n  }\n```");
});

test("phrases containing regex metacharacters are matched literally", () => {
  const bracketed = createTriggerMatcher(["@my-app[bot]"]);
  assert.ok(bracketed.test("ping @my-app[bot] now"));
  assert.ok(!bracketed.test("ping @my-appXbotX now"));
  assert.equal(bracketed.strip("@my-app[bot] go"), "go");
});

test("multiple phrases are all recognised", () => {
  const many = createTriggerMatcher(["@bot", "/agent"]);
  assert.ok(many.test("hello @bot"));
  assert.ok(many.test("hello /agent"));
  assert.equal(many.strip("@bot /agent do it"), "do it");
});

test("no phrases never matches", () => {
  const none = createTriggerMatcher([]);
  assert.ok(!none.test("@anything"));
  assert.equal(none.strip("  spaces  "), "spaces");
});
