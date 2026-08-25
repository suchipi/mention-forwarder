import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, test } from "node:test";
import express from "express";
import type { Config, GitHubSettings, LinearSettings, SlackSettings } from "../src/config.ts";
import { createLogger } from "../src/logger.ts";
import { createSizeGate, createSourceGuard } from "../src/request-guard.ts";

const silent = createLogger("error");
const open: Server[] = [];

after(() => {
  for (const server of open) server.close();
});

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    command: ["true"],
    cwd: "/tmp",
    env: {},
    port: 0,
    maxPayloadBytes: 5 * 1024 * 1024,
    trustedProxies: ["loopback", "uniquelocal"],
    timeoutMs: 0,
    lifecycle: "per-mention",
    sessionIdleMs: 0,
    replyDebounceMs: 1500,
    replyDir: undefined,
    includeRawPayload: false,
    logPayloads: false,
    logLevel: "error",
    maxConcurrentConversations: 4,
    reactionEmoji: "eyes",
    ignoreBots: true,
    ignoreAuthors: [],
    github: undefined,
    slack: undefined,
    linear: undefined,
    ...overrides,
  };
}

function github(allowedSources: string[] | undefined): GitHubSettings {
  return {
    path: "/github/webhooks",
    triggerPhrases: ["@my-bot"],
    allowedAuthors: [],
    allowedSources,
    apiUrl: undefined,
    webhookSecret: "s",
    auth: { kind: "none" },
  };
}

function slack(allowedSources: string[] | undefined): SlackSettings {
  return {
    path: "/slack/events",
    triggerPhrases: [],
    allowedAuthors: [],
    allowedSources,
    apiUrl: undefined,
    signingSecret: "s",
    botToken: "xoxb-test",
  };
}

/** Linear rather than GitHub wherever `...default` is under test: its list is bundled, so nothing is fetched. */
function linear(allowedSources: string[] | undefined): LinearSettings {
  return {
    path: "/linear/webhooks",
    triggerPhrases: ["@my-bot"],
    allowedAuthors: [],
    allowedSources,
    apiUrl: undefined,
    webhookSecret: "s",
    apiKey: undefined,
  };
}

/** Serves one guarded route and returns its base URL. */
async function serve(build: (app: express.Application) => void): Promise<string> {
  const app = express();
  build(app);
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  open.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

test("a body with no Content-Length is refused before it is read", async () => {
  const url = await serve((app) => {
    app.post("/hook", createSizeGate(1024, silent), (_request, response) => response.send("through"));
  });

  const response = await fetch(`${url}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // A ReadableStream body makes undici send this chunked, with no length up front.
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: string });

  assert.equal(response.status, 411);
});

test("an oversized body is refused, a small one passes", async () => {
  const url = await serve((app) => {
    app.post("/hook", createSizeGate(1024, silent), (_request, response) => response.send("through"));
  });

  const big = await fetch(`${url}/hook`, { method: "POST", body: "x".repeat(2048) });
  assert.equal(big.status, 413);

  const small = await fetch(`${url}/hook`, { method: "POST", body: "x".repeat(16) });
  assert.equal(await small.text(), "through");
});

test("loopback is always allowed, even against a list that excludes it", async () => {
  const guard = createSourceGuard(baseConfig({ github: github(["203.0.113.0/24"]) }), silent);
  const url = await serve((app) => {
    app.set("trust proxy", ["loopback", "uniquelocal"]);
    app.post("/hook", guard.middlewareFor("github"), (_request, response) => response.send("through"));
  });

  const response = await fetch(`${url}/hook`, { method: "POST", body: "{}" });
  assert.equal(await response.text(), "through");
  guard.close();
});

test("a forwarded address decides the verdict when the hop is trusted", async () => {
  const guard = createSourceGuard(baseConfig({ github: github(["203.0.113.0/24"]) }), silent);
  const url = await serve((app) => {
    app.set("trust proxy", ["loopback", "uniquelocal"]);
    app.post("/hook", guard.middlewareFor("github"), (_request, response) => response.send("through"));
  });

  const allowed = await fetch(`${url}/hook`, {
    method: "POST",
    body: "{}",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });
  assert.equal(await allowed.text(), "through");

  const refused = await fetch(`${url}/hook`, {
    method: "POST",
    body: "{}",
    headers: { "x-forwarded-for": "198.51.100.9" },
  });
  assert.equal(refused.status, 403);
  guard.close();
});

test("a forwarded address from an untrusted hop is not believed", async () => {
  const guard = createSourceGuard(baseConfig({ github: github(["203.0.113.0/24"]) }), silent);
  const url = await serve((app) => {
    // No trust proxy: the header is a claim by whoever connected, so it is ignored
    // and the real peer (loopback) decides.
    app.post("/hook", guard.middlewareFor("github"), (_request, response) => response.send("through"));
  });

  const response = await fetch(`${url}/hook`, {
    method: "POST",
    body: "{}",
    headers: { "x-forwarded-for": "198.51.100.9" },
  });
  assert.equal(await response.text(), "through");
  guard.close();
});

test("slack is left unrestricted, because it publishes no ranges", async () => {
  const guard = createSourceGuard(baseConfig({ slack: slack(undefined) }), silent);
  const url = await serve((app) => {
    app.set("trust proxy", ["loopback", "uniquelocal"]);
    app.post("/hook", guard.middlewareFor("slack"), (_request, response) => response.send("through"));
  });

  const response = await fetch(`${url}/hook`, {
    method: "POST",
    body: "{}",
    headers: { "x-forwarded-for": "198.51.100.9" },
  });
  assert.equal(await response.text(), "through");
  assert.match(guard.describe("slack"), /any source/);
  guard.close();
});

test("an IPv6 range is matched, and a mapped IPv4 address is read as IPv4", async () => {
  const guard = createSourceGuard(baseConfig({ github: github(["2606:50c0::/32", "203.0.113.0/24"]) }), silent);
  const url = await serve((app) => {
    app.set("trust proxy", ["loopback", "uniquelocal"]);
    app.post("/hook", guard.middlewareFor("github"), (_request, response) => response.send("through"));
  });

  const v6 = await fetch(`${url}/hook`, {
    method: "POST",
    body: "{}",
    headers: { "x-forwarded-for": "2606:50c0:8000::1" },
  });
  assert.equal(await v6.text(), "through");

  const mapped = await fetch(`${url}/hook`, {
    method: "POST",
    body: "{}",
    headers: { "x-forwarded-for": "::ffff:203.0.113.7" },
  });
  assert.equal(await mapped.text(), "through");
  guard.close();
});

test("an unreadable entry in allowedSources is dropped rather than trusted", async () => {
  const guard = createSourceGuard(baseConfig({ github: github(["not-an-address", "203.0.113.0/24"]) }), silent);
  assert.match(guard.describe("github"), /1 allowed source/);
  guard.close();
});

test('"...default" keeps the built-in list and adds the entries beside it', async () => {
  const guard = createSourceGuard(baseConfig({ linear: linear(["...default", "203.0.113.7"]) }), silent);
  const url = await serve((app) => {
    app.set("trust proxy", ["loopback", "uniquelocal"]);
    app.post("/hook", guard.middlewareFor("linear"), (_request, response) => response.send("through"));
  });

  const post = (from: string): Promise<Response> =>
    fetch(`${url}/hook`, { method: "POST", body: "{}", headers: { "x-forwarded-for": from } });

  // One of Linear's own published addresses, which a plain override would have dropped.
  assert.equal(await (await post("35.231.147.226")).text(), "through");
  assert.equal(await (await post("203.0.113.7")).text(), "through");
  assert.equal((await post("198.51.100.9")).status, 403);
  guard.close();
});

test('"...default" alone matches leaving allowedSources unset', async () => {
  const unset = createSourceGuard(baseConfig({ linear: linear(undefined) }), silent);
  const marker = createSourceGuard(baseConfig({ linear: linear(["...default"]) }), silent);
  assert.equal(marker.describe("linear"), unset.describe("linear"));
  unset.close();
  marker.close();
});

test('a repeated "...default" does not count the built-in list twice', async () => {
  const once = createSourceGuard(baseConfig({ linear: linear(["...default"]) }), silent);
  const twice = createSourceGuard(baseConfig({ linear: linear(["...default", "...default"]) }), silent);
  assert.equal(twice.describe("linear"), once.describe("linear"));
  once.close();
  twice.close();
});

test('"...default" leaves slack unrestricted, because its built-in list is empty', async () => {
  const guard = createSourceGuard(baseConfig({ slack: slack(["...default"]) }), silent);
  assert.match(guard.describe("slack"), /any source/);
  guard.close();
});
