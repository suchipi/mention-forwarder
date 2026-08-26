#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.ts";
import { createSeenIds } from "./dedupe.ts";
import { createIntake } from "./intake.ts";
import { createLogger } from "./logger.ts";
import { findVaryingPlaceholders } from "./template.ts";
import { createKeyedQueue } from "./queue.ts";
import { createReplyMailbox } from "./reply.ts";
import { createRunner } from "./runner.ts";
import { createServer } from "./server.ts";

const HELP = `mention-forwarder - forward @-mentions from GitHub, Slack, and Linear to a command

Usage: mention-forwarder [options]

Options:
  -c, --config <path>    Config file (default: mention-forwarder.config.json)
      --env-file <path>  File of KEY=value secrets to load (default: .env)
  -h, --help             Show this help

A platform turns on when its secret is present in the environment:
  GitHub  GITHUB_WEBHOOK_SECRET  (+ GITHUB_APP_ID and GITHUB_PRIVATE_KEY_PATH, or GITHUB_TOKEN, to react)
  Slack   SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN
  Linear  LINEAR_WEBHOOK_SECRET  (+ LINEAR_API_KEY to react)
`;

function main(): void {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c", default: "mention-forwarder.config.json" },
      "env-file": { type: "string", default: ".env" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const envFile = resolvePath(values["env-file"]);
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const config = loadConfig(values.config);
  const log = createLogger(config.logLevel);

  if (config.github === undefined && config.slack === undefined && config.linear === undefined) {
    throw new ConfigError(
      `No platforms are enabled. Set at least one of GITHUB_WEBHOOK_SECRET, SLACK_SIGNING_SECRET, or LINEAR_WEBHOOK_SECRET (in ${envFile} or the environment).`,
    );
  }

  if (config.lifecycle === "per-conversation") {
    const varying = findVaryingPlaceholders([...config.command, ...Object.values(config.env)]);
    if (varying.length > 0) {
      log.warn(
        `lifecycle is "per-conversation", so ${varying.map((name) => `{{${name}}}`).join(", ")} ` +
          "will only reflect the first mention of each conversation. Later mentions arrive on stdin only.",
      );
    }
  }

  const replyDir = config.replyDir ?? mkdtempSync(join(tmpdir(), "mention-forwarder-"));
  if (config.replyDir !== undefined) mkdirSync(replyDir, { recursive: true });
  const mailbox = createReplyMailbox(replyDir, config.replyDebounceMs, log.scoped("reply"), config.replyPrefix);

  const runner = createRunner(config, mailbox, log.scoped("command"));
  const queue = createKeyedQueue(config.maxConcurrentConversations, (error) => {
    log.error("task failed", { error: error instanceof Error ? error.message : String(error) });
  });
  const intake = createIntake(config, queue, createSeenIds(2048), mailbox, runner.forward, log);
  const { app, endpoints, guard } = createServer(config, intake, log);

  const server = app.listen(config.port, () => {
    log.info(`listening on http://localhost:${config.port}`);
    for (const { platform, path } of endpoints) {
      const phrases =
        platform === "github"
          ? config.github?.triggerPhrases
          : platform === "linear"
            ? config.linear?.triggerPhrases
            : config.slack?.triggerPhrases;
      const listed = phrases ?? [];
      const trigger =
        platform === "slack" ? ["native mention", ...listed].join(" or ") : listed.join(", ") || "native mention";
      log.info(`  ${platform.padEnd(6)} POST ${path}`, {
        trigger,
        from: guard.describe(platform),
      });
    }
    log.info(`forwarding to: ${config.command.join(" ")}`, {
      cwd: config.cwd,
      lifecycle: config.lifecycle,
      maxConcurrentConversations: config.maxConcurrentConversations,
    });
    log.info(`reply files: ${join(replyDir, "<mention id>.md")}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info(`${signal} received, shutting down`);
      runner.shutdown();
      mailbox.close();
      guard.close();
      server.close(() => process.exit(0));
    });
  }
}

try {
  main();
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}
