import { createNodeMiddleware, Webhooks } from "@octokit/webhooks";
import { App, Octokit } from "octokit";
import type { GitHubSettings } from "../config.ts";
import type { Intake } from "../intake.ts";
import type { Logger } from "../logger.ts";
import type { PayloadLogger } from "../payload-log.ts";
import { createTriggerMatcher } from "../trigger.ts";

/** GitHub takes a fixed enum rather than an emoji name; anything outside this map can't be used. */
const REACTION_CONTENT: Record<string, string> = {
  eyes: "EYES",
  "+1": "THUMBS_UP",
  thumbsup: "THUMBS_UP",
  "-1": "THUMBS_DOWN",
  thumbsdown: "THUMBS_DOWN",
  laugh: "LAUGH",
  smile: "LAUGH",
  hooray: "HOORAY",
  tada: "HOORAY",
  confused: "CONFUSED",
  heart: "HEART",
  rocket: "ROCKET",
};

export function githubReactionFor(emoji: string): string | undefined {
  return REACTION_CONTENT[emoji.replace(/^:|:$/g, "").toLowerCase()];
}

const ADD_REACTION = `
  mutation AddReaction($subjectId: ID!, $content: ReactionContent!) {
    addReaction(input: { subjectId: $subjectId, content: $content }) { clientMutationId }
  }
`;

const ADD_DISCUSSION_COMMENT = `
  mutation AddDiscussionComment($discussionId: ID!, $replyToId: ID, $body: String!) {
    addDiscussionComment(input: { discussionId: $discussionId, replyToId: $replyToId, body: $body }) {
      clientMutationId
    }
  }
`;

/** Where a reply belongs, which is not always where the mention's own reactions go. */
type ReplyPlan =
  | { via: "issueComment"; issueNumber: number }
  | { via: "reviewCommentReply"; pullNumber: number; commentId: number }
  | { via: "commitComment"; commitSha: string }
  | { via: "discussionComment"; discussionNodeId: string; replyToNodeId: string | undefined };

type Place = {
  kind: string;
  body: string | null | undefined;
  url: string;
  nodeId: string;
  author: string;
  isBot: boolean;
  title: string;
  conversationKey: string;
  owner: string;
  repo: string;
  reply: ReplyPlan;
};

export function createGitHubMiddleware(
  settings: GitHubSettings,
  reactionContent: string | undefined,
  intake: Intake,
  log: Logger,
  logPayload: PayloadLogger,
) {
  const webhooks = new Webhooks({ secret: settings.webhookSecret });
  const trigger = createTriggerMatcher(settings.triggerPhrases);

  const ScopedOctokit = settings.apiUrl === undefined ? Octokit : Octokit.defaults({ baseUrl: settings.apiUrl });
  const app =
    settings.auth.kind === "app"
      ? new App({ appId: settings.auth.appId, privateKey: settings.auth.privateKey, Octokit: ScopedOctokit })
      : undefined;
  const withToken = settings.auth.kind === "token" ? new ScopedOctokit({ auth: settings.auth.token }) : undefined;

  async function apiFor(installationId: number | undefined) {
    if (app !== undefined && installationId !== undefined) return app.getInstallationOctokit(installationId);
    return withToken;
  }

  /** One GraphQL mutation covers every place a mention can appear; the REST reaction routes do not. */
  async function react(installationId: number | undefined, nodeId: string, content: string): Promise<void> {
    const api = await apiFor(installationId);
    if (api === undefined) {
      log.debug("skipping reaction: no GitHub credentials configured");
      return;
    }
    try {
      await api.graphql(ADD_REACTION, { subjectId: nodeId, content });
    } catch (error) {
      log.warn("could not add reaction", { error: (error as Error).message });
    }
  }

  async function postReply(place: Place, installationId: number | undefined, body: string): Promise<void> {
    const api = await apiFor(installationId);
    if (api === undefined) {
      log.warn("cannot post reply: no GitHub credentials configured", { url: place.url });
      return;
    }
    const { owner, repo } = place;
    const plan = place.reply;
    switch (plan.via) {
      case "issueComment":
        await api.rest.issues.createComment({ owner, repo, issue_number: plan.issueNumber, body });
        return;
      case "reviewCommentReply":
        // Keeps the answer inside the review thread the mention was written in,
        // rather than starting a detached conversation comment on the PR.
        await api.rest.pulls.createReplyForReviewComment({
          owner,
          repo,
          pull_number: plan.pullNumber,
          comment_id: plan.commentId,
          body,
        });
        return;
      case "commitComment":
        await api.rest.repos.createCommitComment({ owner, repo, commit_sha: plan.commitSha, body });
        return;
      case "discussionComment":
        await api.graphql(ADD_DISCUSSION_COMMENT, {
          discussionId: plan.discussionNodeId,
          replyToId: plan.replyToNodeId ?? null,
          body,
        });
        return;
    }
  }

  function offer(id: string, place: Place, installationId: number | undefined, payload: unknown): void {
    const text = place.body ?? "";
    if (!trigger.test(text)) return;

    const accepted = intake(
      {
        id,
        platform: "github",
        kind: place.kind,
        url: place.url,
        text,
        prompt: trigger.strip(text),
        author: place.author,
        title: place.title,
        conversationKey: place.conversationKey,
        raw: payload,
        postReply: (body) => postReply(place, installationId, body),
      },
      { isBot: place.isBot },
    );

    if (accepted && reactionContent !== undefined) void react(installationId, place.nodeId, reactionContent);
  }

  const threadKey = (repo: string, number: number) => `github:${repo}#${number}`;

  webhooks.on("issue_comment.created", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "issue_comment",
        body: payload.comment.body,
        url: payload.comment.html_url,
        nodeId: payload.comment.node_id,
        author: payload.comment.user?.login ?? "",
        isBot: payload.comment.user?.type === "Bot",
        title: payload.issue.title,
        conversationKey: threadKey(payload.repository.full_name, payload.issue.number),
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: { via: "issueComment", issueNumber: payload.issue.number },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("pull_request_review_comment.created", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "pull_request_review_comment",
        body: payload.comment.body,
        url: payload.comment.html_url,
        nodeId: payload.comment.node_id,
        author: payload.comment.user?.login ?? "",
        isBot: payload.comment.user?.type === "Bot",
        title: payload.pull_request.title,
        conversationKey: threadKey(payload.repository.full_name, payload.pull_request.number),
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: {
          via: "reviewCommentReply",
          pullNumber: payload.pull_request.number,
          commentId: payload.comment.id,
        },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("pull_request_review.submitted", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "pull_request_review",
        body: payload.review.body,
        url: payload.review.html_url,
        nodeId: payload.review.node_id,
        author: payload.review.user?.login ?? "",
        isBot: payload.review.user?.type === "Bot",
        title: payload.pull_request.title,
        conversationKey: threadKey(payload.repository.full_name, payload.pull_request.number),
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        // A review summary has no thread of its own to answer in.
        reply: { via: "issueComment", issueNumber: payload.pull_request.number },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("issues.opened", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "issue",
        body: payload.issue.body,
        url: payload.issue.html_url,
        nodeId: payload.issue.node_id,
        author: payload.issue.user?.login ?? "",
        isBot: payload.issue.user?.type === "Bot",
        title: payload.issue.title,
        conversationKey: threadKey(payload.repository.full_name, payload.issue.number),
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: { via: "issueComment", issueNumber: payload.issue.number },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("pull_request.opened", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "pull_request",
        body: payload.pull_request.body,
        url: payload.pull_request.html_url,
        nodeId: payload.pull_request.node_id,
        author: payload.pull_request.user.login,
        isBot: payload.pull_request.user.type === "Bot",
        title: payload.pull_request.title,
        conversationKey: threadKey(payload.repository.full_name, payload.pull_request.number),
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: { via: "issueComment", issueNumber: payload.pull_request.number },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("commit_comment.created", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "commit_comment",
        body: payload.comment.body,
        url: payload.comment.html_url,
        nodeId: payload.comment.node_id,
        author: payload.comment.user?.login ?? "",
        isBot: payload.comment.user?.type === "Bot",
        title: payload.comment.commit_id.slice(0, 7),
        conversationKey: `github:${payload.repository.full_name}@${payload.comment.commit_id}`,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: { via: "commitComment", commitSha: payload.comment.commit_id },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("discussion_comment.created", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "discussion_comment",
        body: payload.comment.body,
        url: payload.comment.html_url,
        nodeId: payload.comment.node_id,
        author: payload.comment.user?.login ?? "",
        isBot: payload.comment.user?.type === "Bot",
        title: payload.discussion.title,
        conversationKey: `github:${payload.repository.full_name}/discussions/${payload.discussion.number}`,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: {
          via: "discussionComment",
          discussionNodeId: payload.discussion.node_id,
          replyToNodeId: payload.comment.node_id,
        },
      },
      payload.installation?.id,
      payload,
    );
  });

  webhooks.on("discussion.created", ({ id, payload }) => {
    offer(
      id,
      {
        kind: "discussion",
        body: payload.discussion.body,
        url: payload.discussion.html_url,
        nodeId: payload.discussion.node_id,
        author: payload.discussion.user?.login ?? "",
        isBot: payload.discussion.user?.type === "Bot",
        title: payload.discussion.title,
        conversationKey: `github:${payload.repository.full_name}/discussions/${payload.discussion.number}`,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        reply: { via: "discussionComment", discussionNodeId: payload.discussion.node_id, replyToNodeId: undefined },
      },
      payload.installation?.id,
      payload,
    );
  });

  // Registered as a catch-all so even event types we don't act on show up.
  webhooks.onAny(({ id, name, payload }) => {
    logPayload(`github ${name} (${id})`, payload);
  });

  webhooks.onError((error) => {
    log.error("webhook rejected", { error: error.message });
  });

  // Mounted without a path prefix so req.url still carries the full path the
  // middleware matches against; it calls next() for anything else.
  return createNodeMiddleware(webhooks, {
    path: settings.path,
    log: {
      debug: (message: unknown) => log.debug(String(message)),
      info: (message: unknown) => log.debug(String(message)),
      warn: (message: unknown) => log.warn(String(message)),
      error: (message: unknown) => log.error(String(message)),
    },
  });
}
