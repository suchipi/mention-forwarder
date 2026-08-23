import assert from "node:assert/strict";
import { test } from "node:test";
import { neutralizeMarkdownMentions, neutralizeSlackMentions } from "../src/mentions.ts";

const ZWSP = "\u200B";

test("slack broadcasts stop notifying but still read the same", () => {
  assert.equal(neutralizeSlackMentions("<!channel> deploy is out"), "@channel deploy is out");
  assert.equal(neutralizeSlackMentions("<!here|here> quick one"), "@here quick one");
  assert.equal(neutralizeSlackMentions("<!everyone>"), "@everyone");
});

test("slack user, channel and group mentions keep their label", () => {
  assert.equal(neutralizeSlackMentions("ping <@U012AB3CD>"), "ping @U012AB3CD");
  assert.equal(neutralizeSlackMentions("ping <@U012AB3CD|riley>"), "ping @riley");
  assert.equal(neutralizeSlackMentions("see <#C0G9QF9GW|general>"), "see #general");
  assert.equal(neutralizeSlackMentions("see <#C0G9QF9GW>"), "see #C0G9QF9GW");
  assert.equal(neutralizeSlackMentions("cc <!subteam^SAZ94GDB8|@releases>"), "cc @releases");
  assert.equal(neutralizeSlackMentions("cc <!subteam^SAZ94GDB8>"), "cc @SAZ94GDB8");
});

test("slack formatting and links survive untouched", () => {
  const body = "*bold* _italic_ ~struck~ `code`\n>quoted\n<https://example.com|the docs> <!date^1392734382^{date}|fallback>";
  assert.equal(neutralizeSlackMentions(body), body);
});

test("markdown mentions are defused where github would have fired them", () => {
  assert.equal(neutralizeMarkdownMentions("thanks @octocat"), `thanks @${ZWSP}octocat`);
  assert.equal(neutralizeMarkdownMentions("@octocat starts a line"), `@${ZWSP}octocat starts a line`);
  assert.equal(neutralizeMarkdownMentions("cc @acme/platform-team"), `cc @${ZWSP}acme/platform-team`);
  assert.equal(neutralizeMarkdownMentions("(@octocat) in parens"), `(@${ZWSP}octocat) in parens`);
});

test("an email address is not a mention", () => {
  assert.equal(neutralizeMarkdownMentions("write to someone@example.com"), "write to someone@example.com");
});

test("code spans and fenced blocks are left byte for byte", () => {
  assert.equal(neutralizeMarkdownMentions("use `@octocat` verbatim"), "use `@octocat` verbatim");

  const fenced = ["before @octocat", "```sh", "curl -u @octocat https://x", "```", "after @octocat"].join("\n");
  const expected = [`before @${ZWSP}octocat`, "```sh", "curl -u @octocat https://x", "```", `after @${ZWSP}octocat`].join(
    "\n",
  );
  assert.equal(neutralizeMarkdownMentions(fenced), expected);
});

test("urls and links keep working", () => {
  assert.equal(
    neutralizeMarkdownMentions("see https://twitter.com/@handle for more"),
    "see https://twitter.com/@handle for more",
  );
  assert.equal(neutralizeMarkdownMentions("[@octocat](https://github.com/@octocat)"), "[@octocat](https://github.com/@octocat)");
});

test("ordinary prose is returned unchanged", () => {
  const body = "Fixed the flaky test in CI.\n\n- rebuilt the fixture\n- raised the timeout to 5s\n";
  assert.equal(neutralizeMarkdownMentions(body), body);
});
