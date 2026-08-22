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

export function createIntake(
  config: Config,
  queue: KeyedQueue,
  seen: SeenIds,
  mailbox: ReplyMailbox,
  forward: Forward,
  log: Logger,
): Intake {
  const ignored = new Set(config.ignoreAuthors.map((name) => name.toLowerCase()));

  return (candidate, source) => {
    const { id, platform, author } = candidate;

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
