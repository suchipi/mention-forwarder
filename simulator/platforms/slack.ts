import { createHmac } from "node:crypto";
import express, { type Router } from "express";
import type { SlackSettings } from "../../src/config.ts";
import type { Logger } from "../../src/logger.ts";
import { deliver } from "../deliver.ts";
import type { Store } from "../store.ts";
import type { Author, PlatformSim, PostRequest, Thread } from "../types.ts";

/** The Slack client builds a method URL by appending the method name to the configured base. */
export const SLACK_API_MOUNT = "/api/slack";

const TEAM = "T0SIMTEAM";
const BOT_USER = "U0SIMBOT";
const BOT_ID = "B0SIMBOT";
/** Every spelling Slack gives the bot's mention, matching what the forwarder strips. */
const BOT_MENTION = new RegExp(`<@${BOT_USER}(?:\\|[^>]*)?>`);
const CHANNEL = "C0GENERAL";
const DM_CHANNEL = "D0LILY";
/** Stands for a message that was already in the channel, so its thread exists before anything is posted. */
const PARENT_TS = "1700000000.000100";

const AUTHORS: Author[] = [
  { id: "U0LILY", name: "Lily Skye", isBot: false },
  { id: "U0RILEY", name: "Riley Chen", isBot: false },
  { id: "U0ROBOT", name: "deploy-bot", isBot: true },
];

type Place = { channel: string; threadTs: string | undefined };

const PLACES: Record<string, Place> = {
  general: { channel: CHANNEL, threadTs: undefined },
  "general-thread": { channel: CHANNEL, threadTs: PARENT_TS },
  dm: { channel: DM_CHANNEL, threadTs: undefined },
};

const THREADS: Thread[] = [
  {
    id: "general",
    title: "#general",
    subtitle: `${CHANNEL} · channel`,
    kinds: [
      {
        id: "app_mention",
        label: "app_mention",
        hint: "A message mentioning the bot. Answered in a new thread. Clear the mention and Slack sends a plain message instead, so this does too.",
      },
      {
        id: "message.channel",
        label: "message (no mention)",
        hint: "Ordinary channel chatter. Forwarded only if it carries @sim-bot, and only if you clear the mention prefix first.",
      },
    ],
  },
  {
    id: "general-thread",
    title: "#general › thread",
    subtitle: `${CHANNEL} · thread ${PARENT_TS}`,
    kinds: [
      {
        id: "app_mention",
        label: "app_mention (in thread)",
        hint: "A mention inside an existing thread. Answered in that same thread. Clear the mention and Slack sends a plain message instead, so this does too.",
      },
    ],
  },
  {
    id: "dm",
    title: "Direct message",
    subtitle: `${DM_CHANNEL} · im`,
    kinds: [
      {
        id: "message.im",
        label: "message.im",
        hint: "A DM to the bot. No mention needed, and the whole text becomes the prompt.",
      },
    ],
    composerPrefix: "",
  },
];

let sequence = 0;
function nextTs(): string {
  sequence += 1;
  return `${Math.floor(Date.now() / 1000)}.${String(sequence).padStart(6, "0")}`;
}

let events = 0;
function nextEventId(): string {
  events += 1;
  return `Ev0SIM${events}`;
}

function eventFor(kind: string, place: Place, author: Author, text: string, ts: string): Record<string, unknown> {
  const common = {
    user: author.id,
    text,
    ts,
    event_ts: ts,
    team: TEAM,
    channel: place.channel,
    ...(author.isBot ? { bot_id: `B0${author.id}` } : {}),
  };

  if (kind === "app_mention") {
    return { type: "app_mention", ...common, ...(place.threadTs === undefined ? {} : { thread_ts: place.threadTs }) };
  }
  if (kind === "message.im") {
    return { type: "message", channel_type: "im", ...common };
  }
  return {
    type: "message",
    channel_type: "channel",
    ...common,
    ...(place.threadTs === undefined ? {} : { thread_ts: place.threadTs }),
  };
}

/**
 * Slack decides the event from the message, not from what the sender meant by
 * it: app_mention exists only when the bot's own token is in the text, and
 * anything else in a channel is a plain message.
 */
function kindFor(kind: string, text: string): string {
  return kind === "app_mention" && !BOT_MENTION.test(text) ? "message.channel" : kind;
}

function createApi(store: Store, botName: string, log: Logger): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "5mb" }));
  router.use(express.json({ limit: "5mb" }));

  const threadByParentTs = new Map<string, string>();
  const threadByChannel = new Map<string, string>();
  for (const [id, place] of Object.entries(PLACES)) {
    if (place.threadTs === undefined) threadByChannel.set(place.channel, id);
    else threadByParentTs.set(place.threadTs, id);
  }

  /** A reply carries the thread it belongs to; without one it is a plain message in the channel. */
  function route(channel: string, threadTs: string | undefined): string | undefined {
    if (threadTs !== undefined) {
      const target = store.findByRef(threadTs);
      if (target !== undefined) return target.threadId;
      const seeded = threadByParentTs.get(threadTs);
      if (seeded !== undefined) return seeded;
    }
    return threadByChannel.get(channel);
  }

  function field(body: unknown, name: string): string | undefined {
    const value = (body as Record<string, unknown> | undefined)?.[name];
    return typeof value === "string" ? value : undefined;
  }

  router.use((request, response) => {
    const method = request.path.replace(/^\//, "");

    switch (method) {
      case "auth.test":
        response.json({
          ok: true,
          url: "https://sim.slack.com/",
          team: "Simulator",
          user: botName,
          team_id: TEAM,
          user_id: BOT_USER,
          bot_id: BOT_ID,
        });
        return;

      case "users.info": {
        const id = field(request.body, "user") ?? "";
        const author = AUTHORS.find((candidate) => candidate.id === id);
        response.json({
          ok: true,
          user: {
            id,
            name: author?.name ?? id,
            real_name: author?.name ?? id,
            is_bot: author?.isBot ?? false,
            profile: { display_name: author?.name ?? id, real_name: author?.name ?? id },
          },
        });
        return;
      }

      case "chat.getPermalink": {
        const channel = field(request.body, "channel") ?? "";
        const ts = (field(request.body, "message_ts") ?? "").replace(".", "");
        response.json({ ok: true, channel, permalink: `https://sim.slack.com/archives/${channel}/p${ts}` });
        return;
      }

      case "chat.postMessage": {
        const channel = field(request.body, "channel") ?? "";
        const threadId = route(channel, field(request.body, "thread_ts"));
        if (threadId === undefined) {
          log.warn("dropping a reply that matches no thread", { channel });
          response.json({ ok: false, error: "channel_not_found" });
          return;
        }
        const ts = nextTs();
        store.add({
          threadId,
          direction: "received",
          author: botName,
          isBot: true,
          kind: "chat.postMessage",
          text: field(request.body, "text") ?? "",
          refs: [ts],
        });
        response.json({ ok: true, channel, ts, message: { text: field(request.body, "text") ?? "", ts } });
        return;
      }

      case "reactions.add": {
        const timestamp = field(request.body, "timestamp") ?? "";
        const target = store.findByRef(timestamp);
        if (target === undefined) {
          log.warn("reaction targets an unknown message", { timestamp });
          response.json({ ok: false, error: "message_not_found" });
          return;
        }
        store.addReaction(target.id, field(request.body, "name") ?? "");
        response.json({ ok: true });
        return;
      }

      default:
        log.warn("unhandled Slack API call", { method });
        response.json({ ok: true });
    }
  });

  return router;
}

export function createSlackSim(options: {
  settings: SlackSettings;
  forwarderUrl: string;
  simUrl: string;
  botName: string;
  store: Store;
  log: Logger;
}): PlatformSim {
  const { settings, forwarderUrl, simUrl, botName, store, log } = options;
  const webhookUrl = `${forwarderUrl}${settings.path}`;

  return {
    platform: "slack",
    threads: THREADS,
    authors: AUTHORS,
    // Slack sends the bot's id, not its handle; the forwarder strips exactly this token.
    composerPrefix: `<@${BOT_USER}> `,
    mentionNames: {
      ...Object.fromEntries(AUTHORS.map((author) => [author.id, author.name])),
      [BOT_USER]: botName,
      [CHANNEL]: "general",
    },
    webhookUrl,
    apiMount: SLACK_API_MOUNT,
    expectedApiUrl: `${simUrl}${SLACK_API_MOUNT}/`,
    api: createApi(store, botName, log),

    async post({ threadId, kind: requested, authorId, text }: PostRequest) {
      const place = PLACES[threadId];
      const author = AUTHORS.find((candidate) => candidate.id === authorId);
      if (place === undefined) throw new Error(`unknown thread ${threadId}`);
      if (author === undefined) throw new Error(`unknown author ${authorId}`);

      const kind = kindFor(requested, text);
      const ts = nextTs();
      const payload = {
        token: "sim-verification-token",
        team_id: TEAM,
        api_app_id: "A0SIMAPP",
        event: eventFor(kind, place, author, text, ts),
        type: "event_callback",
        event_id: nextEventId(),
        event_time: Math.floor(Date.now() / 1000),
        authorizations: [
          { enterprise_id: null, team_id: TEAM, user_id: BOT_USER, is_bot: true, is_enterprise_install: false },
        ],
        is_ext_shared_channel: false,
      };

      const body = JSON.stringify(payload);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const headers = {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${createHmac("sha256", settings.signingSecret)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex")}`,
      };

      const message = store.add({
        threadId,
        direction: "sent",
        author: author.name,
        isBot: author.isBot,
        kind,
        text,
        refs: [ts],
        request: { url: webhookUrl, headers, body: payload },
      });
      store.setDelivery(message.id, await deliver(webhookUrl, body, headers));
    },
  };
}
