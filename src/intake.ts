import type { Config } from "./config.ts";
import type { SeenIds } from "./dedupe.ts";
import type { Logger } from "./logger.ts";
import type { KeyedQueue } from "./queue.ts";
import type { ReplyMailbox, ReplyPoster } from "./reply.ts";
import type { Mention } from "./types.ts";

/** What an adapter supplies: everything but the fields intake itself assigns. */
export type Candidate = Omit<Mention, "receivedAt" | "replyFile"> & { postReply: ReplyPoster };

/** A mention paired with the way to answer it. The poster stays out of `Mention` so it can be serialized. */
export type Delivery = { mention: Mention; postReply: ReplyPoster };

export type Forward = (delivery: Delivery) => Promise<void>;

/** Returns true when the mention was queued, so the caller knows whether to acknowledge it. */
export type Intake = (candidate: Candidate, source: { isBot: boolean }) => boolean;

/** Fields a platform fills in, all of which reach the command as text. */
const TEXT_FIELDS = ["id", "kind", "url", "text", "prompt", "author", "title", "conversationKey"] as const;

const NUL = /\0/g;

/**
 * A NUL byte anywhere in a mention makes `spawn` reject the whole delivery, so
 * one is stripped rather than allowed to cost the mention its run. Doing it here
 * keeps argv, the environment and stdin telling the same story.
 */
function scrub(candidate: Candidate): { candidate: Candidate; changed: boolean } {
  let changed = false;
  const cleaned = { ...candidate };
  for (const field of TEXT_FIELDS) {
    const value = candidate[field];
    if (!value.includes("\0")) continue;
    cleaned[field] = value.replace(NUL, "");
    changed = true;
  }
  return { candidate: cleaned, changed };
}

export function createIntake(
  config: Config,
  queue: KeyedQueue,
  seen: SeenIds,
  mailbox: ReplyMailbox,
  forward: Forward,
  log: Logger,
): Intake {
  const ignored = new Set(config.ignoreAuthors.map((name) => name.toLowerCase()));
  const allowed = new Map(
    (["github", "slack", "linear"] as const).map((platform) => [
      platform,
      new Set((config[platform]?.allowedAuthors ?? []).map((name) => name.toLowerCase())),
    ]),
  );

  return (original, source) => {
    const { candidate, changed } = scrub(original);
    const { id, platform, author } = candidate;

    if (changed) log.debug("stripped NUL bytes from the mention", { platform, id });

    if (seen.sawAlready(id)) {
      log.debug("ignoring duplicate delivery", { platform, id });
      return false;
    }
    if (config.ignoreBots && source.isBot) {
      log.debug("ignoring bot author", { platform, id, author });
      return false;
    }
    if (ignored.has(author.toLowerCase())) {
      log.debug("ignoring author on ignoreAuthors list", { platform, id, author });
      return false;
    }
    const allowlist = allowed.get(platform);
    if (allowlist !== undefined && allowlist.size > 0 && !allowlist.has(author.toLowerCase())) {
      log.debug("ignoring author absent from allowedAuthors", { platform, id, author });
      return false;
    }

    const { postReply, ...rest } = candidate;
    const mention: Mention = {
      ...rest,
      raw: config.includeRawPayload ? rest.raw : undefined,
      receivedAt: new Date().toISOString(),
      replyFile: mailbox.pathFor(id),
    };

    log.info("mention accepted", {
      platform,
      kind: mention.kind,
      author,
      url: mention.url,
      conversation: mention.conversationKey,
      ...queue.stats(),
    });
    queue.push(mention.conversationKey, () => forward({ mention, postReply }));
    return true;
  };
}
