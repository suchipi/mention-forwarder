const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}

function escapeText(value) {
  return escapeHtml(value).replace(/\n/g, "<br />");
}

/** Only these schemes are ever linked, so a `javascript:` URL cannot ride in on a pasted link. */
function anchor(url, labelHtml) {
  if (!/^(?:https?:\/\/|mailto:)/i.test(url)) return null;
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${labelHtml}</a>`;
}

function image(url, alt) {
  if (!/^https?:\/\//i.test(url)) return null;
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" />`;
}

function mention(text) {
  return `<span class="mention">${escapeHtml(text)}</span>`;
}

function autolink(match) {
  const url = match[0].replace(/[.,;:!?)\]]+$/, "");
  const rest = match[0].slice(url.length);
  return `${anchor(url, escapeHtml(url)) ?? escapeHtml(url)}${escapeHtml(rest)}`;
}

// A rule's next match is remembered until the walk passes it. Searching every rule again at
// every character is what turns a few thousand unmatched brackets into a frozen page.
function scan(text, rules) {
  const found = rules.map(() => ({ searched: -1, match: null }));
  let html = "";
  let index = 0;

  while (index < text.length) {
    let claim = null;
    for (const [position, rule] of rules.entries()) {
      const next = found[position];
      if (next.searched < 0 || (next.match !== null && next.match.index < index)) {
        rule.pattern.lastIndex = index;
        next.match = rule.pattern.exec(text);
        next.searched = index;
      }
      if (next.match === null) continue;
      if (claim === null || next.match.index < claim.match.index) claim = { rule, match: next.match };
      if (claim.match.index === index) break;
    }
    if (claim === null) break;
    html += escapeText(text.slice(index, claim.match.index));
    html += claim.rule.render(claim.match);
    index = claim.match.index + claim.match[0].length;
  }

  return html + escapeText(text.slice(index));
}

const COMMONMARK = [
  { pattern: /(`+)([^`\n]+)\1(?!`)/g, render: (match) => `<code>${escapeHtml(match[2])}</code>` },
  {
    pattern: /!\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/g,
    render: (match) => image(match[2], match[1]) ?? escapeText(match[0]),
  },
  {
    pattern: /\[([^\]]*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/g,
    render: (match) => anchor(match[2], scan(match[1], COMMONMARK)) ?? escapeText(match[0]),
  },
  {
    pattern: /<((?:https?:\/\/|mailto:)[^\s<>]+)>/g,
    render: (match) => anchor(match[1], escapeHtml(match[1])) ?? escapeText(match[0]),
  },
  { pattern: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, render: (match) => `<strong>${scan(match[2], COMMONMARK)}</strong>` },
  { pattern: /~~(?=\S)([\s\S]*?\S)~~/g, render: (match) => `<del>${scan(match[1], COMMONMARK)}</del>` },
  { pattern: /\*(?=\S)([^*\n]*\S)\*/g, render: (match) => `<em>${scan(match[1], COMMONMARK)}</em>` },
  { pattern: /(?<!\w)_(?=\S)([^_\n]*\S)_(?!\w)/g, render: (match) => `<em>${scan(match[1], COMMONMARK)}</em>` },
  { pattern: /https?:\/\/[^\s<>"']+/g, render: autolink },
];

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const TABLE_DIVIDER = /^ *\|?(?: *:?-+:? *\|)* *:?-+:? *\|? *$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function dedent(line, width) {
  let removed = 0;
  while (removed < width && line[removed] === " ") removed += 1;
  return line.slice(removed);
}

function closesFence(line, opener) {
  const trimmed = line.trim();
  return trimmed.length >= opener.length && [...trimmed].every((character) => character === opener[0]);
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTable(lines, index) {
  const header = lines[index];
  const divider = lines[index + 1];
  if (divider === undefined || !header.includes("|") || !TABLE_DIVIDER.test(divider)) return false;
  return splitRow(header).length === splitRow(divider).length;
}

function startsBlock(lines, index) {
  const line = lines[index];
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    THEMATIC_BREAK.test(line) ||
    QUOTE.test(line) ||
    ITEM.test(line) ||
    isTable(lines, index)
  );
}

function alignmentOf(cell) {
  if (cell.startsWith(":") && cell.endsWith(":")) return "center";
  if (cell.endsWith(":")) return "right";
  if (cell.startsWith(":")) return "left";
  return undefined;
}

function cell(tag, text, alignment) {
  const style = alignment === undefined ? "" : ` style="text-align: ${alignment}"`;
  return `<${tag}${style}>${scan(text, COMMONMARK)}</${tag}>`;
}

function renderTable(lines, start) {
  const header = splitRow(lines[start]);
  const alignments = splitRow(lines[start + 1]).map(alignmentOf);
  const rows = [];
  let index = start + 2;

  while (index < lines.length && lines[index].trim() !== "" && lines[index].includes("|")) {
    rows.push(splitRow(lines[index]));
    index += 1;
  }

  const head = header.map((text, column) => cell("th", text, alignments[column])).join("");
  const body = rows
    .map((row) => `<tr>${header.map((_, column) => cell("td", row[column] ?? "", alignments[column])).join("")}</tr>`)
    .join("");

  return [`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`, index];
}

function renderItem(lines) {
  const blocks = renderBlocks(lines);
  const first = blocks[0] ?? "";
  if (first.startsWith("<p>") && first.endsWith("</p>")) blocks[0] = first.slice(3, -4);
  return blocks.join("");
}

function renderList(lines, start) {
  const first = ITEM.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let contentIndent = 0;
  let current = null;
  let index = start;

  while (index < lines.length) {
    const line = lines[index];
    const item = ITEM.exec(line);

    if (item !== null && item[1].length === indent && /\d/.test(item[2]) === ordered && !THEMATIC_BREAK.test(line)) {
      contentIndent = item[1].length + item[2].length + (item[3] ?? " ").length;
      current = [item[4] ?? ""];
      items.push(current);
      index += 1;
      continue;
    }

    if (current === null) break;

    if (line.trim() === "") {
      const next = lines[index + 1];
      if (next === undefined) break;
      const nextItem = ITEM.exec(next);
      const sameLevel = nextItem !== null && nextItem[1].length === indent && /\d/.test(nextItem[2]) === ordered;
      if (!sameLevel && indentOf(next) < contentIndent) break;
      current.push("");
      index += 1;
      continue;
    }

    if (indentOf(line) < contentIndent && startsBlock(lines, index)) break;

    current.push(dedent(line, contentIndent));
    index += 1;
  }

  const from = ordered ? Number.parseInt(first[2], 10) : 1;
  const open = ordered ? `<ol${from === 1 ? "" : ` start="${from}"`}>` : "<ul>";
  const close = ordered ? "</ol>" : "</ul>";
  return [`${open}${items.map((item) => `<li>${renderItem(item)}</li>`).join("")}${close}`, index];
}

function renderBlocks(lines) {
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === "") {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence !== null) {
      const body = [];
      index += 1;
      while (index < lines.length && !closesFence(lines[index], fence[1])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${scan(heading[2] ?? "", COMMONMARK)}</h${level}>`);
      index += 1;
      continue;
    }

    if (THEMATIC_BREAK.test(line)) {
      blocks.push("<hr />");
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted = [];
      while (index < lines.length && QUOTE.test(lines[index])) {
        quoted.push(lines[index].replace(QUOTE, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderBlocks(quoted).join("")}</blockquote>`);
      continue;
    }

    if (isTable(lines, index)) {
      const [table, next] = renderTable(lines, index);
      blocks.push(table);
      index = next;
      continue;
    }

    if (ITEM.test(line)) {
      const [list, next] = renderList(lines, index);
      blocks.push(list);
      index = next;
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() !== "") {
      if (paragraph.length > 0 && startsBlock(lines, index)) break;
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${scan(paragraph.join("\n"), COMMONMARK)}</p>`);
  }

  return blocks;
}

const MRKDWN_QUOTE = /^ *> ?/;

function mrkdwnRules(names) {
  const nameFor = (id, label) => label || names[id] || id;

  const rules = [
    { pattern: /&(?:amp|lt|gt);/g, render: (match) => match[0] },
    { pattern: /`([^`\n]+)`/g, render: (match) => `<code>${escapeHtml(match[1])}</code>` },
    {
      pattern: /<((?:https?:\/\/|mailto:)[^\s<>|]+)\|([^<>]*)>/g,
      render: (match) => anchor(match[1], scan(match[2], rules)) ?? escapeText(match[0]),
    },
    {
      pattern: /<((?:https?:\/\/|mailto:)[^\s<>|]+)>/g,
      render: (match) => anchor(match[1], escapeHtml(match[1])) ?? escapeText(match[0]),
    },
    { pattern: /<@([A-Z0-9]+)(?:\|([^<>]*))?>/g, render: (match) => mention(`@${nameFor(match[1], match[2])}`) },
    { pattern: /<#([A-Z0-9]+)(?:\|([^<>]*))?>/g, render: (match) => mention(`#${nameFor(match[1], match[2])}`) },
    {
      pattern: /<!subteam\^([A-Z0-9]+)(?:\|([^<>]*))?>/g,
      render: (match) => mention(`@${nameFor(match[1], match[2])}`),
    },
    { pattern: /<!(here|channel|everyone)(?:\|[^<>]*)?>/g, render: (match) => mention(`@${match[1]}`) },
    { pattern: /(?<!\*)\*(?=\S)([^*\n]*\S)\*(?!\*)/g, render: (match) => `<strong>${scan(match[1], rules)}</strong>` },
    { pattern: /(?<!\w)_(?=\S)([^_\n]*\S)_(?!\w)/g, render: (match) => `<em>${scan(match[1], rules)}</em>` },
    { pattern: /(?<!~)~(?=\S)([^~\n]*\S)~(?!~)/g, render: (match) => `<del>${scan(match[1], rules)}</del>` },
    { pattern: /https?:\/\/[^\s<>|]+/g, render: autolink },
  ];

  return rules;
}

function renderQuotesAndText(text, rules) {
  const lines = text.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (MRKDWN_QUOTE.test(lines[index])) {
      const quoted = [];
      while (index < lines.length && MRKDWN_QUOTE.test(lines[index])) {
        quoted.push(lines[index].replace(MRKDWN_QUOTE, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${scan(quoted.join("\n"), rules)}</blockquote>`);
      continue;
    }

    const plain = [];
    while (index < lines.length && !MRKDWN_QUOTE.test(lines[index])) {
      plain.push(lines[index]);
      index += 1;
    }
    blocks.push(scan(plain.join("\n"), rules));
  }

  return blocks.join("");
}

function renderMrkdwn(text, names) {
  const rules = mrkdwnRules(names);
  const fences = /```\n?([\s\S]*?)```/g;
  let html = "";
  let index = 0;

  for (let match = fences.exec(text); match !== null; match = fences.exec(text)) {
    html += renderQuotesAndText(text.slice(index, match.index), rules);
    html += `<pre><code>${escapeHtml(match[1].replace(/\n$/, ""))}</code></pre>`;
    index = match.index + match[0].length;
  }

  return html + renderQuotesAndText(text.slice(index), rules);
}

/**
 * Renders one message body as HTML, in the notation the platform it came from actually uses.
 *
 * GitHub and Linear get a CommonMark subset: headings, lists, blockquotes, fenced code, tables,
 * images, links, and emphasis. Slack gets mrkdwn instead, where a single asterisk is bold, an
 * underscore is italic, `**bold**` stays literal, there are no headings or lists, and links and
 * mentions arrive wrapped in angle brackets. Rendering either one as the other would hide the
 * differences the simulator exists to show.
 *
 * Every part of the text is escaped, and only `http`, `https`, and `mailto` URLs become links.
 *
 * @see https://docs.slack.dev/messaging/formatting-message-text for the mrkdwn notation.
 * @param {string} text The body exactly as the platform carries it.
 * @param {string} platform `github`, `slack`, or `linear`.
 * @param {Record<string, string>} [mentionNames] How the ids in `<@U…>` and `<#C…>` read once rendered.
 * @returns {string} HTML for the inside of one element.
 */
export function renderMessage(text, platform, mentionNames = {}) {
  return platform === "slack" ? renderMrkdwn(text, mentionNames) : renderBlocks(text.split("\n")).join("");
}
