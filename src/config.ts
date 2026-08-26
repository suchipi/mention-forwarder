import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { findUnknownPlaceholders, PLACEHOLDERS } from "./template.ts";
import type { Level } from "./logger.ts";

export class ConfigError extends Error {}

const platformOverrides = z.strictObject({
  path: z.string().startsWith("/").optional(),
  triggerPhrases: z.array(z.string().min(1)).optional(),
  allowedAuthors: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Only these authors may trigger the command on this platform. Absent or empty means anyone may, which on a public repo means anyone who can leave a comment. Compared case-insensitively against one string per platform: a GitHub login, a Slack display name, or a Linear user name. Run with `\"logLevel\": \"debug\"` and read the `author=` field to see the exact string it is compared against.",
    ),
  /** Addresses or CIDR ranges this platform's webhooks may arrive from. Replaces the built-in list. */
  allowedSources: z.array(z.string().min(1)).optional(),
  replyPrefix: z
    .string()
    .optional()
    .describe(
      "Text put in front of every reply posted on this platform: a disclaimer, an attribution, whatever has to lead each one. Set it per platform, since what a reply needs in front of it differs by where it lands. It is joined to the reply exactly as written, with nothing added in between, so a prefix meant to stand as its own paragraph has to end in a blank line of its own: `\"> Written by an AI agent.\\n\\n\"`. It goes in front of each post rather than each mention, so under `per-conversation` every streamed batch carries one, and it is defused along with the rest of the reply, so an `@name` in it notifies nobody. Silence still wins over it: a command that writes nothing to its reply file posts nothing at all, prefix or no prefix. Default: none, so a reply goes out exactly as the command wrote it.",
    ),
});

const PHRASE_INTRO = "Phrases that count as a mention, such as `[\"@my-bot\"]`.";

const PHRASE_MATCHING =
  "Matched case-insensitively and only as whole tokens, so `@my-bot` fires on `hey @my-bot, look` but not on `@my-botswana`, `@my-bot-2`, or `me@my-bot`.";

const SOURCE_OVERRIDE =
  "Replaces the built-in list rather than adding to it, and an empty array turns the source check off entirely. The entry `\"...default\"` expands to the built-in list at the position you put it in, so `[\"...default\", \"10.0.0.1\"]` is the usual way to add one address without giving up the rest. Loopback always passes either way, which is what a tunnelled delivery arrives on.";

const githubOverrides = platformOverrides.extend({
  path: platformOverrides.shape.path.describe(
    "URL path GitHub posts webhooks to. Must start with `/`. Default: `/github/webhooks`.",
  ),
  triggerPhrases: platformOverrides.shape.triggerPhrases.describe(
    `${PHRASE_INTRO} ${PHRASE_MATCHING} Required while GitHub is enabled: a GitHub webhook never reports that a mention happened, so without a phrase every comment would fire the command.`,
  ),
  allowedSources: platformOverrides.shape.allowedSources.describe(
    `Addresses or CIDR ranges GitHub's webhooks may arrive from. ${SOURCE_OVERRIDE} Setting it without \`"...default"\` also pins the list: the startup fetch and the daily refresh both stop, so a rotated GitHub range starts coming back \`403\` until you edit this. Leaving \`"...default"\` in the array keeps the refresh running instead, re-expanding it against the ranges just fetched. Default: the hook ranges read from \`api.github.com/meta\` at startup and once a day after.`,
  ),
  /** Override the GitHub API base URL; for GitHub Enterprise Server or a local stub. */
  apiUrl: z
    .string()
    .url()
    .optional()
    .describe(
      "Override the GitHub API base URL, for GitHub Enterprise Server or a local stub. Any value other than `https://api.github.com` also lifts Octokit's write pacing, which is there for github.com's own rate limits. Default: GitHub's own.",
    ),
});

const slackOverrides = platformOverrides.extend({
  path: platformOverrides.shape.path.describe(
    "URL path Slack posts events to. Must start with `/`. Default: `/slack/events`.",
  ),
  triggerPhrases: platformOverrides.shape.triggerPhrases.describe(
    `An optional second way in rather than a filter: a native \`app_mention\` always counts, and so does any message carrying one of these phrases, such as \`["@my-bot"]\`. ${PHRASE_MATCHING} Reaching a plain message needs extra event subscriptions; a DM needs neither a mention nor a phrase. Default: none, so only a real mention counts.`,
  ),
  allowedSources: platformOverrides.shape.allowedSources.describe(
    `Addresses or CIDR ranges Slack's events may arrive from. ${SOURCE_OVERRIDE} Default: no source check at all, because Slack runs on AWS and publishes no ranges of its own.`,
  ),
  /** Override the Slack API base URL; for Enterprise Grid or a local stub. */
  apiUrl: z
    .string()
    .url()
    .optional()
    .describe("Override the Slack API base URL, for Enterprise Grid or a local stub. Default: Slack's own."),
});

const linearOverrides = platformOverrides.extend({
  path: platformOverrides.shape.path.describe(
    "URL path Linear posts webhooks to. Must start with `/`. Default: `/linear/webhooks`.",
  ),
  triggerPhrases: platformOverrides.shape.triggerPhrases.describe(
    `${PHRASE_INTRO} ${PHRASE_MATCHING} Required while Linear is enabled: a Linear webhook never reports that a mention happened, so without a phrase every comment would fire the command.`,
  ),
  allowedSources: platformOverrides.shape.allowedSources.describe(
    `Addresses or CIDR ranges Linear's webhooks may arrive from. ${SOURCE_OVERRIDE} Default: the addresses Linear publishes, bundled in \`src/request-guard.ts\` because Linear offers no endpoint to read them from.`,
  ),
  /** Override the Linear GraphQL endpoint; for a local stub. */
  apiUrl: z
    .string()
    .url()
    .optional()
    .describe("Override the Linear GraphQL endpoint, for a local stub. Default: Linear's own."),
});

/** Least severe first: the order is the severity order, not alphabetical. */
const LOG_LEVEL_LIST = [
  "- `debug` why a delivery was skipped: a duplicate, a bot author, or a name absent from `allowedAuthors`.",
  "- `info` accepted mentions, the command starting and finishing, and replies posted.",
  "- `warn` refused webhooks, and best-effort failures such as a reaction or a reply that did not go through.",
  "- `error` outright failures only, such as a command exiting non-zero.",
].join("\n");

const LIFECYCLE_LIST = [
  "- `per-mention` starts the command fresh for every mention, hands it one pretty-printed JSON object on stdin, and posts its reply file once it exits.",
  "- `per-conversation` keeps one process alive per thread, writes each later mention to its stdin as one more line of JSON, and posts replies as they are written.",
].join("\n");
/**
 * Every `{{placeholder}}` `src/template.ts` substitutes, as the config schema documents them.
 * Kept in the same order as `PLACEHOLDERS` so a new one is obvious by its absence.
 */
const PLACEHOLDER_LIST = [
  "- `{{id}}` unique per delivery, so it works as a log or work-directory name. Example: `d3f1b2a0-8c4e-11f0-9a1b-3f2c6d5e7a8b`",
  "- `{{platform}}` which platform it came from: `github`, `slack`, or `linear`.",
  "- `{{kind}}` the event it arrived as. Examples: `issue_comment`, `pull_request_review_comment`, `commit_comment`, `discussion_comment`, `app_mention`, `message.im`, `comment`",
  "- `{{url}}` permalink to the comment or message that did the mentioning. Example: `https://github.com/octocat/hello-world/issues/7#issuecomment-3184920117`",
  "- `{{text}}` the comment or message body, verbatim. Example: `@my-bot please retry the flaky test`",
  "- `{{prompt}}` the same text with the mention itself removed, which is usually what you feed an agent. Example: `please retry the flaky test`",
  "- `{{author}}` who wrote it: a GitHub login, a Slack display name, or a Linear user name. Example: `octocat`",
  "- `{{title}}` the issue or PR title, or the channel id on Slack. Empty when the platform offers none. Example: `Flaky test on main`",
  "- `{{conversationKey}}` the thread whose mentions are forwarded one at a time. Examples: `github:octocat/hello-world#7`, `slack:T024BE7LD:C0G9QF9GW:1755973451.000100`, `linear:9f2c1e40-6b7a-4d02-9a11-5c8e2f0b3d64`",
  "- `{{receivedAt}}` when the forwarder accepted it, ISO 8601. Example: `2026-08-23T18:04:11.007Z`",
  "- `{{replyFile}}` path to append a reply to; write nothing there and nothing is posted. Example: `/tmp/mention-forwarder-Ab3xY9/d3f1b2a0-8c4e-11f0-9a1b-3f2c6d5e7a8b.md`",
  "- `{{json}}` the entire mention as one JSON string, the same object the command is handed on stdin.",
].join("\n");
/**
 * The shape of `mention-forwarder.config.json`. `scripts/generate-schema.ts` publishes it as
 * `mention-forwarder.config.schema.json`, so every `.describe()` below is user-facing
 * documentation: it is what an editor shows on hover.
 */
export const fileSchema = z
  .strictObject({
    $schema: z
      .string()
      .optional()
      .describe(
        "Path or URL to this JSON Schema, which is how an editor knows to offer completion and hover text for this file. The forwarder itself ignores it.",
      ),
    command: z
      .array(z.string())
      .min(1)
      .describe(
        `Argv array to run for each mention. \`command[0]\` is the program and must be on \`PATH\` or an absolute path; the rest are its arguments.\n\nEvery entry may use any of these placeholders, and a misspelled one is reported at startup rather than passed through as literal text. Each also reaches the command as a \`MENTION_*\` environment variable, so \`{{replyFile}}\` is \`MENTION_REPLY_FILE\`.\n\n${PLACEHOLDER_LIST}`,
      ),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the command. Default: the directory the forwarder was started in."),
    env: z
      .record(z.string(), z.string())
      .default({})
      .describe(
        `Extra environment variables for the command, on top of the \`MENTION_*\` ones it always receives.\n\nValues may use any of these placeholders, and a misspelled one is reported at startup rather than passed through as literal text.\n\n${PLACEHOLDER_LIST}`,
      ),
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .default(3000)
      .describe("The single port all three platforms post to. Any port from `1` to `65535`. Default: `3000`."),
    maxPayloadBytes: z
      .number()
      .int()
      .min(1024)
      .default(5 * 1024 * 1024)
      .describe(
        "Largest webhook body to accept, in bytes. A larger body is refused with `413`, and one sent without a `Content-Length` with `411`, both before anything reads it. Must be at least `1024`. Default: `5242880` (5 MiB).",
      ),
    /** Hops whose X-Forwarded-For may be believed, as Express understands them. */
    trustedProxies: z
      .array(z.string().min(1))
      .default(["loopback", "uniquelocal"])
      .describe(
        "Which hops may be believed when they set `X-Forwarded-For`, which is where the source check reads the real client address from behind a tunnel or router. Each entry is an address, a CIDR range, or one of the names `loopback`, `linklocal`, and `uniquelocal`. Default: `[\"loopback\", \"uniquelocal\"]`.",
      ),
    timeoutMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Kill the command after this many milliseconds. `0` means never, which is the right choice for a long-running agent. What it measures follows `lifecycle`: under the default `per-mention` it is one mention's run, and when `lifecycle` is set to `per-conversation` the process outlives each mention, so it caps a whole session's lifetime. Default: `0`.",
      ),
    lifecycle: z
      .enum(["per-mention", "per-conversation"])
      .default("per-mention")
      .describe(
        `How the command is run.\n\n${LIFECYCLE_LIST}\n\nDefault: \`per-mention\`.`,
      ),
    sessionIdleMs: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        "Used only when `lifecycle` is set to `per-conversation`: close a session after this many milliseconds with no new mention. `0` keeps it alive indefinitely, so one process stays live per conversation the forwarder has seen. Ignored under the default `per-mention` lifecycle, where the command exits on its own after every mention. Default: `0`.",
      ),
    replyDebounceMs: z
      .number()
      .int()
      .min(0)
      .default(1500)
      .describe(
        "Used only when `lifecycle` is set to `per-conversation`: how long writes to a reply file must settle, in milliseconds, before whatever was appended is posted. Ignored under the default `per-mention` lifecycle, where the reply file is posted once the command exits. Default: `1500`.",
      ),
    replyDir: z
      .string()
      .optional()
      .describe(
        "Directory to keep reply files in. Set it if you want to read them yourself. Default: a fresh temp directory, printed at startup.",
      ),
    includeRawPayload: z
      .boolean()
      .default(false)
      .describe(
        `Add the platform's untouched webhook payload as \`raw\` in the JSON written to the command's stdin.\n\nThis adds no placeholder of its own: there is no \`{{raw}}\`, and writing one is rejected at startup as unknown. What it does change is \`{{json}}\` and \`MENTION_JSON\`, which serialize the whole mention and so grow by the size of the payload. Read the payload from stdin rather than either of those: a payload may be as large as \`maxPayloadBytes\`, and the operating system caps how much can go in argv and the environment.\n\nDefault: \`false\`.`,
      ),
    logPayloads: z
      .boolean()
      .default(false)
      .describe(
        "Log every incoming delivery as pretty-printed JSON, including ones that matched no trigger phrase and event types the forwarder does not act on. Independent of `logLevel`, so turning it on is enough on its own. Default: `false`.",
      ),
    logLevel: z
      .enum(["debug", "info", "warn", "error"])
      .default("info")
      .describe(
        `How much to log.\n\n${LOG_LEVEL_LIST}\n\n\`warn\` and \`error\` are written to stderr, \`debug\` and \`info\` to stdout. Default: \`info\`.`,
      ),
    maxConcurrentConversations: z
      .number()
      .int()
      .min(1)
      .default(4)
      .describe(
        "How many different conversations may have a command in flight at once. Mentions within one conversation always run in arrival order and never at the same time, whatever this is set to, and nothing is dropped when the limit is reached. `1` makes everything strictly sequential. Default: `4`.",
      ),
    reactionEmoji: z
      .string()
      .min(1)
      .default("eyes")
      .describe(
        "Emoji name used to acknowledge a mention that was accepted and queued, with or without surrounding colons. GitHub takes only its own fixed set (`eyes`, `+1`, `-1`, `laugh`, `hooray`/`tada`, `confused`, `heart`, `rocket`); anything else still works on Slack and Linear and is skipped on GitHub, with a warning at startup. Default: `eyes`.",
      ),
    ignoreBots: z
      .boolean()
      .default(true)
      .describe(
        "Skip mentions written by bots. Keep this on: it is what stops the bot from re-triggering itself on its own replies. Default: `true`.",
      ),
    ignoreAuthors: z
      .array(z.string())
      .default([])
      .describe("Additional author names or logins to skip, compared case-insensitively."),
    github: githubOverrides
      .optional()
      .describe(
        "GitHub settings. GitHub turns on when `GITHUB_WEBHOOK_SECRET` is in the environment rather than because this block is present, and `triggerPhrases` is required once it is on.",
      ),
    slack: slackOverrides
      .optional()
      .describe(
        "Slack settings. Slack turns on when `SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN` are in the environment rather than because this block is present.",
      ),
    linear: linearOverrides
      .optional()
      .describe(
        "Linear settings. Linear turns on when `LINEAR_WEBHOOK_SECRET` is in the environment rather than because this block is present, and `triggerPhrases` is required once it is on.",
      ),
  })
  .meta({
    title: "mention-forwarder config",
    description:
      "Configuration for mention-forwarder, which forwards @-mentions from GitHub, Slack, and Linear into a command. Only `command` is required, and each platform turns on through its secret in the environment rather than through this file. README.md is the full reference.",
  });

export type GitHubAuth =
  | { kind: "app"; appId: string; privateKey: string }
  | { kind: "token"; token: string }
  | { kind: "none" };

/** Settings every platform shares, whatever else it needs alongside them. */
type CommonSettings = {
  path: string;
  triggerPhrases: string[];
  /** Empty means anyone may trigger the command. */
  allowedAuthors: string[];
  /** Undefined leaves the platform's built-in source list in place. */
  allowedSources: string[] | undefined;
  /** Prepended to every reply this platform posts. Empty means the reply goes out as written. */
  replyPrefix: string;
  apiUrl: string | undefined;
};

export type GitHubSettings = CommonSettings & {
  webhookSecret: string;
  auth: GitHubAuth;
};

export type SlackSettings = CommonSettings & {
  signingSecret: string;
  botToken: string;
};

export type LinearSettings = CommonSettings & {
  webhookSecret: string;
  apiKey: string | undefined;
};

export type Config = {
  command: string[];
  cwd: string;
  env: Record<string, string>;
  port: number;
  maxPayloadBytes: number;
  trustedProxies: string[];
  timeoutMs: number;
  lifecycle: "per-mention" | "per-conversation";
  sessionIdleMs: number;
  replyDebounceMs: number;
  replyDir: string | undefined;
  includeRawPayload: boolean;
  logPayloads: boolean;
  logLevel: Level;
  maxConcurrentConversations: number;
  reactionEmoji: string;
  ignoreBots: boolean;
  ignoreAuthors: string[];
  github: GitHubSettings | undefined;
  slack: SlackSettings | undefined;
  linear: LinearSettings | undefined;
};

const DEFAULT_PATHS = {
  github: "/github/webhooks",
  slack: "/slack/events",
  linear: "/linear/webhooks",
} as const;

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function readGitHubAuth(): GitHubAuth {
  const appId = env("GITHUB_APP_ID");
  const keyPath = env("GITHUB_PRIVATE_KEY_PATH");
  const inlineKey = env("GITHUB_PRIVATE_KEY");

  if (appId !== undefined) {
    const privateKey = keyPath !== undefined ? readFileSync(resolvePath(keyPath), "utf8") : inlineKey;
    if (privateKey === undefined) {
      throw new ConfigError(
        "GITHUB_APP_ID is set but no private key was found. Set GITHUB_PRIVATE_KEY_PATH to your .pem file, or GITHUB_PRIVATE_KEY to its contents.",
      );
    }
    return { kind: "app", appId, privateKey };
  }

  const token = env("GITHUB_TOKEN");
  if (token !== undefined) return { kind: "token", token };
  return { kind: "none" };
}

function requireTriggerPhrases(platform: "github" | "linear", phrases: string[] | undefined): string[] {
  if (phrases === undefined || phrases.length === 0) {
    throw new ConfigError(
      `${platform} is enabled but "${platform}.triggerPhrases" is missing or empty in the config file. ` +
        `Neither platform reports mentions as such, so without a phrase to match every comment would fire the command. ` +
        `Add something like: "${platform}": { "triggerPhrases": ["@my-bot"] }`,
    );
  }
  return phrases;
}

function checkTemplates(config: z.output<typeof fileSchema>): void {
  const templates = [
    ...config.command.map((value, index) => [`command[${index}]`, value] as const),
    ...Object.entries(config.env).map(([name, value]) => [`env.${name}`, value] as const),
  ];
  for (const [where, template] of templates) {
    const unknown = findUnknownPlaceholders(template);
    if (unknown.length > 0) {
      throw new ConfigError(
        `Unknown placeholder${unknown.length > 1 ? "s" : ""} ${unknown.map((name) => `{{${name}}}`).join(", ")} in ${where}. ` +
          `Available: ${PLACEHOLDERS.map((name) => `{{${name}}}`).join(", ")}`,
      );
    }
  }
}

export function loadConfig(path: string): Config {
  const absolute = resolvePath(path);

  let source: string;
  try {
    source = readFileSync(absolute, "utf8");
  } catch {
    throw new ConfigError(
      `Could not read config file ${absolute}. Copy mention-forwarder.config.example.json to get started, or pass --config <path>.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ConfigError(`${absolute} is not valid JSON: ${(error as Error).message}`);
  }

  const result = fileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`${absolute} is not a valid config:\n${z.prettifyError(result.error)}`);
  }
  const file = result.data;
  checkTemplates(file);

  const githubSecret = env("GITHUB_WEBHOOK_SECRET");
  const slackSigningSecret = env("SLACK_SIGNING_SECRET");
  const linearSecret = env("LINEAR_WEBHOOK_SECRET");

  let slack: SlackSettings | undefined;
  if (slackSigningSecret !== undefined) {
    const botToken = env("SLACK_BOT_TOKEN");
    if (botToken === undefined) {
      throw new ConfigError("SLACK_SIGNING_SECRET is set but SLACK_BOT_TOKEN is missing. Both are required for Slack.");
    }
    slack = {
      path: file.slack?.path ?? DEFAULT_PATHS.slack,
      triggerPhrases: file.slack?.triggerPhrases ?? [],
      allowedAuthors: file.slack?.allowedAuthors ?? [],
      allowedSources: file.slack?.allowedSources,
      replyPrefix: file.slack?.replyPrefix ?? "",
      signingSecret: slackSigningSecret,
      botToken,
      apiUrl: file.slack?.apiUrl,
    };
  }

  return {
    command: file.command,
    cwd: file.cwd === undefined ? process.cwd() : resolvePath(file.cwd),
    env: file.env,
    port: file.port,
    maxPayloadBytes: file.maxPayloadBytes,
    trustedProxies: file.trustedProxies,
    timeoutMs: file.timeoutMs,
    lifecycle: file.lifecycle,
    sessionIdleMs: file.sessionIdleMs,
    replyDebounceMs: file.replyDebounceMs,
    replyDir: file.replyDir === undefined ? undefined : resolvePath(file.replyDir),
    includeRawPayload: file.includeRawPayload,
    logPayloads: file.logPayloads,
    logLevel: file.logLevel,
    maxConcurrentConversations: file.maxConcurrentConversations,
    reactionEmoji: file.reactionEmoji,
    ignoreBots: file.ignoreBots,
    ignoreAuthors: file.ignoreAuthors,
    github:
      githubSecret === undefined
        ? undefined
        : {
            path: file.github?.path ?? DEFAULT_PATHS.github,
            triggerPhrases: requireTriggerPhrases("github", file.github?.triggerPhrases),
            allowedAuthors: file.github?.allowedAuthors ?? [],
            allowedSources: file.github?.allowedSources,
            replyPrefix: file.github?.replyPrefix ?? "",
            webhookSecret: githubSecret,
            auth: readGitHubAuth(),
            apiUrl: file.github?.apiUrl,
          },
    slack,
    linear:
      linearSecret === undefined
        ? undefined
        : {
            path: file.linear?.path ?? DEFAULT_PATHS.linear,
            triggerPhrases: requireTriggerPhrases("linear", file.linear?.triggerPhrases),
            allowedAuthors: file.linear?.allowedAuthors ?? [],
            allowedSources: file.linear?.allowedSources,
            replyPrefix: file.linear?.replyPrefix ?? "",
            webhookSecret: linearSecret,
            apiKey: env("LINEAR_API_KEY"),
            apiUrl: file.linear?.apiUrl,
          },
  };
}
