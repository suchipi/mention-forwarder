import { type ChildProcess, spawn } from "node:child_process";
import type { Config } from "./config.ts";
import type { Delivery } from "./intake.ts";
import type { Logger } from "./logger.ts";
import type { ReplyMailbox } from "./reply.ts";
import { envVars, render } from "./template.ts";
import type { Mention } from "./types.ts";

export type Runner = {
  forward(delivery: Delivery): Promise<void>;
  shutdown(): void;
};

type Session = {
  child: ChildProcess;
  alive: boolean;
  idleTimer: NodeJS.Timeout | undefined;
  /** Reply files of every mention this session has been given, flushed when it ends. */
  replyFiles: Set<string>;
};

function pipeLines(log: Logger, id: string, stream: string, source: NodeJS.ReadableStream): void {
  let buffered = "";
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) log.info(`${stream}: ${line}`, { id });
  });
  source.on("end", () => {
    if (buffered !== "") log.info(`${stream}: ${buffered}`, { id });
  });
}

export function createRunner(config: Config, mailbox: ReplyMailbox, log: Logger): Runner {
  const sessions = new Map<string, Session>();

  /** Argv, env, and cwd are all fixed at spawn time from whichever mention started the process. */
  function spawnChild(mention: Mention, label: string): { child: ChildProcess; program: string; argv: string[] } {
    const argv = config.command.map((part) => render(part, mention));
    const [program, ...args] = argv as [string, ...string[]];

    const extraEnv: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.env)) extraEnv[name] = render(value, mention);

    const child = spawn(program, args, {
      cwd: config.cwd,
      env: { ...process.env, ...extraEnv, ...envVars(mention) },
      stdio: ["pipe", "pipe", "pipe"],
      ...(config.timeoutMs > 0 ? { timeout: config.timeoutMs, killSignal: "SIGTERM" as const } : {}),
    });

    if (child.stdout) pipeLines(log, label, "stdout", child.stdout);
    if (child.stderr) pipeLines(log, label, "stderr", child.stderr);

    // A command that never reads stdin closes the pipe early; that EPIPE is
    // expected, and unhandled it would take down the whole forwarder.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") log.warn("could not write to command stdin", { id: label, error: error.message });
    });

    return { child, program, argv };
  }

  function explainSpawnFailure(error: NodeJS.ErrnoException, program: string, label: string): void {
    const hint = error.code === "ENOENT" ? ` — is "${program}" installed and on PATH?` : "";
    log.error(`command failed to start: ${error.message}${hint}`, { id: label });
  }

  function runOnce({ mention, postReply }: Delivery): Promise<void> {
    return new Promise<void>((done) => {
      const startedAt = Date.now();
      const { child, program, argv } = spawnChild(mention, mention.id);
      log.info("running command", { id: mention.id, url: mention.url, argv });

      // Pretty-printed and then closed: the command receives exactly one mention.
      child.stdin?.end(`${JSON.stringify(mention, null, 2)}\n`);

      child.on("error", (error: NodeJS.ErrnoException) => {
        explainSpawnFailure(error, program, mention.id);
        done();
      });

      child.on("close", (code, signal) => {
        const fields = { id: mention.id, code, signal, durationMs: Date.now() - startedAt };
        if (code === 0) log.info("command finished", fields);
        else log.error("command exited non-zero", fields);
        // The command has exited, so whatever it left in the reply file is final.
        mailbox.postOnce(mention.replyFile, postReply).finally(done);
      });
    });
  }

  function endSession(key: string, session: Session): void {
    session.alive = false;
    for (const replyFile of session.replyFiles) void mailbox.finish(replyFile);
    session.replyFiles.clear();
    // Only if it is still the current one: a dead child's `close` can arrive after
    // a replacement has already been registered under the same key.
    if (sessions.get(key) === session) sessions.delete(key);
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    session.child.stdin?.end();
  }

  function touchIdleTimer(key: string, session: Session): void {
    if (config.sessionIdleMs <= 0) return;
    if (session.idleTimer !== undefined) clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      log.info("closing idle session", { conversation: key, idleMs: config.sessionIdleMs });
      endSession(key, session);
      session.child.kill("SIGTERM");
    }, config.sessionIdleMs);
    session.idleTimer.unref();
  }

  function startSession(key: string, mention: Mention): Session {
    const startedAt = Date.now();
    const { child, program, argv } = spawnChild(mention, key);
    const session: Session = { child, alive: true, idleTimer: undefined, replyFiles: new Set() };
    sessions.set(key, session);
    log.info("starting session", { conversation: key, argv, liveSessions: sessions.size });

    child.on("error", (error: NodeJS.ErrnoException) => {
      explainSpawnFailure(error, program, key);
      endSession(key, session);
    });

    child.on("close", (code, signal) => {
      const fields = { conversation: key, code, signal, durationMs: Date.now() - startedAt };
      if (code === 0) log.info("session ended", fields);
      else log.error("session exited non-zero", fields);
      endSession(key, session);
    });

    return session;
  }

  function isUsable(session: Session): boolean {
    const { child } = session;
    return session.alive && child.exitCode === null && child.signalCode === null && child.stdin?.writable === true;
  }

  function writeLine(key: string, session: Session, mention: Mention): Promise<void> {
    return new Promise<void>((done) => {
      const stdin = session.child.stdin;
      if (stdin === null || stdin === undefined || stdin.destroyed) {
        log.warn("session stdin is not writable; dropping mention", { conversation: key, id: mention.id });
        endSession(key, session);
        return done();
      }
      // One compact object per line: a long-lived command reads a stream, and only
      // newline-delimited JSON can be split back apart reliably.
      stdin.write(`${JSON.stringify(mention)}\n`, (error) => {
        if (error) {
          log.warn("could not write mention to session", { conversation: key, id: mention.id, error: error.message });
          endSession(key, session);
        }
        done();
      });
    });
  }

  async function deliver({ mention, postReply }: Delivery): Promise<void> {
    const key = mention.conversationKey;
    let session = sessions.get(key);
    if (session !== undefined && !isUsable(session)) {
      endSession(key, session);
      session = undefined;
    }
    if (session === undefined) session = startSession(key, mention);

    log.info("forwarding to session", { conversation: key, id: mention.id, url: mention.url });
    session.replyFiles.add(mention.replyFile);
    mailbox.track(mention.replyFile, postReply);
    await writeLine(key, session, mention);
    if (session.alive) touchIdleTimer(key, session);
  }

  return {
    forward: config.lifecycle === "per-conversation" ? deliver : runOnce,
    shutdown() {
      for (const [key, session] of sessions) {
        endSession(key, session);
        session.child.kill("SIGTERM");
      }
    },
  };
}
