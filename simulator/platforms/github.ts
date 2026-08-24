import { createHmac, randomUUID } from "node:crypto";
import express, { type Router } from "express";
import type { GitHubSettings } from "../../src/config.ts";
import type { Logger } from "../../src/logger.ts";
import { deliver } from "../deliver.ts";
import type { Store } from "../store.ts";
import type { Author, Message, PlatformSim, PostRequest, Thread } from "../types.ts";

/** Octokit appends its own paths to this, so it must not end in a slash. */
export const GITHUB_API_MOUNT = "/api/github";

const OWNER = "acme";
const NAME = "widgets";
const REPO_URL = `https://github.com/${OWNER}/${NAME}`;
const COMMIT_SHA = "abc123def4567890abc123def4567890abc123de";
const DISCUSSION_NODE_ID = "D_sim_discussion3";

const DISCUSSION_COMMENT = "discussion_comment.created";
/** Not a GitHub event name: the webhook is the same one, with the comment's `parent_id` set. */
const DISCUSSION_REPLY = "discussion_comment.created.reply";

const REPOSITORY = {
  id: 900001,
  node_id: "R_simwidgets",
  name: NAME,
  full_name: `${OWNER}/${NAME}`,
  private: false,
  html_url: REPO_URL,
  owner: { login: OWNER, id: 5001, node_id: "O_simacme", type: "Organization", html_url: `https://github.com/${OWNER}` },
};

/** Present on every real GitHub App delivery, and what lets the App auth path reach the stub API. */
const INSTALLATION = { id: 1, node_id: "MDIzOkludGVncmF0aW9uMQ==" };

const AUTHORS: Author[] = [
  { id: "lily", name: "lily", isBot: false },
  { id: "riley", name: "riley", isBot: false },
  { id: "release-bot", name: "release-bot", isBot: true },
];

type Place =
  | { at: "issue"; number: number; title: string }
  | { at: "pull"; number: number; title: string }
  | { at: "commit"; sha: string; title: string }
  | { at: "discussion"; number: number; title: string; nodeId: string };

const PLACES: Record<string, Place> = {
  "issue-7": { at: "issue", number: 7, title: "Flaky test in CI" },
  "pull-42": { at: "pull", number: 42, title: "Refactor the runner" },
  commit: { at: "commit", sha: COMMIT_SHA, title: "Fix the retry loop" },
  "discussion-3": { at: "discussion", number: 3, title: "Ideas for v2", nodeId: DISCUSSION_NODE_ID },
};

const THREADS: Thread[] = [
  {
    id: "issue-7",
    title: "Flaky test in CI",
    subtitle: `${OWNER}/${NAME}#7 · issue`,
    kinds: [
      { id: "issue_comment.created", label: "issue_comment.created", hint: "A new comment on the issue." },
    ],
  },
  {
    id: "pull-42",
    title: "Refactor the runner",
    subtitle: `${OWNER}/${NAME}#42 · pull request`,
    kinds: [
      { id: "issue_comment.created", label: "issue_comment.created", hint: "A comment in the PR conversation." },
      {
        id: "pull_request_review_comment.created",
        label: "pull_request_review_comment.created",
        hint: "An inline comment on a diff line. The forwarder answers inside that review thread.",
      },
      {
        id: "pull_request_review.submitted",
        label: "pull_request_review.submitted",
        hint: "A review summary body. The forwarder answers in the PR conversation.",
      },
    ],
  },
  {
    id: "commit",
    title: "Fix the retry loop",
    subtitle: `${OWNER}/${NAME}@${COMMIT_SHA.slice(0, 7)} · commit`,
    kinds: [{ id: "commit_comment.created", label: "commit_comment.created", hint: "A comment on the commit." }],
  },
  {
    id: "discussion-3",
    title: "Ideas for v2",
    subtitle: `${OWNER}/${NAME} · discussion #3`,
    kinds: [
      { id: DISCUSSION_COMMENT, label: "discussion_comment.created", hint: "A comment on the discussion." },
      {
        id: DISCUSSION_REPLY,
        label: "discussion_comment.created (reply)",
        hint: "A reply under the newest top-level comment. GitHub threads discussions one level deep, so the answer hangs off that same parent. With nothing above it, it is sent as a top-level comment instead.",
      },
    ],
  },
];

let sequence = 1000;
function nextId(): number {
  sequence += 1;
  return sequence;
}

function userOf(author: Author): Record<string, unknown> {
  const index = AUTHORS.findIndex((candidate) => candidate.id === author.id);
  return {
    login: author.name,
    id: 6000 + index,
    node_id: `U_sim${index}`,
    type: author.isBot ? "Bot" : "User",
    html_url: `https://github.com/${author.name}`,
  };
}

function placeUrl(place: Place): string {
  switch (place.at) {
    case "issue":
      return `${REPO_URL}/issues/${place.number}`;
    case "pull":
      return `${REPO_URL}/pull/${place.number}`;
    case "commit":
      return `${REPO_URL}/commit/${place.sha}`;
    case "discussion":
      return `${REPO_URL}/discussions/${place.number}`;
  }
}

type Built = { payload: Record<string, unknown>; refs: string[] };

function build(place: Place, kind: string, author: Author, text: string, parentId: number | undefined): Built | undefined {
  const user = userOf(author);
  const now = new Date().toISOString();
  const id = nextId();
  const base = { repository: REPOSITORY, sender: user, installation: INSTALLATION };
  const url = placeUrl(place);

  if (kind === "issue_comment.created" && (place.at === "issue" || place.at === "pull")) {
    const nodeId = `IC_sim${id}`;
    return {
      refs: [nodeId],
      payload: {
        action: "created",
        issue: {
          number: place.number,
          title: place.title,
          html_url: url,
          node_id: `I_sim${place.number}`,
          state: "open",
          user,
          ...(place.at === "pull" ? { pull_request: { html_url: url } } : {}),
        },
        comment: {
          id,
          node_id: nodeId,
          body: text,
          html_url: `${url}#issuecomment-${id}`,
          user,
          created_at: now,
          updated_at: now,
        },
        ...base,
      },
    };
  }

  if (kind === "pull_request_review_comment.created" && place.at === "pull") {
    const nodeId = `PRRC_sim${id}`;
    return {
      refs: [nodeId],
      payload: {
        action: "created",
        comment: {
          id,
          node_id: nodeId,
          body: text,
          html_url: `${url}#discussion_r${id}`,
          path: "src/runner.ts",
          line: 42,
          user,
          created_at: now,
          updated_at: now,
        },
        pull_request: { number: place.number, title: place.title, html_url: url, node_id: `PR_sim${place.number}`, user },
        ...base,
      },
    };
  }

  if (kind === "pull_request_review.submitted" && place.at === "pull") {
    const nodeId = `PRR_sim${id}`;
    return {
      refs: [nodeId],
      payload: {
        action: "submitted",
        review: {
          id,
          node_id: nodeId,
          body: text,
          state: "commented",
          html_url: `${url}#pullrequestreview-${id}`,
          user,
          submitted_at: now,
        },
        pull_request: { number: place.number, title: place.title, html_url: url, node_id: `PR_sim${place.number}`, user },
        ...base,
      },
    };
  }

  if (kind === "commit_comment.created" && place.at === "commit") {
    const nodeId = `CC_sim${id}`;
    return {
      refs: [nodeId],
      payload: {
        action: "created",
        comment: {
          id,
          node_id: nodeId,
          commit_id: place.sha,
          body: text,
          html_url: `${url}#commitcomment-${id}`,
          user,
          created_at: now,
          updated_at: now,
        },
        ...base,
      },
    };
  }

  if ((kind === DISCUSSION_COMMENT || kind === DISCUSSION_REPLY) && place.at === "discussion") {
    const nodeId = `DC_sim${id}`;
    return {
      refs: [nodeId],
      payload: {
        action: "created",
        comment: {
          id,
          node_id: nodeId,
          parent_id: parentId ?? null,
          body: text,
          html_url: `${url}#discussioncomment-${id}`,
          user,
          created_at: now,
          updated_at: now,
        },
        discussion: { number: place.number, title: place.title, html_url: url, node_id: place.nodeId, user },
        ...base,
      },
    };
  }

  return undefined;
}

function threadForNumber(number: number): string | undefined {
  const found = Object.entries(PLACES).find(
    ([, place]) => (place.at === "issue" || place.at === "pull") && place.number === number,
  );
  return found?.[0];
}

function threadForCommit(sha: string): string | undefined {
  return Object.entries(PLACES).find(([, place]) => place.at === "commit" && place.sha === sha)?.[0];
}

function threadForDiscussion(nodeId: string): string | undefined {
  return Object.entries(PLACES).find(([, place]) => place.at === "discussion" && place.nodeId === nodeId)?.[0];
}

function threadForDiscussionNumber(number: number): string | undefined {
  return Object.entries(PLACES).find(([, place]) => place.at === "discussion" && place.number === number)?.[0];
}

/** A discussion comment is numbered once and spelled both ways, so its database id reads back off its node id. */
function discussionCommentIds(message: Message): { id: string; databaseId: number } | undefined {
  const nodeId = message.refs[0];
  if (nodeId === undefined) return undefined;
  const digits = /^DC_sim(\d+)$/.exec(nodeId)?.[1];
  return digits === undefined ? undefined : { id: nodeId, databaseId: Number(digits) };
}

function createApi(store: Store, botName: string, log: Logger): Router {
  const router = express.Router();
  router.use(express.json({ limit: "5mb" }));

  function recordReply(threadId: string | undefined, via: string, body: unknown): boolean {
    if (threadId === undefined || typeof body !== "string") {
      log.warn("dropping a reply that matches no thread", { via });
      return false;
    }
    store.add({ threadId, direction: "received", author: botName, isBot: true, kind: via, text: body, refs: [] });
    return true;
  }

  // Only reached when the forwarder is configured as a GitHub App rather than with a token.
  router.post("/app/installations/:id/access_tokens", (_request, response) => {
    response
      .status(201)
      .json({ token: "ghs_simulated_installation_token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
  });

  router.post("/repos/:owner/:repo/issues/:number/comments", (request, response) => {
    const posted = recordReply(
      threadForNumber(Number(request.params.number)),
      `issues.createComment #${request.params.number}`,
      (request.body as { body?: unknown }).body,
    );
    response.status(posted ? 201 : 404).json({ id: nextId() });
  });

  router.post("/repos/:owner/:repo/pulls/:number/comments/:commentId/replies", (request, response) => {
    const posted = recordReply(
      threadForNumber(Number(request.params.number)),
      `pulls.createReplyForReviewComment on comment ${request.params.commentId}`,
      (request.body as { body?: unknown }).body,
    );
    response.status(posted ? 201 : 404).json({ id: nextId() });
  });

  router.post("/repos/:owner/:repo/commits/:sha/comments", (request, response) => {
    const posted = recordReply(
      threadForCommit(request.params.sha),
      `repos.createCommitComment on ${request.params.sha.slice(0, 7)}`,
      (request.body as { body?: unknown }).body,
    );
    response.status(posted ? 201 : 404).json({ id: nextId() });
  });

  router.post("/graphql", (request, response) => {
    const { query, variables } = request.body as { query?: string; variables?: Record<string, unknown> };
    const operation = query ?? "";

    if (operation.includes("addReaction")) {
      const subjectId = String(variables?.subjectId ?? "");
      const target = store.findByRef(subjectId);
      if (target === undefined) {
        log.warn("reaction targets an unknown message", { subjectId });
        response.status(422).json({ errors: [{ message: `no such subject ${subjectId}` }] });
        return;
      }
      store.addReaction(target.id, String(variables?.content ?? "").toLowerCase());
      response.json({ data: { addReaction: { clientMutationId: null } } });
      return;
    }

    if (operation.includes("DiscussionCommentIds")) {
      const threadId = threadForDiscussionNumber(Number(variables?.number));
      const nodes = store.messages
        .filter((message) => message.threadId === threadId && message.kind === DISCUSSION_COMMENT)
        .map(discussionCommentIds)
        .filter((ids) => ids !== undefined);
      // One page: no discussion here is long enough to need another.
      const comments = { nodes, pageInfo: { hasNextPage: false, endCursor: null } };
      response.json({ data: { repository: { discussion: { comments } } } });
      return;
    }

    if (operation.includes("addDiscussionComment")) {
      const replyToId = variables?.replyToId;
      if (typeof replyToId === "string") {
        const parent = store.findByRef(replyToId);
        if (parent === undefined) {
          response.status(422).json({ errors: [{ message: `Could not resolve to a node with the id of '${replyToId}'` }] });
          return;
        }
        if (parent.kind === DISCUSSION_REPLY) {
          // GitHub threads discussions one level deep, and refuses in these words.
          response.status(422).json({ errors: [{ message: "Parent comment is already in a thread, cannot reply to it" }] });
          return;
        }
      }

      const posted = recordReply(
        threadForDiscussion(String(variables?.discussionId ?? "")),
        typeof replyToId === "string" ? "addDiscussionComment (threaded)" : "addDiscussionComment",
        variables?.body,
      );
      if (!posted) {
        response.status(422).json({ errors: [{ message: "no such discussion" }] });
        return;
      }
      response.json({ data: { addDiscussionComment: { clientMutationId: null } } });
      return;
    }

    log.warn("unhandled GraphQL operation", { operation: operation.slice(0, 120) });
    response.status(400).json({ errors: [{ message: "the simulator does not implement this operation" }] });
  });

  router.use((request, response) => {
    log.warn("unhandled GitHub API call", { method: request.method, path: request.originalUrl });
    response.status(404).json({ message: "the simulator does not implement this endpoint" });
  });

  return router;
}

export function createGitHubSim(options: {
  settings: GitHubSettings;
  forwarderUrl: string;
  simUrl: string;
  botName: string;
  store: Store;
  log: Logger;
}): PlatformSim {
  const { settings, forwarderUrl, simUrl, botName, store, log } = options;
  const webhookUrl = `${forwarderUrl}${settings.path}`;

  /** GitHub threads discussions one level deep, so a reply hangs off the newest top-level comment. */
  function newestDiscussionComment(threadId: string): number | undefined {
    for (let index = store.messages.length - 1; index >= 0; index -= 1) {
      const message = store.messages[index];
      if (message?.threadId === threadId && message.kind === DISCUSSION_COMMENT) {
        return discussionCommentIds(message)?.databaseId;
      }
    }
    return undefined;
  }

  return {
    platform: "github",
    threads: THREADS,
    authors: AUTHORS,
    composerPrefix: `${settings.triggerPhrases[0] ?? "@my-bot"} `,
    webhookUrl,
    apiMount: GITHUB_API_MOUNT,
    expectedApiUrl: `${simUrl}${GITHUB_API_MOUNT}`,
    api: createApi(store, botName, log),

    async post({ threadId, kind: requested, authorId, text }: PostRequest) {
      const place = PLACES[threadId];
      const author = AUTHORS.find((candidate) => candidate.id === authorId);
      if (place === undefined) throw new Error(`unknown thread ${threadId}`);
      if (author === undefined) throw new Error(`unknown author ${authorId}`);

      const parentId = requested === DISCUSSION_REPLY ? newestDiscussionComment(threadId) : undefined;
      // A reply needs something to hang off; with nothing above it there is only a top-level comment to send.
      const kind = requested === DISCUSSION_REPLY && parentId === undefined ? DISCUSSION_COMMENT : requested;

      const built = build(place, kind, author, text, parentId);
      if (built === undefined) throw new Error(`${kind} cannot be sent to ${threadId}`);

      const body = JSON.stringify(built.payload);
      const headers = {
        "x-github-event": kind.split(".")[0] ?? kind,
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", settings.webhookSecret).update(body).digest("hex")}`,
      };

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
