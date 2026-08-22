export type TriggerMatcher = {
  /** True when any configured phrase appears in `text` as a standalone token. */
  test(text: string): boolean;
  /** `text` with every matched phrase removed, leaving the rest of the body intact. */
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
    test: (text) => detect.test(text),
    strip: (text) => text.replace(remove, "").trim(),
  };
}
