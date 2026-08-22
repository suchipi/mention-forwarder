import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createLogger } from "../src/logger.ts";
import { createReplyMailbox } from "../src/reply.ts";

const silent = createLogger("error");

const opened: Array<{ close(): void }> = [];
after(() => {
  for (const mailbox of opened) mailbox.close();
});

function setup(debounceMs = 40) {
  const dir = mkdtempSync(join(tmpdir(), "mf-reply-"));
  const mailbox = createReplyMailbox(dir, debounceMs, silent);
  opened.push(mailbox);
  const posted: string[] = [];
  const poster = async (body: string) => {
    posted.push(body);
  };
  return { dir, mailbox, posted, poster };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("pathFor makes a filesystem-safe name from any mention id", () => {
  const { mailbox } = setup();
  assert.match(mailbox.pathFor("abc-123"), /abc-123\.md$/);
  assert.match(
    mailbox.pathFor("linear:Comment:c1:2026-08-19T00:00:00.000Z"),
    /linear-Comment-c1-2026-08-19T00-00-00.000Z\.md$/,
  );
});

test("postOnce sends the file's contents, trimmed", async () => {
  const { mailbox, posted, poster } = setup();
  const file = mailbox.pathFor("one");
  writeFileSync(file, "  the answer is 42\n\n");
  await mailbox.postOnce(file, poster);
  assert.deepEqual(posted, ["the answer is 42"]);
});

test("postOnce stays silent when the command wrote nothing", async () => {
  const { mailbox, posted, poster } = setup();
  await mailbox.postOnce(mailbox.pathFor("missing"), poster);
  writeFileSync(mailbox.pathFor("blank"), "   \n  ");
  await mailbox.postOnce(mailbox.pathFor("blank"), poster);
  assert.deepEqual(posted, [], "no file and a whitespace-only file both mean no reply");
});

test("each reply carries only what was appended since the last one", async () => {
  const { mailbox, posted, poster } = setup();
  const file = mailbox.pathFor("stream");
  mailbox.track(file, poster);

  appendFileSync(file, "first update\n");
  await mailbox.finish(file);
  assert.deepEqual(posted, ["first update"]);

  mailbox.track(file, poster);
  appendFileSync(file, "second update\n");
  await mailbox.finish(file);
  assert.deepEqual(posted, ["first update", "second update"], "the first reply is not repeated");
});

test("a command that rewrites the file instead of appending still gets its reply", async () => {
  const { mailbox, posted, poster } = setup();
  const file = mailbox.pathFor("rewrite");
  mailbox.track(file, poster);
  writeFileSync(file, "a long first reply that will be replaced\n");
  await mailbox.finish(file);

  mailbox.track(file, poster);
  writeFileSync(file, "short\n");
  await mailbox.finish(file);
  assert.deepEqual(posted, ["a long first reply that will be replaced", "short"]);
});

test("the watcher coalesces a burst of writes into one reply", async () => {
  const { mailbox, posted, poster } = setup(60);
  const file = mailbox.pathFor("burst");
  mailbox.track(file, poster);

  appendFileSync(file, "line one\n");
  appendFileSync(file, "line two\n");
  appendFileSync(file, "line three\n");

  await waitFor(() => posted.length > 0, "the debounced reply");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(posted.length, 1, "the burst becomes a single reply");
  assert.equal(posted[0], "line one\nline two\nline three");
});

test("finish posts pending content without waiting for the debounce", async () => {
  const { mailbox, posted, poster } = setup(60_000);
  const file = mailbox.pathFor("pending");
  mailbox.track(file, poster);
  appendFileSync(file, "do not lose me\n");
  await mailbox.finish(file);
  assert.deepEqual(posted, ["do not lose me"]);
});

test("a failing poster is contained and does not stop later replies", async () => {
  const { mailbox, posted } = setup();
  const file = mailbox.pathFor("flaky");
  let calls = 0;
  const flaky = async (body: string) => {
    calls += 1;
    if (calls === 1) throw new Error("api exploded");
    posted.push(body);
  };

  mailbox.track(file, flaky);
  appendFileSync(file, "first\n");
  await mailbox.finish(file);

  mailbox.track(file, flaky);
  appendFileSync(file, "second\n");
  await mailbox.finish(file);

  assert.equal(calls, 2);
  assert.deepEqual(posted, ["second"]);
});
