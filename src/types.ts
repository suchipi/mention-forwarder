export type Platform = "github" | "slack" | "linear";

/**
 * A single @-mention, normalized across platforms. This is the object that gets
 * serialized to the child command's stdin, so its field names are a public
 * interface: renaming one breaks every configured command.
 */
export type Mention = {
  /** Unique per delivery. Repeat deliveries of the same id are dropped as webhook retries. */
  id: string;
  platform: Platform;
  /** Platform event name, e.g. `issue_comment`, `app_mention`, `Comment`. */
  kind: string;
  /** Permalink to the comment or message that did the mentioning. */
  url: string;
  /** The body of the comment/message, verbatim. */
  text: string;
  /** `text` with the mention itself removed — the part meant as an instruction. */
  prompt: string;
  /** Display name or handle of whoever wrote it. */
  author: string;
  /** Issue/PR title, or Slack channel name. Empty when the platform offers none. */
  title: string;
  /** Mentions sharing this key are forwarded one at a time, in arrival order. */
  conversationKey: string;
  receivedAt: string;
  /**
   * Path the command may write a reply into. Anything appended here is posted
   * back where the mention came from; write nothing to stay silent.
   */
  replyFile: string;
  /** The untouched webhook payload. Only present when `includeRawPayload` is enabled. */
  raw?: unknown;
};
