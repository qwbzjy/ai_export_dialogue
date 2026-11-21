/**
 * Turning API payloads into clean Markdown.
 *
 * The APIs already return Markdown or plain text, so this is normalisation,
 * not conversion: fix line endings, normalise math delimiters, pull citation
 * markers into a "参考来源" list, and make sure the result never looks like
 * raw JSON.
 */

const CITATION = /\[(?:citation|reference):(\d+)\]/gi;
const QIANWEN_SOURCE = /\[\[source_group_web_(\d+)\]\]/g;
const QWEN_SOURCE = /【(\d+)†[^】]*】/g;

export function tidy(text) {
  if (!text) return "";
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/**
 * Some sites emit \(…\) and \[…\], which the Markdown renderer does not
 * understand. Both are unambiguous, so rewriting them is safe.
 */
export function normalizeMath(text) {
  return text
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, body) => `\n\n$$\n${body.trim()}\n$$\n\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, body) => `$${body.trim()}$`);
}

/**
 * Turns inline citation markers into a numbered footnote list. Markers whose
 * source is unknown are dropped rather than left as noise, but the answer
 * text itself is never altered beyond removing the marker.
 *
 * @param {string} text
 * @param {Array<{title: string, url: string}>} sources
 * @returns {{ markdown: string, sources: Array<{title: string, url: string}> }}
 */
export function withSources(text, sources = []) {
  const used = new Map();

  const mark = (marker, index) => {
    const source =
      sources.find((candidate) => candidate.index === index) ??
      sources.find((candidate) => candidate.number === index) ??
      sources[index - 1] ??
      null;
    if (!source?.url) return "";
    if (!used.has(source.url)) used.set(source.url, used.size + 1);
    return `[${used.get(source.url)}]`;
  };

  let markdown = text
    .replace(CITATION, (marker, index) => mark(marker, Number(index)))
    .replace(QIANWEN_SOURCE, (marker, index) => mark(marker, Number(index)))
    .replace(QWEN_SOURCE, (marker, index) => mark(marker, Number(index)));

  const list = [...used.entries()].map(([url, number]) => {
    const source = sources.find((candidate) => candidate.url === url);
    return { number, title: source?.title || url, url };
  });

  if (list.length) {
    markdown +=
      "\n\n**参考来源**\n\n" +
      list.map((source) => `${source.number}. [${source.title}](${source.url})`).join("\n");
  }

  return { markdown: tidy(markdown), sources: list };
}

/**
 * Collects URLs from an arbitrary payload tree under whichever keys the five
 * APIs use. Returns [{url, title, index}] with `index` when the payload
 * numbers its results (DeepSeek's cite_index).
 */
export function collectSources(node, depth = 0, out = []) {
  if (depth > 6 || node == null) return out;
  if (Array.isArray(node)) {
    for (const child of node) collectSources(child, depth + 1, out);
    return out;
  }
  if (typeof node !== "object") return out;

  const url = typeof node.url === "string" ? node.url : typeof node.link === "string" ? node.link : null;
  if (url && /^https?:/i.test(url)) {
    out.push({
      url,
      title: node.title || node.name || node.site_name || node.siteName || url,
      index: typeof node.cite_index === "number" ? node.cite_index : undefined,
    });
  }

  for (const child of Object.values(node)) {
    if (child && typeof child === "object") collectSources(child, depth + 1, out);
  }
  return out;
}

/** Case-insensitive key lookup, because the APIs are inconsistent. */
export function pick(object, ...keys) {
  if (!object || typeof object !== "object") return undefined;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  const lowered = Object.keys(object).reduce((map, key) => {
    map[key.toLowerCase()] = object[key];
    return map;
  }, {});
  for (const key of keys) {
    const value = lowered[key.toLowerCase()];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** JSON that might be a string twice over (DeepSeek's biz_data). */
export function looseJson(value, depth = 0) {
  if (depth > 3 || value == null) return value;
  if (typeof value !== "string") return value;
  try {
    return looseJson(JSON.parse(value), depth + 1);
  } catch {
    return value;
  }
}