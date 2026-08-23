import express, { type Application } from "express";
import type { Config } from "./config.ts";
import type { Intake } from "./intake.ts";
import type { Logger } from "./logger.ts";
import { createGitHubMiddleware, githubReactionFor } from "./platforms/github.ts";
import { createLinearMiddleware } from "./platforms/linear.ts";
import { mountSlack } from "./platforms/slack.ts";
import { createPayloadLogger } from "./payload-log.ts";
import { createSizeGate, createSourceGuard, type SourceGuard } from "./request-guard.ts";
import type { Platform } from "./types.ts";

export type Endpoint = { platform: Platform; path: string };

export function createServer(
  config: Config,
  intake: Intake,
  log: Logger,
): { app: Application; endpoints: Endpoint[]; guard: SourceGuard } {
  const app = express();
  const endpoints: Endpoint[] = [];
  const logPayload = createPayloadLogger(config.logPayloads);

  // Note the absence of any app-wide body parser: GitHub and Linear both verify
  // signatures over the raw request stream and must read it themselves.

  // Without this an X-Forwarded-For header from anywhere would be believed, and
  // the source allowlist below could be talked out of its answer by any caller.
  app.set("trust proxy", config.trustedProxies);

  const guard = createSourceGuard(config, log.scoped("source"));
  const sizeGate = createSizeGate(config.maxPayloadBytes, log.scoped("size"));

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
    app.use(config.github.path, sizeGate, guard.middlewareFor("github"));
    app.use(createGitHubMiddleware(config.github, reaction, intake, log.scoped("github"), logPayload));
    endpoints.push({ platform: "github", path: config.github.path });
  }

  if (config.linear !== undefined) {
    if (config.linear.apiKey === undefined) {
      log.warn("LINEAR_API_KEY is not set; Linear mentions will not be acknowledged or replied to");
    }
    app.post(
      config.linear.path,
      sizeGate,
      guard.middlewareFor("linear"),
      createLinearMiddleware(config.linear, config.reactionEmoji, intake, log.scoped("linear"), logPayload),
    );
    endpoints.push({ platform: "linear", path: config.linear.path });
  }

  if (config.slack !== undefined) {
    app.use(config.slack.path, sizeGate, guard.middlewareFor("slack"));
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

  // No index route: it told anyone who asked which platforms were enabled and
  // exactly where to post. The three webhook paths are the whole surface, and
  // the 404 everything else gets is confirmation enough that the process is up.

  return { app, endpoints, guard };
}
