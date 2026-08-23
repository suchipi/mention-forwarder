import { createHmac } from "node:crypto";
import express, { type Router } from "express";
import type { LinearSettings } from "../../src/config.ts";
import type { Logger } from "../../src/logger.ts";
import { deliver } from "../deliver.ts";
import type { Store } from "../store.ts";
import type { Author, PlatformSim, PostRequest, Thread } from "../types.ts";

/** The Linear client is given the GraphQL endpoint itself, which lives under this mount. */
export const LINEAR_API_MOUNT = "/api/linear";

const ORGANIZATION = "org-simulator";
const TEAM = { id: "team-sim-acm", key: "ACM", name: "Acme" };

const AUTHORS: Author[] = [
  { id: "user-lily", name: "Lily Skye", isBot: false },
  { id: "user-riley", name: "Riley Chen", isBot: false },
  { id: "app-deploy", name: "deploy-bot", isBot: true },
];

type Place = { id: string; identifier: string; title: string; url: string };

const PLACES: Record<string, Place> = {
  "acm-12": {
    id: "issue-sim-acm-12",
    identifier: "ACM-12",
    title: "Retries fire twice on a slow webhook",
    url: "https://linear.app/simulator/issue/ACM-12/retries-fire-twice-on-a-slow-webhook",
  },
  "acm-13": {
    id: "issue-sim-acm-13",
    identifier: "ACM-13",
    title: "Add a status page",
    url: "https://linear.app/simulator/issue/ACM-13/add-a-status-page",
  },
};

const THREADS: Thread[] = Object.entries(PLACES).map(([id, place]) => ({
  id,
  title: place.title,
  subtitle: `${place.identifier} · issue`,
  kinds: [
    { id: "Comment.create", label: "Comment.create", hint: "A new top-level comment on the issue." },
    {
      id: "Comment.create.reply",
      label: "Comment.create (threaded reply)",
      hint: "A reply under the newest top-level comment. The forwarder answers in that same sub-thread. With nothing above it, it is sent as a top-level comment instead.",
    },
    { id: "Issue.create", label: "Issue.create", hint: "The issue description, as the issue is created." },
  ],
}));

let sequence = 0;
function nextCommentId(): string {
  sequence += 1;
  return `comment-sim-${sequence}`;
}

function actorFor(author: Author): Record<string, unknown> {
  // An application actor carries `service` where a person carries `name`, and the
  // forwarder treats anything that is not a user as a bot.
  return author.isBot
    ? { id: author.id, type: "application", service: author.name }
    : { id: author.id, type: "user", name: author.name };
}

type Built = { payload: Record<string, unknown>; refs: string[] };

function build(place: Place, kind: string, author: Author, text: string, parentId: string | undefined): Built {
  const now = new Date().toISOString();
  const envelope = {
    action: "create",
    actor: actorFor(author),
    createdAt: now,
    organizationId: ORGANIZATION,
    webhookId: "webhook-simulator",
    webhookTimestamp: Date.now(),
  };

  if (kind === "Issue.create") {
    return {
      refs: [place.id],
      payload: {
        ...envelope,
        type: "Issue",
        url: place.url,
        data: {
          id: place.id,
          title: place.title,
          description: text,
          identifier: place.identifier,
          number: Number(place.identifier.split("-")[1] ?? 0),
          url: place.url,
          createdAt: now,
          updatedAt: now,
          team: TEAM,
        },
      },
    };
  }

  const id = nextCommentId();
  return {
    refs: [id],
    payload: {
      ...envelope,
      type: "Comment",
      url: `${place.url}#comment-${id}`,
      data: {
        id,
        body: text,
        createdAt: now,
        updatedAt: now,
        issueId: place.id,
        userId: author.id,
        ...(parentId === undefined ? {} : { parentId }),
        issue: { id: place.id, identifier: place.identifier, title: place.title, url: place.url },
      },
    },
  };
}

function threadForIssue(issueId: string): string | undefined {
  return Object.entries(PLACES).find(([, place]) => place.id === issueId)?.[0];
}

function createApi(store: Store, botName: string, log: Logger): Router {
  const router = express.Router();
  router.use(express.json({ limit: "5mb" }));

  router.post("/graphql", (request, response) => {
    const { query, variables } = request.body as { query?: string; variables?: { input?: Record<string, unknown> } };
    const operation = query ?? "";
    const input = variables?.input ?? {};

    if (operation.includes("commentCreate")) {
      const threadId = threadForIssue(String(input.issueId ?? ""));
      const body = input.body;
      if (threadId === undefined || typeof body !== "string") {
        log.warn("dropping a reply that matches no issue", { issueId: input.issueId });
        response.status(200).json({ errors: [{ message: "no such issue" }] });
        return;
      }
      const id = nextCommentId();
      store.add({
        threadId,
        direction: "received",
        author: botName,
        isBot: true,
        kind: input.parentId === undefined ? "createComment" : "createComment (threaded)",
        text: body,
        refs: [id],
      });
      response.json({
        data: { commentCreate: { __typename: "CommentPayload", comment: { id }, lastSyncId: sequence, success: true } },
      });
      return;
    }

    if (operation.includes("reactionCreate")) {
      const ref = String(input.commentId ?? input.issueId ?? "");
      const target = store.findByRef(ref);
      if (target === undefined) {
        log.warn("reaction targets an unknown message", { ref });
        response.status(200).json({ errors: [{ message: "no such subject" }] });
        return;
      }
      const emoji = String(input.emoji ?? "");
      store.addReaction(target.id, emoji);
      const now = new Date().toISOString();
      response.json({
        data: {
          reactionCreate: {
            __typename: "ReactionPayload",
            lastSyncId: sequence,
            success: true,
            reaction: { __typename: "Reaction", id: `reaction-sim-${sequence}`, emoji, createdAt: now, updatedAt: now },
          },
        },
      });
      return;
    }

    log.warn("unhandled GraphQL operation", { operation: operation.slice(0, 120) });
    response.status(200).json({ errors: [{ message: "the simulator does not implement this operation" }] });
  });

  router.use((request, response) => {
    log.warn("unhandled Linear API call", { method: request.method, path: request.originalUrl });
    response.status(404).json({ errors: [{ message: "the simulator does not implement this endpoint" }] });
  });

  return router;
}

export function createLinearSim(options: {
  settings: LinearSettings;
  forwarderUrl: string;
  simUrl: string;
  botName: string;
  store: Store;
  log: Logger;
}): PlatformSim {
  const { settings, forwarderUrl, simUrl, botName, store, log } = options;
  const webhookUrl = `${forwarderUrl}${settings.path}`;

  /** Linear threads are one level deep, so a reply hangs off the newest top-level comment. */
  function newestTopLevelComment(threadId: string): string | undefined {
    for (let index = store.messages.length - 1; index >= 0; index -= 1) {
      const message = store.messages[index];
      if (message?.threadId === threadId && message.kind === "Comment.create") return message.refs[0];
    }
    return undefined;
  }

  return {
    platform: "linear",
    threads: THREADS,
    authors: AUTHORS,
    composerPrefix: `${settings.triggerPhrases[0] ?? "@my-bot"} `,
    webhookUrl,
    apiMount: LINEAR_API_MOUNT,
    expectedApiUrl: `${simUrl}${LINEAR_API_MOUNT}/graphql`,
    api: createApi(store, botName, log),

    async post({ threadId, kind: requested, authorId, text }: PostRequest) {
      const place = PLACES[threadId];
      const author = AUTHORS.find((candidate) => candidate.id === authorId);
      if (place === undefined) throw new Error(`unknown thread ${threadId}`);
      if (author === undefined) throw new Error(`unknown author ${authorId}`);

      const parentId = requested === "Comment.create.reply" ? newestTopLevelComment(threadId) : undefined;
      // A reply needs something to hang off; with nothing above it there is only a top-level comment to send.
      const kind = requested === "Comment.create.reply" && parentId === undefined ? "Comment.create" : requested;

      const built = build(place, kind, author, text, parentId);
      const body = JSON.stringify(built.payload);
      const headers = { "linear-signature": createHmac("sha256", settings.webhookSecret).update(body).digest("hex") };

      const message = store.add({
        threadId,
        direction: "sent",
        author: author.name,
        isBot: author.isBot,
        kind,
        text,
        refs: built.refs,
        request: { url: webhookUrl, headers, body: built.payload },
      });
      store.setDelivery(message.id, await deliver(webhookUrl, body, headers));
    },
  };
}
