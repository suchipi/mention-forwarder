import assert from "node:assert/strict";
import { test } from "node:test";
import { createKeyedQueue } from "../src/queue.ts";

function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Lets every already-scheduled continuation run before we assert. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round++) await new Promise((resolve) => setImmediate(resolve));
}

test("tasks sharing a key never overlap", async () => {
  const queue = createKeyedQueue(4, () => assert.fail("no task should throw"));
  const events: string[] = [];
  const first = gate();
  const second = gate();

  queue.push("thread", async () => {
    events.push("first:start");
    await first.wait;
    events.push("first:end");
  });
  queue.push("thread", async () => {
    events.push("second:start");
    await second.wait;
    events.push("second:end");
  });

  await settle();
  assert.deepEqual(events, ["first:start"], "second task must wait for the first");

  first.open();
  await settle();
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);

  second.open();
  await settle();
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("different keys run concurrently, capped at maxConcurrentKeys", async () => {
  const queue = createKeyedQueue(2, () => assert.fail("no task should throw"));
  const keys = ["a", "b", "c", "d"];
  const gates = keys.map(() => gate());
  const started: string[] = [];

  keys.forEach((key, index) => {
    queue.push(key, async () => {
      started.push(key);
      await (gates[index] as ReturnType<typeof gate>).wait;
    });
  });

  await settle();
  assert.deepEqual(started, ["a", "b"], "only two keys may be in flight");
  assert.deepEqual(queue.stats(), { running: 2, waiting: 2 });

  (gates[0] as ReturnType<typeof gate>).open();
  await settle();
  assert.deepEqual(started, ["a", "b", "c"], "finishing a key admits the next waiting one");

  (gates[1] as ReturnType<typeof gate>).open();
  (gates[2] as ReturnType<typeof gate>).open();
  await settle();
  assert.deepEqual(started, ["a", "b", "c", "d"]);

  (gates[3] as ReturnType<typeof gate>).open();
  await settle();
  assert.deepEqual(queue.stats(), { running: 0, waiting: 0 });
});

test("a task queued while its key is draining is picked up in order", async () => {
  const queue = createKeyedQueue(1, () => assert.fail("no task should throw"));
  const events: string[] = [];
  const running = gate();

  queue.push("thread", async () => {
    events.push("first");
    await running.wait;
  });
  await settle();

  queue.push("thread", async () => {
    events.push("second");
  });
  queue.push("thread", async () => {
    events.push("third");
  });

  running.open();
  await settle();
  assert.deepEqual(events, ["first", "second", "third"]);
});

test("a throwing task is reported and does not stall its key", async () => {
  const errors: unknown[] = [];
  const queue = createKeyedQueue(1, (error) => errors.push(error));
  const events: string[] = [];

  queue.push("thread", async () => {
    throw new Error("boom");
  });
  queue.push("thread", async () => {
    events.push("after");
  });

  await settle();
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
  assert.deepEqual(events, ["after"]);
});
