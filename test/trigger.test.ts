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

test("a phrase inside a code span does not count as a mention", () => {
  assert.ok(!matcher.test("say `@my-bot go` to start it"));
  assert.ok(!matcher.test("double ``@my-bot`` backticks too"));
  assert.equal(matcher.strip("say `@my-bot go` to start it"), "say `@my-bot go` to start it");
});

test("a phrase inside a fenced block does not count as a mention", () => {
  const body = "here is the command:\n\n```\n@my-bot fix the flaky test\n```";
  assert.ok(!matcher.test(body));
  assert.equal(matcher.strip(body), body);
});

test("a phrase outside code still counts, and the code beside it survives", () => {
  assert.ok(matcher.test("@my-bot run `npm test`"));
  assert.equal(matcher.strip("@my-bot run `npm test`"), "run `npm test`");
  assert.equal(matcher.strip("@my-bot `npm test`"), "`npm test`", "the space before a code span is not its own");
  assert.equal(
    matcher.strip("`@my-bot` is the phrase, @my-bot do it"),
    "`@my-bot` is the phrase, do it",
    "the quoted one stays, the live one goes",
  );
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
