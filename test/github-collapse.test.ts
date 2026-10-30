import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseIfOver } from "../src/platforms/github.ts";

function collapsed(body: string): string {
  return `<details>\n<summary>Expand to read full response</summary>\n\n${body}\n\n</details>`;
}

test("a reply no longer than the threshold is posted as written", () => {
  assert.equal(collapseIfOver("five", 6), "five");
  assert.equal(collapseIfOver("six ch", 6), "six ch");
});

test("a reply past the threshold is folded behind the toggle", () => {
  assert.equal(collapseIfOver("seven c", 6), collapsed("seven c"));
});

test("a threshold of 0 folds every reply away, however short", () => {
  assert.equal(collapseIfOver("x", 0), collapsed("x"));
});

test("a threshold of -1 folds nothing away, however long", () => {
  const long = "x".repeat(10_000);
  assert.equal(collapseIfOver(long, -1), long);
});
