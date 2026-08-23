import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { findUnknownPlaceholders, PLACEHOLDERS } from "./template.ts";
import type { Level } from "./logger.ts";

export class ConfigError extends Error {}

const platformOverrides = z.strictObject({
  path: z.string().startsWith("/").optional(),
  triggerPhrases: z.array(z.string().min(1)).optional(),
  /** Only these authors may trigger the command. Absent or empty means anyone may. */
  allowedAuthors: z.array(z.string().min(1)).optional(),
  /** Addresses or CIDR ranges this platform's webhooks may arrive from. Replaces the built-in list. */
  allowedSources: z.array(z.string().min(1)).optional(),
});

const githubOverrides = platformOverrides.extend({
  /** Override the GitHub API base URL; for GitHub Enterprise Server or a local stub. */
  apiUrl: z.string().url().optional(),
});

const slackOverrides = platformOverrides.extend({
  /** Override the Slack API base URL; for Enterprise Grid or a local stub. */
  apiUrl: z.string().url().optional(),
});

const linearOverrides = platformOverrides.extend({
  /** Override the Linear GraphQL endpoint; for a local stub. */
  apiUrl: z.string().url().optional(),
});

const fileSchema = z.strictObject({
  command: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  port: z.number().int().min(1).max(65535).default(3000),
  maxPayloadBytes: z.number().int().min(1024).default(5 * 1024 * 1024),
  /** Hops whose X-Forwarded-For may be believed, as Express understands them. */
  trustedProxies: z.array(z.string().min(1)).default(["loopback", "uniquelocal"]),
  timeoutMs: z.number().int().min(0).default(0),
  lifecycle: z.enum(["per-mention", "per-conversation"]).default("per-mention"),
  sessionIdleMs: z.number().int().min(0).default(0),
  replyDebounceMs: z.number().int().min(0).default(1500),
  replyDir: z.string().optional(),
  includeRawPayload: z.boolean().default(false),
  logPayloads: z.boolean().default(false),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  maxConcurrentConversations: z.number().int().min(1).default(4),
  reactionEmoji: z.string().min(1).default("eyes"),
  ignoreBots: z.boolean().default(true),
  ignoreAuthors: z.array(z.string()).default([]),
  github: githubOverrides.optional(),
  slack: slackOverrides.optional(),
  linear: linearOverrides.optional(),
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
            webhookSecret: linearSecret,
            apiKey: env("LINEAR_API_KEY"),
            apiUrl: file.linear?.apiUrl,
          },
  };
}
