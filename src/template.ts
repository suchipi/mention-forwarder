import type { Mention } from "./types.ts";

export const PLACEHOLDERS = [
  "id",
  "platform",
  "kind",
  "url",
  "text",
  "prompt",
  "author",
  "title",
  "conversationKey",
  "receivedAt",
  "replyFile",
  "json",
] as const;

export type Placeholder = (typeof PLACEHOLDERS)[number];

const PATTERN = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * Placeholders whose value is the same for every mention in one conversation.
 * Everything else changes mention to mention, which matters only for a
 * long-lived command, where argv is fixed by whichever mention started it.
 */
const CONVERSATION_STABLE: readonly Placeholder[] = ["platform", "conversationKey"];

/**
 * Single source of truth for the string form of a mention, so `{{text}}` and
 * `MENTION_TEXT` can never disagree about what they mean.
 */
function fields(mention: Mention): Record<Placeholder, string> {
  return {
    id: mention.id,
    platform: mention.platform,
    kind: mention.kind,
    url: mention.url,
    text: mention.text,
    prompt: mention.prompt,
    author: mention.author,
    title: mention.title,
    conversationKey: mention.conversationKey,
    receivedAt: mention.receivedAt,
    replyFile: mention.replyFile,
    json: JSON.stringify(mention),
  };
}

export function render(template: string, mention: Mention): string {
  const values = fields(mention);
  return template.replace(PATTERN, (whole, name: string) =>
    // hasOwn, not `in`: `{{constructor}}` would otherwise resolve up the prototype chain.
    Object.hasOwn(values, name) ? values[name as Placeholder] : whole,
  );
}

/** Names used as `{{placeholder}}` in `template` that `render` would not substitute. */
export function findUnknownPlaceholders(template: string): string[] {
  const unknown: string[] = [];
  for (const match of template.matchAll(PATTERN)) {
    const name = match[1] as string;
    if (!(PLACEHOLDERS as readonly string[]).includes(name)) unknown.push(name);
  }
  return unknown;
}

/** Placeholders in `templates` that would go stale after the first mention of a conversation. */
export function findVaryingPlaceholders(templates: string[]): string[] {
  const varying = new Set<string>();
  for (const template of templates) {
    for (const match of template.matchAll(PATTERN)) {
      const name = match[1] as string;
      const known = (PLACEHOLDERS as readonly string[]).includes(name);
      if (known && !(CONVERSATION_STABLE as readonly string[]).includes(name)) varying.add(name);
    }
  }
  return [...varying];
}

function screamingSnake(camel: string): string {
  return camel.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

export function envVars(mention: Mention): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields(mention))) {
    vars[`MENTION_${screamingSnake(name)}`] = value;
  }
  return vars;
}
