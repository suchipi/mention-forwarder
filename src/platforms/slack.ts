import { App as SlackApp, ExpressReceiver, LogLevel } from "@slack/bolt";
import type { Application } from "express";
import type { SlackSettings } from "../config.ts";
import type { Intake } from "../intake.ts";
import type { Level, Logger } from "../logger.ts";
import type { PayloadLogger } from "../payload-log.ts";
import { createTriggerMatcher } from "../trigger.ts";

const BOLT_LOG_LEVEL: Record<Level, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

const ANY_USER_MENTION = /<@[A-Z0-9]+(?:\|[^>]*)?>/g;

/** Slack names a subscription differently from the channel type it carries, and the name is what you enable. */
const MESSAGE_KIND: Record<string, string> = {
  channel: "message.channels",
  group: "message.groups",
  mpim: "message.mpim",
};

/** The bot's own mention token, or every user's when auth.test never said which id is the bot's. */
function botMention(botUserId: string | undefined): RegExp {
  return botUserId === undefined ? ANY_USER_MENTION : new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g");
}

type Incoming = {
  eventId: string;
  kind: string;
  channel: string;
  ts: string;
  team: string;
  userId: string | undefined;
  botId: string | undefined;
  text: string;
  prompt: string;
  conversationKey: string;
  /** Where a reply goes: a thread for channel mentions, the DM itself for a DM. */
  replyThreadTs: string | undefined;
};

export function mountSlack(
  settings: SlackSettings,
  expressApp: Application,
  options: { reactionEmoji: string; logLevel: Level },
  intake: Intake,
  log: Logger,
  logPayload: PayloadLogger,
): void {
  // Passing `app` (not `router`) makes Bolt scope its signature-verifying body
  // parser to just its own endpoint, leaving the raw body intact for the other
  // platforms, which verify signatures over the exact bytes.
  const receiver = new ExpressReceiver({
    signingSecret: settings.signingSecret,
    app: expressApp,
    endpoints: settings.path,
  });

  // No app.start(): the receiver already has our Express app, and supplying a
  // token means the constructor finishes initialization on its own.
  //
  // tokenVerificationEnabled must stay off: when on, Bolt fires auth.test from
  // its constructor without awaiting it, so a stale token or an offline machine
  // becomes an unhandled rejection that kills GitHub and Linear too. Off, the
  // same call is deferred into Bolt's error-handled path and still populates
  // context.botUserId.
  const app = new SlackApp({
    token: settings.botToken,
    receiver,
    logLevel: BOLT_LOG_LEVEL[options.logLevel],
    tokenVerificationEnabled: false,
    ...(settings.apiUrl === undefined ? {} : { clientOptions: { slackApiUrl: settings.apiUrl } }),
  });

  // Surfaces a bad token at startup instead of on the first mention; never fatal.
  app.client.auth
    .test({ token: settings.botToken })
    .then((result) => log.info("bot token verified", { bot: result.user, team: result.team }))
    .catch((error: Error) => log.warn(`bot token could not be verified: ${error.message}`));

  const trigger = createTriggerMatcher(settings.triggerPhrases);
  const displayNames = new Map<string, string>();

  app.use(async ({ body, next }) => {
    logPayload("slack", body);
    await next();
  });

  app.event("app_mention", async ({ event, body, context }) => {
    const text = event.text ?? "";

    await forward({
      eventId: body.event_id,
      kind: "app_mention",
      channel: event.channel,
      ts: event.ts,
      team: body.team_id,
      userId: event.user,
      botId: event.bot_id,
      text,
      prompt: trigger.strip(text.replace(botMention(context.botUserId), "").trim()),
      conversationKey: `slack:${body.team_id}:${event.channel}:${event.thread_ts ?? event.ts}`,
      replyThreadTs: event.thread_ts ?? event.ts,
    });
  });

  app.event("message", async ({ event, body, context }) => {
    // Only plain new messages: a subtype means an edit, a deletion, a join, or a
    // bot post, none of which should start work.
    if (event.subtype !== undefined) return;

    const text = event.text ?? "";
    if (event.channel_type !== "im") {
      if (!trigger.test(text)) return;
      // Slack delivers a message that mentions the bot as app_mention as well, in no
      // guaranteed order, so answering it here too would run the command twice.
      if (text.replace(botMention(context.botUserId), "") !== text) {
        log.debug("leaving a message that mentions the bot to the app_mention handler", { id: body.event_id });
        return;
      }

      await forward({
        eventId: body.event_id,
        kind: MESSAGE_KIND[event.channel_type] ?? `message.${event.channel_type}`,
        channel: event.channel,
        ts: event.ts,
        team: body.team_id,
        userId: event.user,
        botId: event.bot_id,
        text,
        prompt: trigger.strip(text),
        conversationKey: `slack:${body.team_id}:${event.channel}:${event.thread_ts ?? event.ts}`,
        replyThreadTs: event.thread_ts ?? event.ts,
      });
      return;
    }

    await forward({
      eventId: body.event_id,
      kind: "message.im",
      channel: event.channel,
      ts: event.ts,
      team: body.team_id,
      userId: event.user,
      botId: event.bot_id,
      text,
      // A DM is addressed to the bot by definition, so the whole message is the
      // instruction — no trigger phrase required and nothing to strip.
      prompt: text,
      // Keyed on the conversation rather than the message, so consecutive DMs are
      // answered in the order they were sent instead of racing each other.
      conversationKey: `slack:${body.team_id}:${event.channel}`,
      // A DM is already a private conversation, so a reply reads better as the next
      // message than as a thread hanging off the user's.
      replyThreadTs: undefined,
    });
  });

  app.error(async (error) => {
    log.error("slack app error", { error: error.message });
  });

  async function forward(incoming: Incoming): Promise<void> {
    const author = incoming.userId === undefined ? "" : await resolveDisplayName(incoming.userId);
    const url = await resolvePermalink(incoming.channel, incoming.ts, incoming.team);

    const accepted = intake(
      {
        id: incoming.eventId,
        platform: "slack",
        kind: incoming.kind,
        url,
        text: incoming.text,
        prompt: incoming.prompt,
        author,
        title: incoming.channel,
        conversationKey: incoming.conversationKey,
        raw: undefined,
        postReply: (body) => postReply(incoming, body),
      },
      { isBot: incoming.botId !== undefined },
    );

    if (!accepted) return;
    try {
      await app.client.reactions.add({
        channel: incoming.channel,
        timestamp: incoming.ts,
        name: options.reactionEmoji.replace(/^:|:$/g, ""),
      });
    } catch (error) {
      log.warn("could not add reaction", { error: (error as Error).message });
    }
  }

  async function postReply(incoming: Incoming, body: string): Promise<void> {
    await app.client.chat.postMessage({
      channel: incoming.channel,
      text: body,
      ...(incoming.replyThreadTs === undefined ? {} : { thread_ts: incoming.replyThreadTs }),
    });
  }

  async function resolveDisplayName(userId: string): Promise<string> {
    const cached = displayNames.get(userId);
    if (cached !== undefined) return cached;
    try {
      const info = await app.client.users.info({ user: userId });
      const profile = info.user;
      const name = profile?.profile?.display_name || profile?.real_name || profile?.name || userId;
      displayNames.set(userId, name);
      return name;
    } catch {
      // users:read is optional; the id is still a usable identifier.
      displayNames.set(userId, userId);
      return userId;
    }
  }

  async function resolvePermalink(channel: string, ts: string, team: string): Promise<string> {
    try {
      const result = await app.client.chat.getPermalink({ channel, message_ts: ts });
      if (typeof result.permalink === "string") return result.permalink;
    } catch (error) {
      log.warn("could not fetch permalink", { error: (error as Error).message });
    }
    return `https://app.slack.com/client/${team}/${channel}`;
  }
}
