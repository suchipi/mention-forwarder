# Simulator

A stand-in for GitHub, Slack, or Linear, so you can exercise every webhook by hand against a really running forwarder. Nothing leaves your machine: no real account, no tunnel, no app to install.

It plays both halves of the platform at once.

```
                  post a message           signed webhook
   web UI  ──────────────────────▶  simulator  ──────────▶  mention-forwarder
      ▲                                  ▲                        │
      └──── the reply shows up here ─────┴──── stand-in API ◀──────┘
                                            (replies and reactions)
```

`--platform` decides which of the three it imitates. One at a time, because a simulator that pretended to be all three would not tell you anything about which one broke.

## Running it

Two terminals, both from the repo root. The forwarder first:

```sh
npm run sim:forwarder
```

Then the simulator:

```sh
npm run sim -- --platform github
```

Open <http://127.0.0.1:4000>, pick a thread, and send a message. You should see it delivered, an 👀 reaction land on it, and a reply come back from the command.

Both processes read `simulator/forwarder.config.json` and `simulator/forwarder.env`, so the webhook secrets, paths, and ports already agree. The secrets in that env file are fake on purpose.

Swap platforms by restarting only the simulator:

```sh
npm run sim -- --platform slack
npm run sim -- --platform linear
```

## What you can send

Each thread offers the events that can actually happen there. Between them they cover every webhook the forwarder handles.

| Platform | Thread | Events |
| --- | --- | --- |
| GitHub | Issue #7 | `issue_comment.created`, `issues.opened` |
| GitHub | Pull request #42 | `issue_comment.created`, `pull_request_review_comment.created`, `pull_request_review.submitted`, `pull_request.opened` |
| GitHub | Commit | `commit_comment.created` |
| GitHub | Discussion #3 | `discussion_comment.created`, `discussion.created` |
| Slack | `#general` | `app_mention`, and a plain message with no mention |
| Slack | `#general` thread | `app_mention` inside an existing thread |
| Slack | Direct message | `message.im` |
| Linear | ACM-12, ACM-13 | `Comment.create`, a threaded `Comment.create`, `Issue.create` |

The author picker includes a bot, which is how you check that `ignoreBots` does what you expect. Every message card shows the response the forwarder gave, and expands to the exact signed payload that was sent.

Replies find their way back to the right thread because the forwarder is pointed at the simulator's stand-in API rather than the real one, through `github.apiUrl`, `slack.apiUrl`, and `linear.apiUrl`. The page says so in a banner if those do not match, and so does the simulator at startup. Pointing `github.apiUrl` away from github.com also lifts Octokit's write pacing, so GitHub replies arrive as promptly as the other two rather than three seconds apart.

## Options

```
-p, --platform <name>  github, slack, or linear. Defaults to the only enabled one.
    --port <number>    Port for the UI and the stand-in API (default: 4000)
-c, --config <path>    The forwarder's config file (default: simulator/forwarder.config.json)
    --env-file <path>  The forwarder's env file (default: simulator/forwarder.env)
    --forwarder <url>  Where the forwarder listens (default: http://127.0.0.1:<the config's port>)
```

To try your own command rather than the echo responder, point `command` in `simulator/forwarder.config.json` at it. Everything else can stay as it is.

## When something does not happen

| Symptom | Where to look |
| --- | --- |
| The message card says `rejected · 400` | The two processes disagree about the secret. Both must read the same env file. |
| The card says `no response` | The forwarder is not running, or is on another port. Pass `--forwarder`. |
| Delivered, but no reaction and no reply | The trigger phrase is missing from the text, the author is the bot, or the credentials for that platform are absent. Set `"logLevel": "debug"` in the config to see which. |
| A banner says replies will not come back | `<platform>.apiUrl` does not point at this simulator. The banner names the value to use. |
| `bot token could not be verified` in the forwarder | Expected while the simulator is imitating something other than Slack: nothing is answering as Slack right now. |

## Layout

| Path | Role |
| --- | --- |
| `cli.ts` | Arguments, platform choice, startup checks. |
| `server.ts` | Serves the UI, the state it polls, and the stand-in API. |
| `store.ts` | The threads and messages, in memory. Restarting starts over. |
| `platforms/*.ts` | One per platform: its threads, its signed payloads, and its stand-in API. |
| `ui.html` | The whole page. No build step, no dependencies. |
| `echo-command.ts` | The default command: quotes the prompt back as a reply. |

The round trip is covered automatically too: `test/simulator.test.ts` boots the forwarder and one simulator per platform, then asserts that every event a thread offers reaches the command, that the reaction and reply come back, and that bots and untriggered messages are ignored.
