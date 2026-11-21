/**
 * HTML → Markdown, used only for DOM-derived messages.
 *
 * The APIs hand back Markdown; only the DOM fallback needs conversion. This
 * runs in the export page (not the content script) so the bundled Turndown
 * stays small and the extension-page environment provides a real DOMParser.
 */

import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const service = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  hr: "---",
  emDelimiter: "*",
});

service.use(gfm);
service.remove(["script", "style", "noscript", "iframe", "button", "input", "svg"]);

/*
 * Code blocks keep their language, which the sites put on either the <pre>
 * or the inner <code> (as a `language-x` class, a `data-lang` attribute, or
 * the header label of a code card).
 */
service.addRule("fencedCode", {
  filter: (node) => node.nodeName === "PRE",
  replacement: (_content, node) => {
    const code = node.querySelector("code") ?? node;
    const language = detectLanguage(node, code);
    const text = code.textContent.replace(/\n+$/, "");
    const fence = text.includes("```") ? "~~~~" : "```";
    return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
  },
});

function detectLanguage(pre, code) {
  const candidates = [
    code.getAttribute?.("data-language"),
    code.getAttribute?.("data-lang"),
    pre.getAttribute?.("data-language"),
    pre.getAttribute?.("data-lang"),
    ...[...(code.className ?? "").split(/\s+/)].filter((name) => name.startsWith("language-")),
    ...[...(pre.className ?? "").split(/\s+/)].map((name) => name.replace(/^lang-/, "")),
  ].filter(Boolean);

  const header = pre.querySelector("[class*='header']")?.textContent?.trim();
  if (header && /^[\w+#.-]{1,20}$/.test(header)) candidates.push(header);

  const value = candidates
    .map((candidate) => candidate.replace(/^language-/, "").toLowerCase())
    .find((candidate) => /^[a-z0-9+#._-]+$/.test(candidate));

  return value && value !== "text" && value !== "plaintext" ? value : "";
}

/* Tables survive via GFM; images become Markdown images with their data URL. */
service.addRule("image", {
  filter: "img",
  replacement: (_content, node) => {
    const src = node.getAttribute("src") ?? "";
    const alt = (node.getAttribute("alt") ?? "").replace(/[[\]]/g, "");
    return src ? `![${alt}](${src})` : "";
  },
});

/** Removes the UI chrome that survived sanitising, then converts. */
function prepare(html) {
  const doc = new DOMParser().parseFromString(`<div id="root">${html}</div>`, "text/html");
  const root = doc.getElementById("root");

  for (const node of root.querySelectorAll("[class*='toolbar'], [class*='Toolbar'], [class*='action-control']")) {
    node.remove();
  }
  // Collapsed panels are hidden in the browser but their text is content.
  for (const details of root.querySelectorAll("details")) details.setAttribute("open", "");

  return root;
}

export function htmlToMarkdown(html) {
  if (!html) return "";
  try {
    const root = prepare(html);
    return tidyMarkdown(service.turndown(root.innerHTML));
  } catch (error) {
    console.warn("[ai-exporter] html to markdown failed", error);
    return tidyMarkdown(prepare(html).textContent ?? "");
  }
}

function tidyMarkdown(markdown) {
  return markdown
    .replace(/ /g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/^\s+|\s+$/g, "");
}