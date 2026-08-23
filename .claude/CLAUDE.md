# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

One HTTP port receives webhooks from GitHub, Slack, and Linear, decides which deliveries count as an @-mention of the bot, and forwards each one to a child command configured in `mention-forwarder.config.json`. The command receives the mention three ways at once (argv substitution, stdin JSON, `MENTION_*` env vars) and may answer by appending to a per-mention reply file, which the forwarder posts back into the originating thread.

`README.md` is the user-facing manual and is unusually complete: behavior questions ("what triggers a forward", "where does a reply land", "which scopes does Slack need") are answered there. Read it before inferring behavior from code, and update it when behavior changes.

## Commands

| Command | Notes |
| --- | --- |
| `npm test` | `node --test "test/*.test.ts"`. Around 7s; several tests spawn the real CLI. |
| `node --test test/queue.test.ts` | One file. |
| `node --test --test-name-pattern "coalesces a burst" test/reply.test.ts` | One test. |
| `npm run typecheck` | `tsc --noEmit`. There is no build step and no linter or formatter configured. |
| `npm start` | Needs `mention-forwarder.config.json` and `.env`, both gitignored. Copy the `.example` files. |
| `npm run sim:forwarder` + `npm run sim -- --platform github` | Two terminals; the local end-to-end setup, see [Simulator](#simulator). |

Node 22.18+ is required because the TypeScript sources run directly through Node's type stripping.

## Architecture

Deliveries move in one direction through six stages, each with a single responsibility:

| Stage | File | Responsibility |
| --- | --- | --- |
| Guard | `src/request-guard.ts` | Refuse a request on size or source address before any platform code reads it. |
| Adapter | `src/platforms/{github,linear,slack}.ts` | Verify the signature, pick out mentions, normalize to a `Candidate`, add the acknowledgement reaction, and know how to post a reply. |
| Intake | `src/intake.ts` | Shared policy for all three: scrub NUL bytes, drop duplicates, apply the bot/ignore/allow lists, stamp `receivedAt` and `replyFile`, enqueue. |
| Queue | `src/queue.ts` | Serial within a `conversationKey`, parallel across keys, capped at `maxConcurrentConversations`. |
| Runner | `src/runner.ts` | Spawn or reuse the child process and wire up argv, env, and stdin. |
| Mailbox | `src/reply.ts` | Watch reply files and post whatever was appended since the last post. |

`src/cli.ts` wires those together and is the only place that knows the startup order. Adapters never reach into the queue or the runner; they hand `intake` a candidate and a `postReply` closure.

`src/mentions.ts` sits off to the side of that pipeline: the adapters call it on the way out, never on the way in.

### Raw request bodies are load-bearing

`src/server.ts` deliberately mounts no app-wide body parser. GitHub (`@octokit/webhooks`) and Linear (`@linear/sdk/webhooks`) both verify HMAC-SHA256 over the exact request bytes and read the stream themselves, and Slack's `ExpressReceiver` is handed the Express `app` rather than a `Router` so Bolt scopes its own parser to just `/slack/events`. Adding `express.json()` (or any global parser) silently breaks GitHub and Linear signature verification.

### Everything hostile is stopped before the platform libraries, not by them

All three webhook libraries buffer the whole request body and only then check the signature, so `src/server.ts` mounts the guards from `src/request-guard.ts` ahead of each platform handler. The size gate refuses a body over `maxPayloadBytes`, and one with no `Content-Length` outright, because honouring a chunked upload would mean streaming an unbounded body to find out how big it is.

The source guard is per platform: GitHub's ranges are read from `api.github.com/meta` at boot and daily after, Linear's are bundled constants, and Slack is deliberately unrestricted because Slack publishes no ranges. Loopback always passes, which is what a tunnel arrives on.

Client addresses come from `req.ip` with Express `trust proxy` set from `trustedProxies`. Never read `X-Forwarded-For` directly: believing it unconditionally would let any caller name whatever source address it liked, which is the whole control.

### Replies are rewritten on the way out

`src/mentions.ts` defuses mentions in every reply, because a reply is posted as the bot and usually quotes attacker-controlled text. Slack loses the angle brackets that make a mention live; GitHub and Linear get a zero-width space after the `@`, since neither offers a real escape. Code, links and URLs are skipped so nothing copy-pasteable is altered. Any new reply path must call the matching function.

### `Mention` is a public interface

The `Mention` type in `src/types.ts` is serialized to the child command's stdin, so field names are part of the contract with every user-configured command. Adding or renaming a field means touching all of:

- `src/types.ts` for the shape
- `PLACEHOLDERS` and `fields()` in `src/template.ts`, which is the single source that feeds both `{{placeholder}}` substitution and the `MENTION_*` env vars, so the two can never disagree
- the placeholder and config tables in `README.md`

Unknown `{{placeholders}}` in `command` or `env` are rejected at startup by `checkTemplates` in `src/config.ts`.

### Two lifecycles, two reply modes

`lifecycle` selects which half of `src/runner.ts` runs, and that choice determines how `src/reply.ts` is used:

| | `per-mention` | `per-conversation` |
| --- | --- | --- |
| Runner path | `runOnce` | `deliver` plus `startSession` |
| stdin | One pretty-printed object, then EOF | One compact JSON line per mention, kept open |
| Reply | `mailbox.postOnce` after the process exits | `mailbox.track` watches and posts each debounced batch; `mailbox.finish` flushes at session end |

Read offsets live outside the tracked entries in `src/reply.ts` so that re-tracking a file resumes rather than re-posting. A file that shrank is treated as a rewrite and read from zero.

### `conversationKey` is the concurrency unit

Adapters mint it (`github:owner/repo#7`, `slack:team:channel:thread_ts`, `linear:issueId`), and everything downstream treats it as opaque. It is both the queue key and, under `per-conversation`, the session key.

### Trigger phrases differ by platform

GitHub and Linear webhooks never say "you were mentioned", so `triggerPhrases` is mandatory for them and `src/config.ts` throws when it is missing. Slack is the opposite: a native `app_mention` always counts, and `slack.triggerPhrases` only adds a second route through `message.*` events. Slack delivers a message that both mentions the bot and carries a phrase twice, so the `message` handler in `src/platforms/slack.ts` defers to the `app_mention` handler. DMs need neither a mention nor a phrase.

### Acknowledgement is intake's answer

`intake` returns a boolean, and adapters add the reaction only when it is `true`. Reactions and replies are always best-effort: failures are logged and never stop the command or fail the webhook response.

### Dedupe identity is per platform

`src/dedupe.ts` only compares strings; the adapters decide what identity means. GitHub uses the webhook delivery id, Slack uses `body.event_id`, and Linear composes `linear:<type>:<id>:<updatedAt>` because it has no delivery id of its own.

## Code conventions

- Local imports carry the `.ts` extension (`./config.ts`), since Node runs the sources directly.
- `tsconfig.json` sets `erasableSyntaxOnly` (no enums, namespaces, or parameter properties), `verbatimModuleSyntax` (type-only imports need `import type`), `strict`, and `noUncheckedIndexedAccess`.
- Which platforms are enabled is decided by which secrets are present in the environment; the config file only overrides per-platform details (paths, trigger phrases, allowed authors and sources, API base URLs). `apiUrl` overrides exist so the simulator and the tests can stand in for a real platform.
- The three platform blocks share a `platformOverrides` schema and a `CommonSettings` type in `src/config.ts`. A setting that applies to all three belongs there, not copied into each.
- Repo conventions live in `.claude/rules/*.md` and are loaded automatically.

## Tests

`node:test`, no framework. Two kinds:

- **Unit**: `trigger`, `template`, `queue`, `intake`, `reply`, `markdown`, `mentions`, `request-guard`. Fast and in-process. `request-guard.test.ts` stands up a throwaway Express app rather than the CLI, and drives the source check by sending `X-Forwarded-For` from loopback, which `trust proxy` believes.
- **Process-level**: `e2e`, `lifecycle`, `streaming-reply`, `github-reply`, `log-payloads`, `simulator`. These spawn the real `src/cli.ts` (and, for `simulator.test.ts`, one simulator per platform), post genuinely signed payloads at it, and assert on what the child process received or what came back through a stand-in platform API.

Process-level tests allocate a free port from the OS and record child-process input into a temp workspace. Assert on asynchronous effects with the `waitFor` polling helpers already in each file rather than a fixed sleep. `test/reply.test.ts` also has `waitUntilWatching`, because `fs.watch` arms asynchronously and a write that lands first is never reported.

Nothing in the suite may touch the network. `test/e2e.test.ts` pins `github.allowedSources` for exactly that reason: without it the source guard would fetch `api.github.com/meta` mid-test.

A startup probe waits for the port to answer, never for a `2xx`. There is no route at `/`, so `fetch(...).ok` there is always false and a probe written that way spins until it times out.

## Simulator

`simulator/` is a development-only stand-in for one platform at a time. It serves a web UI of threads, signs real webhooks at a running forwarder, and hosts a fake platform API so replies and reactions land back in the same thread. It imports `src/config.ts`, so both processes read the same config and env files and cannot disagree about secrets, paths, or ports. The secrets in `simulator/forwarder.env` are fake on purpose. See `simulator/README.md`.

It binds `127.0.0.1` by default, and `--host` is the only way off that. Posting through it signs a webhook that runs the forwarder's command and nothing asks who is posting, so the binding is what stands between that and the network. The forwarder's own port keeps binding every interface, since the three platforms have to reach it; `src/request-guard.ts` is what defends that one.

The simulator has no config file of its own. Its settings are CLI flags, and the JSON file it reads belongs to the forwarder and is validated by a `z.strictObject`, so a simulator-only key cannot be added there without changing the forwarder's schema.
