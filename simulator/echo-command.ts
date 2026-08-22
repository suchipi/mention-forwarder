#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

type Mention = { kind: string; author: string; prompt: string; replyFile: string };

function handle(mention: Mention): void {
  process.stdout.write(`handling ${mention.kind} from ${mention.author}\n`);
  appendFileSync(mention.replyFile, `Got it, ${mention.author}. You asked:\n\n> ${mention.prompt}\n`);
}

// The two lifecycles frame stdin differently (one pretty-printed object then EOF, or one
// object per line), so lines are accumulated until they parse rather than split apart.
let buffered = "";
for await (const line of createInterface({ input: process.stdin })) {
  buffered += `${line}\n`;
  try {
    const mention = JSON.parse(buffered) as Mention;
    buffered = "";
    handle(mention);
  } catch {
    continue;
  }
}
