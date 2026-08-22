import { fileURLToPath } from "node:url";
import express, { type Application } from "express";
import type { Logger } from "../src/logger.ts";
import type { Store } from "./store.ts";
import type { PlatformSim, PostRequest } from "./types.ts";

const UI_PAGE = fileURLToPath(new URL("./ui.html", import.meta.url));
const MARKDOWN_MODULE = fileURLToPath(new URL("./markdown.js", import.meta.url));

/** Everything the page needs to explain the setup it is driving. */
export type SimInfo = {
  forwarderUrl: string;
  webhookUrl: string;
  expectedApiUrl: string;
  configuredApiUrl: string | undefined;
};

export function createSimServer(sim: PlatformSim, store: Store, info: SimInfo, log: Logger): Application {
  const app = express();

  app.use(sim.apiMount, sim.api);

  // Read from disk per request, so editing the page only needs a browser refresh.
  app.get("/", (_request, response) => {
    response.sendFile(UI_PAGE);
  });

  app.get("/markdown.js", (_request, response) => {
    response.sendFile(MARKDOWN_MODULE);
  });

  app.get("/sim/state", (_request, response) => {
    response.json({
      platform: sim.platform,
      version: store.version,
      threads: sim.threads,
      authors: sim.authors,
      composerPrefix: sim.composerPrefix,
      mentionNames: sim.mentionNames ?? {},
      messages: store.messages,
      info,
    });
  });

  app.post("/sim/post", express.json(), (request, response) => {
    const body = request.body as Partial<PostRequest>;
    if (
      typeof body.threadId !== "string" ||
      typeof body.kind !== "string" ||
      typeof body.authorId !== "string" ||
      typeof body.text !== "string"
    ) {
      response.status(400).json({ error: "threadId, kind, authorId, and text are all required" });
      return;
    }
    void sim
      .post({ threadId: body.threadId, kind: body.kind, authorId: body.authorId, text: body.text })
      .then(() => response.json({ ok: true }))
      .catch((error: Error) => {
        log.error("could not send the webhook", { error: error.message });
        response.status(500).json({ error: error.message });
      });
  });

  app.post("/sim/clear", (_request, response) => {
    store.clear();
    response.json({ ok: true });
  });

  return app;
}
