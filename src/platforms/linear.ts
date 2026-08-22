import { LinearClient } from "@linear/sdk";
import {
  type EntityWebhookPayloadWithCommentData,
  type EntityWebhookPayloadWithIssueData,
  LinearWebhookClient,
} from "@linear/sdk/webhooks";
import type { RequestHandler } from "express";
import type { LinearSettings } from "../config.ts";
import type { Intake } from "../intake.ts";
import type { Logger } from "../logger.ts";
import type { PayloadLogger } from "../payload-log.ts";
import { createTriggerMatcher } from "../trigger.ts";

type Actor = EntityWebhookPayloadWithCommentData["actor"];

function actorName(actor: Actor): string {
  if (actor === null || actor === undefined) return "";
  return "name" in actor ? actor.name : actor.service;
}

export function createLinearMiddleware(
  settings: LinearSettings,
  reactionEmoji: string,
  intake: Intake,
  log: Logger,
  logPayload: PayloadLogger,
): RequestHandler {
  const webhooks = new LinearWebhookClient(settings.webhookSecret);
  const handler = webhooks.createHandler();
  const trigger = createTriggerMatcher(settings.triggerPhrases);
  const linear =
    settings.apiKey === undefined
      ? undefined
      : new LinearClient({ apiKey: settings.apiKey, ...(settings.apiUrl === undefined ? {} : { apiUrl: settings.apiUrl }) });
  const emoji = reactionEmoji.replace(/^:|:$/g, "");

  async function postReply(target: { issueId: string; parentId?: string }, body: string): Promise<void> {
    if (linear === undefined) {
      log.warn("cannot post reply: LINEAR_API_KEY is not set");
      return;
    }
    await linear.createComment({ ...target, body });
  }

  async function react(target: { commentId: string } | { issueId: string }): Promise<void> {
    if (linear === undefined) {
      log.debug("skipping reaction: LINEAR_API_KEY is not set");
      return;
    }
    try {
      await linear.createReaction({ ...target, emoji });
    } catch (error) {
      log.warn("could not add reaction", { error: (error as Error).message });
    }
  }

  handler.on("*", (payload) => {
    logPayload(`linear ${payload.type} ${payload.action ?? ""}`.trimEnd(), payload);
  });

  handler.on("Comment", (payload: EntityWebhookPayloadWithCommentData) => {
    if (payload.action !== "create") return;
    const comment = payload.data;
    if (!trigger.test(comment.body)) return;

    const issueId = comment.issueId ?? comment.issue?.id;
    const accepted = intake(
      {
        id: `linear:Comment:${comment.id}:${comment.updatedAt}`,
        platform: "linear",
        kind: "comment",
        url: payload.url ?? comment.issue?.url ?? "",
        text: comment.body,
        prompt: trigger.strip(comment.body),
        author: actorName(payload.actor),
        title: comment.issue?.title ?? "",
        conversationKey: `linear:${issueId ?? comment.id}`,
        raw: payload,
        // Linear threads are one level deep, so a reply to a reply must hang off
        // the same top-level comment rather than nesting further.
        postReply: (body) =>
          issueId === undefined
            ? Promise.reject(new Error("comment has no issue to reply on"))
            : postReply({ issueId, parentId: comment.parentId ?? comment.id }, body),
      },
      { isBot: payload.actor?.type !== "user" },
    );

    if (accepted) void react({ commentId: comment.id });
  });

  handler.on("Issue", (payload: EntityWebhookPayloadWithIssueData) => {
    if (payload.action !== "create") return;
    const issue = payload.data;
    const description = issue.description ?? "";
    if (!trigger.test(description)) return;

    const accepted = intake(
      {
        id: `linear:Issue:${issue.id}:${issue.updatedAt}`,
        platform: "linear",
        kind: "issue",
        url: payload.url ?? issue.url,
        text: description,
        prompt: trigger.strip(description),
        author: actorName(payload.actor),
        title: issue.title,
        conversationKey: `linear:${issue.id}`,
        raw: payload,
        postReply: (body) => postReply({ issueId: issue.id }, body),
      },
      { isBot: payload.actor?.type !== "user" },
    );

    if (accepted) void react({ issueId: issue.id });
  });

  // Reads and verifies the raw request stream itself, so nothing may parse the
  // body before it — Linear signs the exact bytes.
  return (request, response) => {
    void handler(request, response);
  };
}
