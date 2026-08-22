export type Task = () => Promise<void>;

export type KeyedQueue = {
  /** Queues `task` behind any other task sharing `key`. */
  push(key: string, task: Task): void;
  stats(): { running: number; waiting: number };
};

/**
 * Runs tasks serially within a key and concurrently across keys, capped at
 * `maxConcurrentKeys` keys in flight. Keys are admitted in first-arrival order,
 * so a busy conversation cannot starve a quiet one.
 */
export function createKeyedQueue(maxConcurrentKeys: number, onError: (error: unknown) => void): KeyedQueue {
  const pending = new Map<string, Task[]>();
  const running = new Set<string>();
  const waiting: string[] = [];

  function pump(): void {
    while (running.size < maxConcurrentKeys && waiting.length > 0) {
      const key = waiting.shift() as string;
      running.add(key);
      void drain(key);
    }
  }

  async function drain(key: string): Promise<void> {
    try {
      for (;;) {
        const task = pending.get(key)?.shift();
        if (task === undefined) break;
        try {
          await task();
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      // Safe to drop: a task queued during the await above landed in this same
      // array and was picked up by the loop before it broke.
      pending.delete(key);
      running.delete(key);
      pump();
    }
  }

  return {
    push(key, task) {
      const queued = pending.get(key);
      if (queued !== undefined) {
        queued.push(task);
      } else {
        pending.set(key, [task]);
        if (!running.has(key)) waiting.push(key);
      }
      pump();
    },
    stats: () => ({ running: running.size, waiting: waiting.length }),
  };
}
