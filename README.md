# mention-forwarder

When someone @-mentions your bot on GitHub, Slack, or Linear, this runs a command line program of your choosing and hands it the comment text plus a link back to where it came from.

It has no opinion about what your command does — pipe the mention into an AI agent, append it to a file, open a ticket, whatever. If the command wants to answer, it writes to a file and the forwarder posts that back where the mention came from.

```
GitHub  ──┐                                argv + stdin JSON + MENTION_* env vars
Slack   ──┤──▶  mention-forwarder  ──▶  your command
Linear  ──┘      (one HTTP port)     ◀──  a reply file it may write into
```

Your command chooses how much of that to use. It can ignore the reply file entirely and stay silent, run once per mention or stay resident for a whole conversation, and read the mention from argv, stdin, or the environment.

## Requirements

- **Node.js 22.18 or newer.** The source is TypeScript and runs directly — Node strips the types itself, so there is no build step. Check with `node --version`.
- A way to expose one local port to the internet, so the three platforms can reach your machine. See [Exposing your machine](#exposing-your-machine).

## Quick start

```sh
git clone <this repo> && cd mention-forwarder
npm install
cp mention-forwarder.config.example.json mention-forwarder.config.json
cp .env.example .env
```

Then edit the two files you just copied:

- `mention-forwarder.config.json` — what to run, and which phrase counts as a mention.
- `.env` — the secrets. **A platform switches on when its secret is present**, so delete the blocks you don't want.

Start it:

```sh
npm start
```

```
2026-08-19T18:00:00.000Z INFO  listening on http://localhost:3000
2026-08-19T18:00:00.000Z INFO    github POST /github/webhooks trigger=@my-bot
2026-08-19T18:00:00.000Z INFO    linear POST /linear/webhooks trigger=@my-bot
2026-08-19T18:00:00.000Z INFO    slack  POST /slack/events trigger=native mention
2026-08-19T18:00:00.000Z INFO  forwarding to: claude -p {{prompt}} cwd=/Users/you/Code/mention-forwarder maxConcurrentConversations=4
```

Those three paths are the whole surface: every other URL, `/` included, gets a `404`. That is still the quickest way to confirm your tunnel reaches the process, since a `404` means the request got all the way to the forwarder, while a timeout or a tunnel error page means it did not.

Before wiring up a real agent, point `command` at `["cat"]`. Every forwarded mention will then be echoed into the log as JSON, so you can see precisely what your command would have received.

## How your command receives the mention

Every mention is delivered three ways at once. Use whichever suits the program you're calling.

**1. Standard input** — the whole mention as pretty-printed JSON, then EOF:

```json
{
  "id": "a1b2c3d4-...",
  "platform": "github",
  "kind": "issue_comment",
  "url": "https://github.com/acme/widgets/issues/7#issuecomment-100",
  "text": "@my-bot please fix the flaky test",
  "prompt": "please fix the flaky test",
  "author": "suchipi",
  "title": "Flaky test in CI",
  "conversationKey": "github:acme/widgets#7",
  "receivedAt": "2026-08-19T18:00:00.000Z",
  "replyFile": "/var/folders/../mention-forwarder-Xy12aB/a1b2c3d4.md"
}
```

**2. Environment variables** — one per field, `MENTION_` prefixed and upper-cased: `MENTION_PLATFORM`, `MENTION_KIND`, `MENTION_URL`, `MENTION_TEXT`, `MENTION_PROMPT`, `MENTION_AUTHOR`, `MENTION_TITLE`, `MENTION_ID`, `MENTION_CONVERSATION_KEY`, `MENTION_RECEIVED_AT`, `MENTION_REPLY_FILE`, `MENTION_JSON`.

**3. Argument substitution** — any `{{placeholder}}` in `command` or in an `env` value is replaced before the process starts:

```json
"command": ["claude", "-p", "Handle this mention from {{url}}:\n\n{{prompt}}"]
```

Arguments are passed as an array, never through a shell, so nothing in a comment body can be interpreted as a command. If you genuinely want shell semantics, ask for them explicitly with `["sh", "-c", "..."]` — and remember that a comment body is attacker-controlled text.

### Placeholders

| Placeholder | Meaning |
| --- | --- |
| `{{text}}` | The comment or message body, verbatim. |
| `{{prompt}}` | `text` with the mention itself removed — usually what you want to feed an agent. |
| `{{url}}` | Permalink to the comment that did the mentioning. |
| `{{platform}}` | `github`, `slack`, or `linear`. |
| `{{kind}}` | The specific event, e.g. `issue_comment`, `pull_request_review_comment`, `app_mention`. |
| `{{author}}` | Who wrote it — a GitHub login, a Slack display name, a Linear user name. |
| `{{title}}` | Issue or PR title; the Slack channel id for Slack. Empty when the platform gives none. |
| `{{conversationKey}}` | Identifies the thread. Mentions sharing one are handled in order; see [Concurrency](#concurrency). |
| `{{id}}` | Unique per delivery. Useful as a log or work-directory name. |
| `{{receivedAt}}` | ISO 8601 timestamp. |
| `{{replyFile}}` | Path to write a reply into. See [Replying](#replying). |
| `{{json}}` | The entire mention as one JSON string. |

A misspelled placeholder is reported at startup rather than silently forwarded as literal text.

## Command lifecycles

`lifecycle` decides whether your command is started fresh for every mention or kept running for a whole conversation.

| | `per-mention` (default) | `per-conversation` |
| --- | --- | --- |
| Process | A new one per mention | One per conversation, reused |
| stdin | One pretty-printed JSON object, then EOF | One compact JSON object per line, kept open |
| argv and env | Reflect that mention | Fixed by the mention that started the process |
| Ends when | The command exits | It exits on its own, or `sessionIdleMs` passes |

**`per-mention`** suits a command that does one job and exits — the shape most CLI tools already have. Two mentions on the same PR run one after another, never at the same time.

**`per-conversation`** suits an agent that should keep its own context for a thread. The first mention starts the process; every later mention in that same conversation is written to its stdin as one more line. Because argv and the environment are fixed when the process starts, **a long-lived command must read stdin** — the forwarder warns at startup if `command` uses a placeholder that changes between mentions.

A long-lived process is never killed for you unless you ask: set `sessionIdleMs` to close a session after a stretch with no new mentions, or give the command its own exit condition. Without either, one process stays alive per conversation the forwarder has seen, so watch the `liveSessions` count in the log.

Newline-delimited JSON is what makes the streaming case workable — a reader can split on newlines and parse each line, which pretty-printed JSON would not allow:

```js
// a per-conversation command
import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  const mention = JSON.parse(line);
  // ... handle mention, and optionally append to mention.replyFile
}
```

## Replying

Every mention comes with `replyFile`, a path unique to that mention inside a temporary directory (printed at startup). The file does not exist until your command creates it. **Append your answer to it and the forwarder posts it back where the mention came from.** Write nothing and nothing is posted — silence is the default.

```sh
# the whole protocol, from a shell command
echo "On it — I'll open a PR shortly." >> "$MENTION_REPLY_FILE"
```

Each posted reply contains **only the text added since the previous one**, so an agent can append progress as it goes without repeating itself. The forwarder never edits or deletes your file; it just remembers how far it has read. If your command truncates and rewrites the file instead, that works too — a file that shrank is treated as a fresh reply.

When the reply is read depends on the lifecycle:

- **`per-mention`** — the file is read once, after the command exits. One reply per mention.
- **`per-conversation`** — the file is watched. Once writes stop for `replyDebounceMs` (default 1500ms), whatever was added is posted, and the watch continues, so a single mention can produce a running series of replies. Anything still unposted is flushed when the session ends.

### Where replies land

| Mention was in | The reply appears as |
| --- | --- |
| GitHub issue or PR comment | A new comment on that issue or PR |
| GitHub **inline review comment** | A reply inside that same review thread |
| GitHub review summary | A comment on the PR conversation — a review body has no thread of its own |
| GitHub commit comment | Another comment on that commit |
| GitHub discussion comment | A discussion comment, threaded under the comment that mentioned you, or under that comment's parent when the mention is itself a reply: GitHub threads discussions only one level deep |
| Slack channel mention | A threaded reply under the message |
| Slack DM | The next message in that DM |
| Linear comment | A threaded reply under the top-level comment |

Replying needs write credentials, the same ones the acknowledgement reaction uses: a GitHub App or token, a Slack bot token with `chat:write`, and `LINEAR_API_KEY`. A reply that fails is logged and never stops the command.

### Replies never mention anyone

A reply goes out under the bot's identity, so a mention inside one would notify a real person, and the text often quotes whoever wrote the comment. Mentions are therefore defused on the way out, whatever your command wrote:

- **Slack.** `<!channel>`, `<!here>`, `<!everyone>`, `<@U…>`, `<#C…>` and `<!subteam^…>` lose their brackets and go out as `@channel`, `@name`, `#name`. Only the bracketed forms ever notified anyone, so emphasis, code, quotes and `<url|label>` links are untouched.
- **GitHub and Linear.** `@name` and `@org/team` keep their spelling but gain a zero-width space after the `@`, which is the only thing either platform respects: a backslash does not escape `@` in a GitHub comment. Code spans, fenced blocks, links and bare URLs are left exactly as written, since a mention was never live inside them anyway.

Nothing else about the text changes, and a reply that mentions nobody goes out byte for byte.

## Config reference

Everything lives in `mention-forwarder.config.json`. Only `command` is required.

| Field | Default | Meaning |
| --- | --- | --- |
| `command` | *required* | Argv array. `command[0]` is the program; it must be on `PATH` or an absolute path. |
| `cwd` | the forwarder's directory | Working directory for the command. |
| `env` | `{}` | Extra environment variables. Values may use `{{placeholders}}`. |
| `port` | `3000` | The single port all three platforms post to. |
| `maxPayloadBytes` | `5242880` (5 MiB) | Largest webhook body to accept. Anything bigger, or anything sent without a `Content-Length`, is refused before it is read. See [Who can reach it](#who-can-reach-it). |
| `trustedProxies` | `["loopback", "uniquelocal"]` | Which hops may be believed when they set `X-Forwarded-For`. Anything Express accepts for `trust proxy` works here. |
| `lifecycle` | `"per-mention"` | `per-mention` starts the command fresh each time; `per-conversation` keeps one running per thread. See [Command lifecycles](#command-lifecycles). |
| `sessionIdleMs` | `0` | `per-conversation` only: close a session after this long with no new mentions. `0` keeps it alive indefinitely. |
| `replyDebounceMs` | `1500` | `per-conversation` only: how long writes to a reply file must settle before it is posted. |
| `replyDir` | a fresh temp directory | Where reply files live. Set it if you want to inspect them. |
| `timeoutMs` | `0` | Kill the command after this many milliseconds. `0` means never — the right choice for a long-running agent. In `per-conversation` mode this caps a session's total lifetime. |
| `includeRawPayload` | `false` | Add the platform's untouched webhook payload as `raw` in the stdin JSON. |
| `logPayloads` | `false` | Log every incoming delivery as pretty-printed JSON — including ones that matched no trigger phrase, and event types the forwarder doesn't act on. Independent of `logLevel`, so turning it on is enough on its own. |
| `logLevel` | `"info"` | `debug`, `info`, `warn`, or `error`. |
| `maxConcurrentConversations` | `4` | How many different threads may be in flight at once. |
| `reactionEmoji` | `"eyes"` | Emoji name used to acknowledge a mention. |
| `ignoreBots` | `true` | Skip mentions written by bots. Keep this on — it is what stops your agent from re-triggering itself. |
| `ignoreAuthors` | `[]` | Additional author names or logins to skip. |
| `github.triggerPhrases` | *required if GitHub is on* | Phrases that count as a mention, e.g. `["@my-bot"]`. |
| `github.path` | `/github/webhooks` | Route GitHub posts to. |
| `linear.triggerPhrases` | *required if Linear is on* | As above. |
| `linear.path` | `/linear/webhooks` | Route Linear posts to. |
| `slack.triggerPhrases` | `[]` | An optional *second* way in, not a filter: a real mention always counts, and so does any message carrying one of these. Needs extra subscriptions; see [Slack](#slack). |
| `slack.path` | `/slack/events` | Route Slack posts to. |
| `<platform>.allowedAuthors` | `[]` | Only these authors may trigger the command on that platform. Empty means anyone may. Matched case-insensitively; [What `allowedAuthors` matches](#what-allowedauthors-matches) says exactly which name each platform hands over. |
| `<platform>.allowedSources` | its published ranges | Addresses or CIDR ranges that platform's webhooks may arrive from. Replaces the built-in list; an empty list means no source check at all, and loopback always passes either way. See [Who can reach it](#who-can-reach-it). |
| `github.apiUrl` | GitHub's own | Override the GitHub API base URL. For GitHub Enterprise Server or a local stub. Any value but `https://api.github.com` also lifts Octokit's write pacing, which is there for github.com's own rate limits. |
| `slack.apiUrl` | Slack's own | Override the Slack API base URL. For Enterprise Grid or a local stub. |
| `linear.apiUrl` | Linear's own | Override the Linear GraphQL endpoint. For a local stub. |

Trigger phrases are matched case-insensitively and only as whole tokens: `@my-bot` fires on `hey @my-bot, look` but not on `@my-botswana`, `@my-bot-2`, or `me@my-bot`.

## Platform setup

Each platform is independent. Set up only the ones you want; the forwarder starts as long as at least one secret is present.

Throughout, `https://your-tunnel.example.com` means whatever public URL you set up in [Exposing your machine](#exposing-your-machine).

### GitHub

GitHub has no "my app was mentioned" webhook, and a GitHub App does not appear in the `@` autocomplete at all. Every bot in this space works the same way instead: subscribe to comment events and look for a phrase in the body. That is what `github.triggerPhrases` is. The phrase is ordinary text — it does not have to correspond to a real GitHub account, so `@my-bot` works fine even if nobody owns that name. (Background: [community discussion #54188](https://github.com/orgs/community/discussions/54188), [#53504](https://github.com/orgs/community/discussions/53504), [#22565](https://github.com/orgs/community/discussions/22565).)

Pick one of the two options below. Both use the same code path, so `GITHUB_WEBHOOK_SECRET` is all that's needed to receive mentions — the credentials are only for adding the reaction.

**Option A — a repository or organization webhook.** Fastest, and best if you only care about a few repos.

1. Repo (or org) → **Settings → Webhooks → Add webhook**.
2. **Payload URL**: `https://your-tunnel.example.com/github/webhooks`
3. **Content type**: `application/json` — the forwarder rejects `form-urlencoded`.
4. **Secret**: invent a long random string. Put the same value in `.env` as `GITHUB_WEBHOOK_SECRET`.
5. **Which events?** → *Let me select individual events*, then tick: **Issue comments**, **Pull request review comments**, **Pull request reviews**, **Commit comments**, **Discussion comments**.
6. To let the bot react and reply, create a personal access token with write access to those repos and set `GITHUB_TOKEN`.

**Option B — a GitHub App.** Better if you want coverage across many repos from one webhook.

1. **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **Webhook URL**: `https://your-tunnel.example.com/github/webhooks`, and set the same **Webhook secret** as `GITHUB_WEBHOOK_SECRET`.
3. **Repository permissions** (needed to react and to reply): *Issues* → Read & write, *Pull requests* → Read & write, *Discussions* → Read & write.
4. **Subscribe to events**: the same list as step 5 above.
5. Create the app, then **Generate a private key** and save the `.pem`. Set `GITHUB_APP_ID` and `GITHUB_PRIVATE_KEY_PATH`.
6. **Install App** on the account or org whose repos you want covered.

### Slack

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**, name it, pick your workspace.
2. **OAuth & Permissions → Bot Token Scopes**, add:
   - `app_mentions:read` — required, this is how you receive mentions in channels.
   - `im:history` — required only if you want the bot to answer direct messages.
   - `channels:history`, `groups:history`, `mpim:history` - required only if you set `slack.triggerPhrases`, and only for the places you want them to work in: public channels, private channels, group DMs.
   - `chat:write` — required only if you want it to reply at all.
   - `reactions:write` — required for the acknowledgement reaction.
   - `users:read` — optional; without it `author` falls back to the raw user id like `U04ABCDEF` instead of a display name.
   - `chat.getPermalink` needs no scope, so `{{url}}` works either way.
3. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`) into `.env` as `SLACK_BOT_TOKEN`.
4. **Basic Information → Signing Secret** → `.env` as `SLACK_SIGNING_SECRET`.
5. **Start the forwarder now** — the next step makes Slack call it immediately.
6. **Event Subscriptions** → toggle on → **Request URL**: `https://your-tunnel.example.com/slack/events`. Slack posts a challenge and expects an answer within seconds; you should see a green *Verified*.
7. Still on that page, **Subscribe to bot events** → add `app_mention`; `message.im` too if you want DMs, and `message.channels`, `message.groups`, or `message.mpim` if you set `slack.triggerPhrases`. Reinstall the app if Slack asks.
8. In Slack, invite the bot to each channel you want it to listen in: `/invite @your-bot`. **If the bot is not in the channel, Slack does not deliver the event** — this is the most common reason nothing happens.

Slack tells us directly when the bot is mentioned, so no trigger phrase is needed: a real mention always counts, whatever `slack.triggerPhrases` says. Setting phrases adds a second way in rather than narrowing the first, so a channel message carrying one is forwarded even though it mentions nobody. That is how you use the same written phrase you already use on GitHub and Linear, or a word that is nobody's handle at all.

The phrase route only works if Slack sends those messages, which means subscribing to `message.channels`, `message.groups`, or `message.mpim` and adding the matching `*:history` scope. Every message in those conversations then reaches the forwarder, `logPayloads` included, so keep the bot in the channels you actually want it in.

A message that mentions the bot **and** carries a phrase is delivered twice, once as `app_mention` and once as `message.*`. The forwarder keeps the `app_mention` copy and drops the other, so your command still runs once.

**Direct messages need no mention and no trigger phrase** — a DM is addressed to the bot by definition, so the whole message is treated as the instruction and `prompt` is identical to `text`. Trigger phrases are not applied to DMs even when configured. Only plain new messages count: edits, deletions, and joins are ignored. The exemption is one-to-one DMs alone, so a channel or group DM still needs a mention or a trigger phrase.

### Linear

1. **Settings → API → Webhooks → New webhook**.
2. **URL**: `https://your-tunnel.example.com/linear/webhooks`
3. Copy the **signing secret** it shows you into `.env` as `LINEAR_WEBHOOK_SECRET`.
4. Under data change events, enable **Comments**.
5. To let the bot react and reply, create a personal API key under **Settings → API** and set `LINEAR_API_KEY`.

Like GitHub, Linear's plain webhooks don't say "you were mentioned", so `linear.triggerPhrases` is matched against the comment body. Use a literal phrase you type as text (`@my-bot`) rather than a real Linear user mention, since Linear stores a person-mention in a rendered form that won't match a bare `@name`. If you want to match a real mention, run once with `"logPayloads": true`, mention someone, and copy the exact body text out of the logged payload.

Linear rejects any payload whose timestamp is more than 60 seconds old, so a badly wrong system clock shows up as every delivery failing.

## Exposing your machine

The three platforms need to reach your laptop. Any of these works; pick one and use its URL everywhere above.

**Cloudflare Tunnel** — free, and a named tunnel keeps the same hostname across restarts, which matters because re-pasting three webhook URLs is tedious.

```sh
brew install cloudflared
cloudflared tunnel --url http://localhost:3000   # quick, random hostname each run
```

**ngrok** — a static domain on the free tier:

```sh
brew install ngrok
ngrok http 3000
```

**Tailscale Funnel** — if you already use Tailscale:

```sh
tailscale funnel 3000
```

Two things to keep in mind:

- **A changed hostname means re-pasting the URL** into every platform. Prefer a tunnel with a stable name.
- **Only the three webhook paths are exposed.** Everything that reaches them is checked before your command hears about it; see [Who can reach it](#who-can-reach-it). Still, don't run this on a port you've exposed for other reasons.

## Who can reach it

A request has four things to get past before it can run your command, and it fails on the first one it misses.

| Check | What it does |
| --- | --- |
| **Size** | A body over `maxPayloadBytes` (5 MiB by default) is refused with `413`, and one that arrives without a `Content-Length` with `411`. This happens first because the libraries underneath buffer the whole body before they look at the signature, so an unsigned request could otherwise spend as much of your memory as it liked. |
| **Source** | GitHub and Linear both publish the addresses their webhooks come from, and anything else gets `403`. GitHub's list is read from `api.github.com/meta` at startup and once a day after that, falling back to a bundled copy if that call fails; Linear's is bundled, because Linear publishes no equivalent endpoint. **Slack is not checked**, because Slack runs on AWS and publishes no ranges. Loopback always passes, which is what a tunnel arrives on. Override any of it with `<platform>.allowedSources`. |
| **Signature** | HMAC-SHA256 for GitHub and Linear, Slack's own scheme for Slack, each compared in constant time. Slack rejects anything signed more than five minutes ago and Linear more than a minute, so a captured delivery cannot be replayed later. |
| **Author** | `ignoreBots` and `ignoreAuthors` drop mentions you don't want; `<platform>.allowedAuthors` inverts that into a list of the only people who may trigger the command at all. Worth setting on a public repo, where otherwise anyone who can leave a comment can start your agent. |

Behind a tunnel or a router the connection arrives from your own machine, so the source check reads the original address out of `X-Forwarded-For` instead. That header is only believed when the hop that set it is itself trusted, which `trustedProxies` decides; by default that means loopback and private networks. Without that rule anyone could name whatever source address they liked.

### What `allowedAuthors` matches

Each platform names people differently, and the list is compared against exactly one string per platform:

| Platform | The value compared | Example |
| --- | --- | --- |
| GitHub | The account's **login**. Never the profile's display name. | `octocat` |
| Slack | The user's **display name**. If they have not set one it falls back to their real name, then their account name, and finally the raw user id. | `Lily Skye`, or `U04ABCDEF` |
| Linear | The person's **name** as Linear shows it. A non-human actor gives its integration's service name instead. | `Lily Skye`, `zapier` |

Comparison is case-insensitive, and nothing is trimmed or normalized beyond that, so a Slack display name is matched with its spaces and capitalization as written.

Two things worth knowing before you rely on it:

- **Slack needs the `users:read` scope**, or every author arrives as a raw id like `U04ABCDEF` and a list of display names matches nobody. That fails closed, so the symptom is the bot silently ignoring everyone.
- **A display name is not an identity.** On Slack and Linear it is chosen by the account holder and can be changed, and two people can pick the same one. GitHub logins are unique and are the only one of the three that is a real handle.

If you are not sure what a given person's value is, run once with `"logLevel": "debug"` and read the `author=` field off the `mention accepted` line. That is the exact string the list is compared against, and it is the same value `{{author}}` and `MENTION_AUTHOR` carry.

## What triggers a forward

| Platform | Event | `kind` |
| --- | --- | --- |
| GitHub | Comment on an issue or PR | `issue_comment` |
| GitHub | Inline code review comment | `pull_request_review_comment` |
| GitHub | Review summary body | `pull_request_review` |
| GitHub | Comment on a commit | `commit_comment` |
| GitHub | Comment on a discussion | `discussion_comment` |
| Slack | Bot mentioned in a channel or thread | `app_mention` |
| Slack | Message carrying a `slack.triggerPhrases` phrase, mentioning nobody | `message.channels`, `message.groups`, `message.mpim` |
| Slack | Any message in a DM with the bot — no mention needed | `message.im` |
| Linear | New comment on an issue | `comment` |

Deliberately **not** included:

- **Edits.** Only newly created comments fire. Editing an old comment to add the phrase will not trigger anything, which also means routine edits can't re-trigger work. The same holds for DMs: an edited message is ignored.
- **The body of a new issue, PR, or discussion.** Only comments count on every platform, so mentioning the bot in a GitHub PR description or a Linear issue description does nothing; comment on it afterwards instead.
- **Slack chatter that matches nothing.** Outside a one-to-one DM a message must mention the bot or carry a trigger phrase; with no phrases configured, a real mention is the only way in.
- **Your command's stdout.** That goes to the log. Replies are opt-in through the reply file, so ordinary logging never leaks into a comment.

Retried deliveries are recognised and dropped, so a slow command won't cause the same mention to run twice.

## Concurrency

Mentions in the **same** place run one at a time, in arrival order. Mentions in **different** places run in parallel, up to `maxConcurrentConversations`.

"Same place" means the same GitHub issue or PR, the same Slack thread, or the same Linear issue — that's the `conversationKey`. So two people commenting on one PR will never have their agents running over each other, while an unrelated Linear issue is handled immediately. A DM is keyed on the conversation as a whole, so consecutive messages are answered in the order they were sent.

Under `per-conversation` the same ordering holds, but `maxConcurrentConversations` has little effect: handing a mention to an already-running process is just a write to its stdin, so it finishes immediately. What bounds the number of live processes there is `sessionIdleMs`.

If more distinct conversations arrive than the limit allows, the extras wait their turn in arrival order; nothing is dropped.

The default of `4` suits an agent that touches a shared checkout. Raise it if your command is cheap and isolated; set it to `1` to make everything strictly sequential.

## Acknowledgement reactions

When a mention is accepted, the forwarder adds `reactionEmoji` (default 👀) to the message. That is your signal that it arrived, matched, and was queued — not that the command has finished.

Reactions are best-effort: a failure is logged as a warning and never stops the command from running. If credentials for a platform are missing, that platform simply skips the reaction and says so at startup.

GitHub only accepts its own fixed set of reactions. `eyes`, `+1`, `-1`, `laugh`, `hooray`/`tada`, `confused`, `heart`, and `rocket` all map cleanly; anything else works on Slack and Linear but is skipped on GitHub, with a warning at startup.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `No platforms are enabled` | None of `GITHUB_WEBHOOK_SECRET`, `SLACK_SIGNING_SECRET`, `LINEAR_WEBHOOK_SECRET` were found. Check that `.env` exists where you ran the command. |
| `github is enabled but "github.triggerPhrases" is missing` | Neither GitHub nor Linear reports mentions as such, so a phrase is mandatory — otherwise every comment would run your command. |
| Nothing happens, no log line at all | The request isn't arriving. Load your tunnel's URL in a browser: a `404` means it reached the forwarder, and a timeout or a tunnel error page means it did not. Then check the platform's own delivery log (GitHub: *Recent Deliveries* on the webhook; Slack: the Event Subscriptions page; Linear: the webhook's history). |
| GitHub replies `400`/`401` | The secret doesn't match, or the webhook's content type isn't `application/json`. |
| Slack won't verify the Request URL | The forwarder has to be running and reachable *before* you save the URL. |
| Slack mention in a channel does nothing | The bot isn't in that channel. `/invite @your-bot`. |
| Linear returns `400` on everything | Wrong secret, or your system clock is off by more than a minute. |
| Deliveries come back `403` | The source check refused them. The log names the address it saw. If your tunnel or proxy is not loopback or on a private network, add it to `trustedProxies`; if the platform has moved to a new range, add it to `<platform>.allowedSources`. |
| Deliveries come back `413` or `411` | The body was over `maxPayloadBytes`, or arrived with no `Content-Length`. Raise `maxPayloadBytes` if a real payload is genuinely that big. |
| A reply reads `@name` but nobody was notified | Working as intended; see [Replies never mention anyone](#replies-never-mention-anyone). |
| Nobody can trigger it after setting `allowedAuthors` | The name that platform supplies is not what you listed. On Slack it is a raw user id like `U04ABCDEF` unless the app has `users:read`. Compare your list against the `author=` field on the `mention accepted` line at `"logLevel": "debug"`, and see [What `allowedAuthors` matches](#what-allowedauthors-matches). |
| `bot token could not be verified` | The Slack token is wrong or expired. GitHub and Linear keep working; only Slack is affected. |
| `command failed to start … is "x" installed and on PATH?` | `command[0]` isn't resolvable. Use an absolute path — a GUI-launched process may not have your shell's `PATH`. |
| A mention is logged as accepted but nothing runs | Look for `command exited non-zero`; your program's own stdout and stderr are in the log, prefixed. |
| Your agent's own comments trigger more runs | Keep `ignoreBots: true`, and add the account it posts as to `ignoreAuthors`. Replies the forwarder posts are authored by your app or token, so `ignoreBots` normally covers them. |
| Nothing is posted even though the command wrote a reply | Check it wrote to the path in `MENTION_REPLY_FILE` (or `mention.replyFile`) and not a path of its own. Set `replyDir` and look in it. |
| A reply is posted but the text is empty or partial | Whitespace-only content is skipped. Under `per-conversation`, a reply is only posted once writes settle for `replyDebounceMs`; raise it if your command writes in slow bursts. |
| `cannot post reply: no GitHub credentials configured` | Reactions and replies both need `GITHUB_TOKEN`, or `GITHUB_APP_ID` plus a private key. |
| A DM does nothing | The `im:history` scope and the `message.im` bot event subscription are both required, and Slack needs a reinstall after adding them. |
| A Slack trigger phrase in a channel does nothing | Only a real mention arrives by default. Matching a phrase in a channel also needs the `message.channels` subscription and `channels:history` (`groups`/`mpim` for the other kinds), then a reinstall. |
| A long-lived command never sees the second mention | It must read stdin line by line and keep running. If it exits after the first mention, check the log for `session ended`. |

Turn on `"logLevel": "debug"` to see every delivery and why any were ignored. Add `"logPayloads": true` to dump the full JSON each platform sent — the fastest way to find out what a field is actually called before writing a trigger phrase against it.

## Development

```sh
npm test        # unit tests, plus an end-to-end run against signed webhooks from all three platforms
npm run typecheck
```

The end-to-end test boots the real CLI, posts genuinely signed GitHub, Slack, and Linear payloads at it, and asserts on what the child process received through all three channels. A second one drives the same CLI through the simulator below, covering every event each platform can send, the acknowledgement reaction, and the reply on its way back.

To drive the webhooks by hand instead, the [simulator](simulator/README.md) stands in for whichever platform you point it at, with a web page of threads you can post into. Replies and reactions come back through a stand-in platform API, so the whole round trip works without a real account or a tunnel.

```sh
npm run sim:forwarder            # the forwarder, configured to talk to the simulator
npm run sim -- --platform github # the simulator, at http://127.0.0.1:4000
```

| Path | Role |
| --- | --- |
| `src/cli.ts` | Entry point: arguments, `.env`, wiring, startup summary. |
| `src/config.ts` | Config schema and validation; decides which platforms are on. |
| `src/platforms/*.ts` | One adapter per platform: verify, detect the mention, normalize, react. |
| `src/intake.ts` | Shared policy: de-duplicate, filter authors, enqueue. |
| `src/queue.ts` | Serial within a conversation, parallel across conversations. |
| `src/runner.ts` | Spawns the command and wires up argv, stdin, and env, for both lifecycles. |
| `src/reply.ts` | Watches reply files and posts what a command appends to them. |
| `simulator/` | A side app that imitates one platform end-to-end, for testing by hand. |
