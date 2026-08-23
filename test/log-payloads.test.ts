import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const SECRET = "payload-log-secret";

let port: number;
let forwarder: ReturnType<typeof spawn>;
let output = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      const { port: found } = address;
      probe.close(() => resolve(found));
    });
  });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function send(event: string, delivery: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  return fetch(`http://127.0.0.1:${port}/github/webhooks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": delivery,
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
}

before(async () => {
  const workspace = mkdtempSync(join(tmpdir(), "mention-forwarder-payloads-"));
  port = await freePort();
  writeFileSync(
    join(workspace, "config.json"),
    JSON.stringify({
      command: ["true"],
      port,
      logPayloads: true,
      logLevel: "warn",
      github: { triggerPhrases: ["@my-bot"] },
    }),
  );
  writeFileSync(join(workspace, ".env"), `GITHUB_WEBHOOK_SECRET=${SECRET}\n`);

  forwarder = spawn(
    process.execPath,
    [CLI, "--config", join(workspace, "config.json"), "--env-file", join(workspace, ".env")],
    { cwd: workspace, stdio: ["ignore", "pipe", "pipe"] },
  );
  forwarder.stdout?.setEncoding("utf8");
  forwarder.stderr?.setEncoding("utf8");
  forwarder.stdout?.on("data", (chunk: string) => {
    output += chunk;
  });
  forwarder.stderr?.on("data", (chunk: string) => {
    output += chunk;
  });
  // logLevel is warn here, so the startup banner is suppressed; poll the port instead.
  await waitFor(async () => {
    try {
      // Any answer means the port is bound; the forwarder serves no route at /.
      await fetch(`http://127.0.0.1:${port}/`);
      return true;
    } catch {
      return false;
    }
  }, `startup (got: ${output})`);
});

after(() => {
  forwarder?.kill("SIGKILL");
});

test("logs the payload of a delivery even at logLevel warn", async () => {
  const before = output.length;
  await send("issue_comment", "payload-1", {
    action: "created",
    comment: { body: "@my-bot hello", html_url: "https://x/1", node_id: "N1", user: { login: "suchipi", type: "User" } },
    issue: { number: 3, title: "Some title" },
    repository: { full_name: "acme/widgets" },
  });

  await waitFor(() => output.slice(before).includes("[payload] github issue_comment"), "the payload log line");
  const logged = output.slice(before);
  assert.match(logged, /\[payload\] github issue_comment \(payload-1\)/);
  assert.match(logged, /"full_name": "acme\/widgets"/, "the payload is logged as readable JSON");
  assert.match(logged, /"body": "@my-bot hello"/);
});

test("logs a delivery that matched no trigger phrase", async () => {
  const before = output.length;
  await send("issue_comment", "payload-2", {
    action: "created",
    comment: { body: "nothing to see", html_url: "https://x/2", node_id: "N2", user: { login: "suchipi", type: "User" } },
    issue: { number: 4, title: "Other" },
    repository: { full_name: "acme/widgets" },
  });

  await waitFor(() => output.slice(before).includes("payload-2"), "the non-matching payload log line");
  assert.match(output.slice(before), /"body": "nothing to see"/);
});

test("logs an event type the forwarder does not act on", async () => {
  const before = output.length;
  await send("star", "payload-3", { action: "created", repository: { full_name: "acme/widgets" } });

  await waitFor(() => output.slice(before).includes("payload-3"), "the unhandled event log line");
  assert.match(output.slice(before), /\[payload\] github star \(payload-3\)/);
});
