import type { Router } from "express";
import type { Platform } from "../src/types.ts";

/** Someone who can post in the simulated platform. A bot author exercises the forwarder's `ignoreBots`. */
export type Author = { id: string; name: string; isBot: boolean };

/** One webhook a thread can send. `id` is the platform's own event name, shown verbatim in the UI. */
export type PostKind = { id: string; label: string; hint: string };

export type Thread = {
  id: string;
  title: string;
  subtitle: string;
  kinds: PostKind[];
  /** Overrides the platform's prefix, for a thread that reaches the bot without a mention. */
  composerPrefix?: string;
};

/** The forwarder's answer to a webhook, so a rejected delivery is visible in the UI rather than only in a log. */
export type Delivery = { ok: boolean; status: number | null; detail: string };

export type Message = {
  id: string;
  threadId: string;
  /** `sent` went out as a webhook; `received` came back through the fake platform API. */
  direction: "sent" | "received";
  author: string;
  isBot: boolean;
  /** Event name for a webhook, API method for a reply. */
  kind: string;
  text: string;
  /** Set on a Slack reply that arrived as `markdown_text`, which Slack reads as Markdown rather than mrkdwn. */
  markdown?: boolean;
  at: string;
  /** Platform ids this message answers to, used to route replies and reactions back onto it. */
  refs: string[];
  reactions: string[];
  delivery: Delivery | null;
  request: { url: string; headers: Record<string, string>; body: unknown } | null;
};

export type PostRequest = { threadId: string; kind: string; authorId: string; text: string };

export type PlatformSim = {
  platform: Platform;
  threads: Thread[];
  authors: Author[];
  /** Prefilled into the composer so a message triggers the forwarder without extra typing. */
  composerPrefix: string;
  /** How the ids written into message text read once rendered, for a platform that mentions by id. */
  mentionNames?: Record<string, string>;
  /** Where the forwarder must post its webhooks. */
  webhookUrl: string;
  /** Path the stand-in platform API is served under. */
  apiMount: string;
  /** What the forwarder's `<platform>.apiUrl` has to be for replies to come back here. */
  expectedApiUrl: string;
  /** Signs one webhook, sends it to the forwarder, and records both in the store. */
  post(request: PostRequest): Promise<void>;
  /** The stand-in platform API that the forwarder's replies and reactions land on. */
  api: Router;
};
