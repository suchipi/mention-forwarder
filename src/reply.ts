import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Logger } from "./logger.ts";

export type ReplyPoster = (body: string) => Promise<void>;

type Entry = {
  path: string;
  postReply: ReplyPoster;
  timer: NodeJS.Timeout | undefined;
  draining: boolean;
  changedWhileDraining: boolean;
};

/** Beyond this many remembered read positions the oldest are forgotten. */
const OFFSET_CAPACITY = 4096;

export type ReplyMailbox = {
  pathFor(mentionId: string): string;
  /** Watch a reply file and post each settled batch of appended text. */
  track(replyFile: string, postReply: ReplyPoster): void;
  /** Post anything left in the file, then stop watching it. */
  finish(replyFile: string): Promise<void>;
  /** Read a reply file once and post it if it has content. */
  postOnce(replyFile: string, postReply: ReplyPoster): Promise<void>;
  close(): void;
};

function safeName(mentionId: string): string {
  return mentionId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
}

export function createReplyMailbox(dir: string, debounceMs: number, log: Logger): ReplyMailbox {
  const entries = new Map<string, Entry>();
  // Kept outside the entries so that tracking a file again after it was finished
  // resumes where it left off instead of re-posting everything already sent.
  const offsets = new Map<string, number>();
  let watcher: FSWatcher | undefined;

  function rememberOffset(path: string, offset: number): void {
    offsets.set(path, offset);
    if (offsets.size > OFFSET_CAPACITY) {
      const oldest = offsets.keys().next();
      if (!oldest.done) offsets.delete(oldest.value);
    }
  }

  /** Returns text appended since the last reply, or "" when there is nothing new. */
  async function readAppended(entry: Entry): Promise<string> {
    const info = await stat(entry.path).catch(() => undefined);
    if (info === undefined) return "";
    let offset = offsets.get(entry.path) ?? 0;
    // A shrunken file means the command rewrote rather than appended; start over.
    if (info.size < offset) offset = 0;
    if (info.size === offset) return "";

    const length = info.size - offset;
    const buffer = Buffer.alloc(length);
    const handle = await open(entry.path, "r");
    try {
      await handle.read(buffer, 0, length, offset);
    } finally {
      await handle.close();
    }
    rememberOffset(entry.path, info.size);
    return buffer.toString("utf8");
  }

  async function drain(entry: Entry): Promise<void> {
    if (entry.draining) {
      entry.changedWhileDraining = true;
      return;
    }
    entry.draining = true;
    try {
      do {
        entry.changedWhileDraining = false;
        const body = (await readAppended(entry)).trim();
        if (body === "") continue;
        try {
          await entry.postReply(body);
          log.info("posted reply", { replyFile: basename(entry.path), bytes: body.length });
        } catch (error) {
          log.error("could not post reply", { replyFile: basename(entry.path), error: (error as Error).message });
        }
      } while (entry.changedWhileDraining);
    } finally {
      entry.draining = false;
    }
  }

  function schedule(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void drain(entry);
    }, debounceMs);
    entry.timer.unref();
  }

  // One watcher on the directory rather than per file: it catches the file being
  // created, appended to, or replaced wholesale, none of which a file watch survives.
  function ensureWatching(): void {
    if (watcher !== undefined) return;
    try {
      // Not persistent: the HTTP server is what keeps the forwarder alive, and a
      // watcher that holds the event loop open would outlive a clean shutdown.
      watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename === null) return;
        const entry = entries.get(basename(filename.toString()));
        if (entry !== undefined) schedule(entry);
      });
      watcher.on("error", (error: Error) => log.warn("reply watcher error", { error: error.message }));
    } catch (error) {
      log.warn("could not watch the reply directory", { dir, error: (error as Error).message });
    }
  }

  return {
    pathFor: (mentionId) => join(dir, `${safeName(mentionId)}.md`),

    track(replyFile, postReply) {
      const key = basename(replyFile);
      if (entries.has(key)) return;
      entries.set(key, { path: replyFile, postReply, timer: undefined, draining: false, changedWhileDraining: false });
      ensureWatching();
    },

    async finish(replyFile) {
      const key = basename(replyFile);
      const entry = entries.get(key);
      if (entry === undefined) return;
      if (entry.timer !== undefined) clearTimeout(entry.timer);
      entries.delete(key);
      // A final read regardless of watch events, so a missed one cannot swallow a reply.
      await drain(entry);
    },

    async postOnce(replyFile, postReply) {
      await drain({ path: replyFile, postReply, timer: undefined, draining: false, changedWhileDraining: false });
    },

    close() {
      for (const entry of entries.values()) {
        if (entry.timer !== undefined) clearTimeout(entry.timer);
      }
      entries.clear();
      watcher?.close();
      watcher = undefined;
    },
  };
}
