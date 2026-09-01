import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMessage } from "../simulator/markdown.js";

function github(text: string): string {
  return renderMessage(text, "github");
}

function slack(text: string, mentionNames?: Record<string, string>): string {
  return renderMessage(text, "slack", mentionNames);
}

/** A Slack reply the forwarder posted through `markdown_text`, which Slack reads as Markdown. */
function slackMarkdown(text: string): string {
  return renderMessage(text, "markdown");
}

test("commonmark emphasis, code, and line breaks", () => {
  assert.equal(
    github("**bold** and *em* and `code`"),
    "<p><strong>bold</strong> and <em>em</em> and <code>code</code></p>",
  );
  assert.equal(github("one\ntwo"), "<p>one<br />two</p>");
  assert.equal(github("snake_case_name stays whole"), "<p>snake_case_name stays whole</p>");
});

test("commonmark headings, quotes, rules, and fenced code", () => {
  assert.equal(github("# Title"), "<h1>Title</h1>");
  assert.equal(github("> quoted"), "<blockquote><p>quoted</p></blockquote>");
  assert.equal(github("---"), "<hr />");
  assert.equal(github("```js\nconst x = 1;\n```"), "<pre><code>const x = 1;</code></pre>");
});

test("commonmark lists nest and keep their starting number", () => {
  assert.equal(
    github("- one\n- two\n  - nested"),
    "<ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>",
  );
  assert.equal(github("3. third\n4. fourth"), '<ol start="3"><li>third</li><li>fourth</li></ol>');
});

test("commonmark tables carry their alignment", () => {
  assert.equal(
    github("| a | b |\n| --- | ---: |\n| 1 | 2 |"),
    '<table><thead><tr><th>a</th><th style="text-align: right">b</th></tr></thead>' +
      '<tbody><tr><td>1</td><td style="text-align: right">2</td></tr></tbody></table>',
  );
});

test("commonmark links, and only ones that can be followed", () => {
  assert.equal(
    github("[docs](https://example.com)"),
    '<p><a href="https://example.com" target="_blank" rel="noreferrer">docs</a></p>',
  );
  assert.equal(github("[click](javascript:alert(1))"), "<p>[click](javascript:alert(1))</p>");
  assert.equal(
    github("see https://example.com."),
    '<p>see <a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a>.</p>',
  );
});

test("markup in the message text cannot become markup on the page", () => {
  assert.equal(github("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  assert.equal(github('`<img onerror="x">`'), "<p><code>&lt;img onerror=&quot;x&quot;&gt;</code></p>");
  assert.equal(slack("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("linear reads the same as github", () => {
  assert.equal(renderMessage("**bold**", "linear"), github("**bold**"));
});

test("mrkdwn emphasis is slack's, not commonmark's", () => {
  assert.equal(slack("*bold* _em_ ~gone~"), "<strong>bold</strong> <em>em</em> <del>gone</del>");
  assert.equal(slack("**not bold**"), "**not bold**");
  assert.equal(slack("`code`"), "<code>code</code>");
  assert.equal(slack("```\nnpm test\n```"), "<pre><code>npm test</code></pre>");
});

test("mrkdwn quotes a run of lines, and leaves headings and lists alone", () => {
  assert.equal(slack("> quoted\nplain"), "<blockquote>quoted</blockquote>plain");
  assert.equal(slack("# not a heading"), "# not a heading");
  assert.equal(slack("- not a list"), "- not a list");
});

test("mrkdwn links and mentions arrive in angle brackets", () => {
  assert.equal(
    slack("<https://example.com|the docs>"),
    '<a href="https://example.com" target="_blank" rel="noreferrer">the docs</a>',
  );
  assert.equal(slack("<@U0SIMBOT> hi", { U0SIMBOT: "sim-bot" }), '<span class="mention">@sim-bot</span> hi');
  assert.equal(slack("<@U0NOBODY>"), '<span class="mention">@U0NOBODY</span>');
  assert.equal(slack("<#C0GENERAL|general>"), '<span class="mention">#general</span>');
  assert.equal(slack("<!here>"), '<span class="mention">@here</span>');
  assert.equal(
    slack("[docs](https://example.com)"),
    '[docs](<a href="https://example.com" target="_blank" rel="noreferrer">https://example.com</a>)',
  );
});

test("mrkdwn keeps the entities slack escapes on the way in", () => {
  assert.equal(slack("a &amp; b"), "a &amp; b");
  assert.equal(slack("&lt;@U0SIMBOT&gt;"), "&lt;@U0SIMBOT&gt;");
});

test("a Slack reply posted as markdown_text is read as Markdown, not as mrkdwn", () => {
  assert.equal(slackMarkdown("**bold** and [docs](https://example.com)"), '<p><strong>bold</strong> and <a href="https://example.com" target="_blank" rel="noreferrer">docs</a></p>');
  assert.equal(slack("**bold**"), "**bold**", "the same text sent as mrkdwn stays literal, which is the bug this replaced");
});
