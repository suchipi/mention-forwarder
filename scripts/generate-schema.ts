#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { fileSchema } from "../src/config.ts";

/** Committed rather than generated on demand, so an editor can read it straight out of a checkout. */
export const SCHEMA_PATH = fileURLToPath(new URL("../mention-forwarder.config.schema.json", import.meta.url));

/** VS Code renders `description` as plain text, so the backticks only format for readers of the markdown twin. */
function mirrorAsMarkdown(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) mirrorAsMarkdown(item);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const record = node as Record<string, unknown>;
  if (typeof record["description"] === "string") record["markdownDescription"] = record["description"];
  for (const value of Object.values(record)) mirrorAsMarkdown(value);
}

/** The JSON Schema for `mention-forwarder.config.json`, exactly as the committed file holds it. */
export function renderSchema(): string {
  // Input semantics, or every field carrying a .default() would come out required.
  const schema = z.toJSONSchema(fileSchema, { io: "input" });
  mirrorAsMarkdown(schema);
  return `${JSON.stringify(schema, null, 2)}\n`;
}

if (import.meta.main) {
  writeFileSync(SCHEMA_PATH, renderSchema());
  process.stdout.write(`wrote ${SCHEMA_PATH}\n`);
}
