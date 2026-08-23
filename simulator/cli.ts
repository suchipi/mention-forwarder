#!/usr/bin/env node
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import type { Platform } from "../src/types.ts";
import { createGitHubSim } from "./platforms/github.ts";
import { createLinearSim } from "./platforms/linear.ts";
import { createSlackSim } from "./platforms/slack.ts";
import { createSimServer } from "./server.ts";
import { createStore } from "./store.ts";
import type { PlatformSim } from "./types.ts";

const DEFAULT_CONFIG = fileURLToPath(new URL("./forwarder.config.json", import.meta.url));
const DEFAULT_ENV = fileURLToPath(new URL("./forwarder.env", import.meta.url));

const HELP = `mention-forwarder simulator - exercise the webhooks by hand, with no real GitHub, Slack, or Linear

Usage: node simulator/cli.ts --platform <github|slack|linear> [options]

It serves a web UI of threads. Posting in one signs a webhook and sends it to a running
forwarder; the forwarder's replies and reactions come back through a stand-in platform
API and land in the same thread.

Options:
  -p, --platform <name>  Which platform to imitate. Defaults to the only enabled one.
      --port <number>    Port for the UI and the stand-in API (default: 4000)
      --host <address>   Address to bind (default: 127.0.0.1). Pass 0.0.0.0 to accept
                         connections from other machines, which lets anyone who can
                         reach this port run the forwarder's command.
  -c, --config <path>    The forwarder's config file (default: simulator/forwarder.config.json)
      --env-file <path>  The forwarder's env file (default: simulator/forwarder.env)
      --forwarder <url>  Where the forwarder listens (default: http://127.0.0.1:<the config's port>)
  -h, --help             Show this help

Start the forwarder against the same two files, so both sides agree on secrets and paths:
  node src/cli.ts --config simulator/forwarder.config.json --env-file simulator/forwarder.env
`;

const PLATFORMS: Platform[] = ["github", "slack", "linear"];

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Where to dial the simulator once it is bound: every interface still answers on loopback. */
function reachableHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
  return host.includes(":") ? `[${host}]` : host;
}

function chosenPlatform(requested: string | undefined, enabled: Platform[]): Platform {
  if (requested !== undefined) {
    if (!(PLATFORMS as string[]).includes(requested)) {
      throw new ConfigError(`Unknown platform "${requested}". Choose one of: ${PLATFORMS.join(", ")}.`);
    }
    if (!enabled.includes(requested as Platform)) {
      throw new ConfigError(
        `${requested} is not enabled: its secret is missing from the env file, so the forwarder is not listening for it either.`,
      );
    }
    return requested as Platform;
  }
  if (enabled.length === 0) throw new ConfigError("No platforms are enabled. Check the env file for the webhook secrets.");
  const [only] = enabled;
  if (enabled.length > 1 || only === undefined) {
    throw new ConfigError(`Pass --platform: ${enabled.join(", ")} are all enabled, and a simulator imitates one of them.`);
  }
  return only;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      platform: { type: "string", short: "p" },
      port: { type: "string", default: "4000" },
      host: { type: "string", default: "127.0.0.1" },
      config: { type: "string", short: "c", default: DEFAULT_CONFIG },
      "env-file": { type: "string", default: DEFAULT_ENV },
      forwarder: { type: "string" },
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
  const log = createLogger(config.logLevel, "simulator");

  const enabled = PLATFORMS.filter((platform) => config[platform] !== undefined);
  const platform = chosenPlatform(values.platform, enabled);

  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`--port ${values.port} is not a port.`);
  if (port === config.port) {
    throw new ConfigError(`--port ${port} is the forwarder's own port; the simulator needs one of its own.`);
  }

  const host = values.host.trim();
  if (host === "") throw new ConfigError("--host cannot be empty.");

  const simUrl = `http://${reachableHost(host)}:${port}`;
  const forwarderUrl = (values.forwarder ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, "");
  const store = createStore();
  const shared = { forwarderUrl, simUrl, botName: "sim-bot", store, log: log.scoped(platform) };

  function createSim(): PlatformSim {
    if (platform === "github" && config.github !== undefined) return createGitHubSim({ settings: config.github, ...shared });
    if (platform === "slack" && config.slack !== undefined) return createSlackSim({ settings: config.slack, ...shared });
    if (platform === "linear" && config.linear !== undefined) return createLinearSim({ settings: config.linear, ...shared });
    throw new ConfigError(`${platform} is not enabled`);
  }

  const sim = createSim();

  // Both processes are usually started at the same moment, so one retry keeps a forwarder
  // that is still binding its port from looking like one that was never started.
  async function probeForwarder(): Promise<void> {
    try {
      await fetch(`${forwarderUrl}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    try {
      await fetch(`${forwarderUrl}/`);
    } catch (error) {
      log.warn(`the forwarder does not answer at ${forwarderUrl}: ${(error as Error).message}`);
    }
  }

  const configuredApiUrl = config[platform]?.apiUrl;
  const info = { forwarderUrl, webhookUrl: sim.webhookUrl, expectedApiUrl: sim.expectedApiUrl, configuredApiUrl };

  createSimServer(sim, store, info, log).listen(port, host, () => {
    log.info(`simulating ${sim.platform}; open ${simUrl}`);
    log.info(`  webhooks     POST ${sim.webhookUrl}`);
    log.info(`  stand-in API ${sim.expectedApiUrl}`);
    if (!LOOPBACK.has(host)) {
      log.warn(
        `bound to ${host} rather than loopback. Posting in this simulator runs the forwarder's command, and nothing ` +
          "here asks who is posting, so anyone who can reach this port can run it.",
      );
    }
    if (configuredApiUrl !== sim.expectedApiUrl) {
      log.warn(
        `${sim.platform}.apiUrl is ${configuredApiUrl ?? "unset"} in ${values.config}, so replies and reactions will ` +
          `not come back here. Set it to ${sim.expectedApiUrl} and restart the forwarder.`,
      );
    }
    void probeForwarder();
  });
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
