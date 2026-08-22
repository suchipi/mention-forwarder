import express, { type Application } from "express";
import type { Config } from "./config.ts";
import type { Intake } from "./intake.ts";
import type { Logger } from "./logger.ts";
import { createGitHubMiddleware, githubReactionFor } from "./platforms/github.ts";
import { createLinearMiddleware } from "./platforms/linear.ts";
import { mountSlack } from "./platforms/slack.ts";
import { createPayloadLogger } from "./payload-log.ts";

export type Endpoint = { platform: string; path: string };

export function createServer(
  config: Config,
  intake: Intake,
  log: Logger,
): { app: Application; endpoints: Endpoint[] } {
  const app = express();
  const endpoints: Endpoint[] = [];
  const logPayload = createPayloadLogger(config.logPayloads);

  // Note the absence of any app-wide body parser: GitHub and Linear both verify
  // signatures over the raw request stream and must read it themselves.

  if (config.github !== undefined) {
    if (config.github.auth.kind === "none") {
      log.warn(
        "no GitHub credentials found; GitHub mentions will not be acknowledged or replied to. " +
          "Set GITHUB_TOKEN, or GITHUB_APP_ID with a private key.",
      );
    }
    const reaction = githubReactionFor(config.reactionEmoji);
    if (reaction === undefined) {
      log.warn(`reactionEmoji ":${config.reactionEmoji}:" has no GitHub equivalent; GitHub mentions will not be acknowledged`);
    }
    app.use(createGitHubMiddleware(config.github, reaction, intake, log.scoped("github"), logPayload));
    endpoints.push({ platform: "github", path: config.github.path });
  }

  if (config.linear !== undefined) {
    if (config.linear.apiKey === undefined) {
      log.warn("LINEAR_API_KEY is not set; Linear mentions will not be acknowledged or replied to");
    }
    app.post(
      config.linear.path,
      createLinearMiddleware(config.linear, config.reactionEmoji, intake, log.scoped("linear"), logPayload),
    );
    endpoints.push({ platform: "linear", path: config.linear.path });
  }

  if (config.slack !== undefined) {
    mountSlack(
      config.slack,
      app,
      { reactionEmoji: config.reactionEmoji, logLevel: config.logLevel },
      intake,
      log.scoped("slack"),
      logPayload,
    );
    endpoints.push({ platform: "slack", path: config.slack.path });
  }

  app.get("/", (_request, response) => {
    response.json({ ok: true, endpoints });
  });

  return { app, endpoints };
}
