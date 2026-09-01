/**
 * Replies are posted under the bot's own identity, so anything a command writes
 * into a reply file would notify real people if it carried a mention. These
 * rewrite the mention forms each platform acts on into text that still reads the
 * same but addresses nobody.
 */

/** Slack ids are uppercase alphanumeric, the same shape the adapter already matches on. */
const SLACK_ID = "[A-Z0-9]+";

const SLACK_BROADCAST = /<!(channel|here|everyone)(?:\|[^<>]*)?>/g;
const SLACK_USERGROUP = new RegExp(`<!subteam\\^(${SLACK_ID})(?:\\|([^<>]*))?>`, "g");
const SLACK_USER = new RegExp(`<@(${SLACK_ID})(?:\\|([^<>]*))?>`, "g");
const SLACK_CHANNEL = new RegExp(`<#(${SLACK_ID})(?:\\|([^<>]*))?>`, "g");

/**
 * Strips the angle brackets that make Slack treat a name as a mention, leaving
 * the label behind as plain text.
 *
 * Only the bracketed forms notify anyone, so nothing else has to change: the
 * Markdown a reply is posted as survives intact, as does `<!date^…>`, which is a
 * formatter rather than a mention.
 *
 * @param body Reply text as the command wrote it.
 * @returns The same text with `<!channel>`, `<@U…>`, `<#C…>` and `<!subteam^…>`
 *   reduced to `@channel`, `@name`, `#name`.
 */
export function neutralizeSlackMentions(body: string): string {
  return body
    .replace(SLACK_BROADCAST, (_whole, name: string) => `@${name}`)
    .replace(SLACK_USERGROUP, (_whole, id: string, label?: string) => withSigil("@", label ?? id))
    .replace(SLACK_USER, (_whole, id: string, label?: string) => withSigil("@", label ?? id))
    .replace(SLACK_CHANNEL, (_whole, id: string, label?: string) => withSigil("#", label ?? id));
}

function withSigil(sigil: string, label: string): string {
  return label.startsWith(sigil) ? label : `${sigil}${label}`;
}

/** Renders as nothing, and breaks the `@name` run that GitHub scans for. */
const ZERO_WIDTH_SPACE = "\u200B";

/** `@name` and `@org/team`, only where GitHub itself would read one: never mid-word, so emails are left alone. */
const MARKDOWN_MENTION = /(^|[^\w])@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?)/g;

/**
 * Spans that must survive byte for byte: a code span, a link, or a bare URL.
 * A zero-width space dropped into any of them breaks something the reader needs.
 */
const PROTECTED = /(`+)[^`\n]+\1|!?\[[^\]\n]*\]\([^)\n]*\)|<[^\s<>]+>|\bhttps?:\/\/[^\s<>]+/g;

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Breaks `@name` mentions in Markdown so GitHub and Linear render them without
 * notifying anyone.
 *
 * Neither platform offers an escape for `@` (a backslash does not work in a
 * GitHub comment), so the only option that still reads as `@name` is a
 * zero-width space after the sigil. That character is invisible but real, which
 * is why code, links and URLs are left alone: a mention was never live inside
 * them, and salting text someone will copy is worse than the ping it prevents.
 *
 * @param body Reply text as the command wrote it.
 * @returns The same text with mentions defused everywhere they would have fired.
 */
export function neutralizeMarkdownMentions(body: string): string {
  let fence: string | undefined;

  return body
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return line;
      }
      if (marker !== undefined) {
        fence = marker;
        return line;
      }
      return defuseOutsideProtected(line);
    })
    .join("\n");
}

function defuseOutsideProtected(line: string): string {
  let result = "";
  let index = 0;
  PROTECTED.lastIndex = 0;
  for (let span = PROTECTED.exec(line); span !== null; span = PROTECTED.exec(line)) {
    result += defuse(line.slice(index, span.index)) + span[0];
    index = span.index + span[0].length;
  }
  return result + defuse(line.slice(index));
}

function defuse(text: string): string {
  return text.replace(
    MARKDOWN_MENTION,
    (_whole, before: string, name: string) => `${before}@${ZERO_WIDTH_SPACE}${name}`,
  );
}
