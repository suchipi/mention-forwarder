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

Deliveries move in one direction through five stages, each with a single responsibility:

| Stage | File | Responsibility |
| --- | --- | --- |
| Adapter | `src/platforms/{github,linear,slack}.ts` | Verify the signature, pick out mentions, normalize to a `Candidate`, add the acknowledgement reaction, and know how to post a reply. |
| Intake | `src/intake.ts` | Shared policy for all three: drop duplicates, drop bots and ignored authors, stamp `receivedAt` and `replyFile`, enqueue. |
| Queue | `src/queue.ts` | Serial within a `conversationKey`, parallel across keys, capped at `maxConcurrentConversations`. |
| Runner | `src/runner.ts` | Spawn or reuse the child process and wire up argv, env, and stdin. |
| Mailbox | `src/reply.ts` | Watch reply files and post whatever was appended since the last post. |

`src/cli.ts` wires those together and is the only place that knows the startup order. Adapters never reach into the queue or the runner; they hand `intake` a candidate and a `postReply` closure.

### Raw request bodies are load-bearing

`src/server.ts` deliberately mounts no app-wide body parser. GitHub (`@octokit/webhooks`) and Linear (`@linear/sdk/webhooks`) both verify HMAC-SHA256 over the exact request bytes and read the stream themselves, and Slack's `ExpressReceiver` is handed the Express `app` rather than a `Router` so Bolt scopes its own parser to just `/slack/events`. Adding `express.json()` (or any global parser) silently breaks GitHub and Linear signature verification.

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
- Which platforms are enabled is decided by which secrets are present in the environment; the config file only overrides paths, trigger phrases, and API base URLs. `apiUrl` overrides exist so the simulator and the tests can stand in for a real platform.
- Repo conventions live in `.claude/rules/*.md` and are loaded automatically.

## Tests

`node:test`, no framework. Two kinds:

- **Unit**: `trigger`, `template`, `queue`, `intake`, `reply`, `markdown`. Fast and in-process.
- **Process-level**: `e2e`, `lifecycle`, `streaming-reply`, `github-reply`, `log-payloads`, `simulator`. These spawn the real `src/cli.ts` (and, for `simulator.test.ts`, one simulator per platform), post genuinely signed payloads at it, and assert on what the child process received or what came back through a stand-in platform API.

Process-level tests allocate a free port from the OS and record child-process input into a temp workspace. Assert on asynchronous effects with the `waitFor` polling helpers already in each file rather than a fixed sleep. `test/reply.test.ts` also has `waitUntilWatching`, because `fs.watch` arms asynchronously and a write that lands first is never reported.

## Simulator

`simulator/` is a development-only stand-in for one platform at a time. It serves a web UI of threads, signs real webhooks at a running forwarder, and hosts a fake platform API so replies and reactions land back in the same thread. It imports `src/config.ts`, so both processes read the same config and env files and cannot disagree about secrets, paths, or ports. The secrets in `simulator/forwarder.env` are fake on purpose. See `simulator/README.md`.
