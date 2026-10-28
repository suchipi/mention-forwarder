export type TriggerMatcher = {
  /** True when any configured phrase appears in `text` as a standalone token, outside code. */
  test(text: string): boolean;
  /** `text` with every matched phrase removed, leaving code and the rest of the body intact. */
  strip(text: string): string;
};

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `@bot` must not fire on `@botswana`, `@bot-2`, or `me@bot`, so the phrase is
 * fenced by hand-written boundaries — `\b` is useless here because the phrases
 * begin with a non-word character.
 */
const LEFT_BOUNDARY = "(?<![\\w@/-])";
const RIGHT_BOUNDARY = "(?![\\w-])";

/** A fenced block's opening or closing run, at most three spaces in as CommonMark allows. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

const CODE_SPAN = /(`+)[^`\n]+\1/g;

/**
 * Stands in for a character inside code. Not a space, or the trailing space a
 * phrase is stripped with would run on into masked text and take real
 * characters with it; not a word character, so a phrase written right beside a
 * code span still ends at a boundary.
 */
const MASK = "\u0000";

/**
 * The text with every code span and fenced block masked out, character for
 * character, so a position in the masked text is that position in the original.
 *
 * Quoting a phrase as code is how you talk about the bot without summoning it,
 * and it is what keeps a reply quoting one from starting a run of its own.
 */
function maskCode(text: string): string {
  let fence: string | undefined;

  return text
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== undefined) {
        if (marker !== undefined && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
        return MASK.repeat(line.length);
      }
      if (marker !== undefined) {
        fence = marker;
        return MASK.repeat(line.length);
      }
      return line.replace(CODE_SPAN, (span) => MASK.repeat(span.length));
    })
    .join("\n");
}

export function createTriggerMatcher(phrases: string[]): TriggerMatcher {
  if (phrases.length === 0) {
    return { test: () => false, strip: (text) => text.trim() };
  }

  const alternatives = phrases.map(escapeRegExp).join("|");
  const body = `${LEFT_BOUNDARY}(?:${alternatives})${RIGHT_BOUNDARY}`;
  const detect = new RegExp(body, "i");
  // Also eats horizontal space after the phrase; leading indentation inside code
  // blocks must survive, so no general whitespace collapsing.
  const remove = new RegExp(`${body}[ \\t]*`, "gi");

  return {
    test: (text) => detect.test(maskCode(text)),
    strip: (text) => {
      const masked = maskCode(text);
      let result = "";
      let index = 0;
      remove.lastIndex = 0;
      for (let match = remove.exec(masked); match !== null; match = remove.exec(masked)) {
        result += text.slice(index, match.index);
        index = match.index + match[0].length;
      }
      return (result + text.slice(index)).trim();
    },
  };
}
