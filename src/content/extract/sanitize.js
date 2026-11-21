/**
 * Cleaning a message subtree before it leaves the page.
 *
 * Two jobs:
 *  1. Remove UI chrome the sites mix into message bubbles (copy buttons,
 *     like/dislike, regenerate, speak, toolbars).
 *  2. Make sure nothing executable survives — the export page is a
 *     chrome-extension:// page with extension privileges, so its renderer
 *     must never receive <script>, <iframe>, event handlers or javascript: URLs.
 */

const NOISE_SELECTORS = [
  // Buttons and control clusters, common across all five sites.
  "button",
  "[role='button']",
  "[class*='toolbar']",
  "[class*='Toolbar']",
  "[class*='action-control']",
  "[class*='actionControl']",
  "[class*='copy-btn']",
  "[class*='copyBtn']",
  "[class*='feedback']",
  "[class*='share-btn']",
  "[class*='regenerate']",
  "[class*='speak']",
  "[class*='tts']",
  "[class*='skeleton']",
  "[class*='Skeleton']",
  // Site-specific leftovers.
  ".ToolbarCopy_",
  ".agent-chat__toolbar",
  ".qwen-chat-package-comp-new-action-control",
  ".qwen-chat-thinking-tool-status-card-wraper",
];
// All entries above are valid CSS selectors as written (attribute and class
// selectors only), so they can be joined directly.
const NOISE_RE = NOISE_SELECTORS.join(",");

const DROP_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "object",
  "embed",
  "link",
  "meta",
  "svg",
  "video",
  "audio",
  "canvas",
  "form",
  "input",
  "textarea",
  "select",
  "button",
  "noscript",
]);

const ALLOWED_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "colspan",
  "rowspan",
  "class",
  "lang",
  "start",
  "data-lang",
  "data-language",
  // Marks the <details> that carries reasoning; the collector pulls those
  // out of the body before serialising.
  "data-thinking",
]);

const SAFE_URL = /^(https?:|data:image\/|#)/i;

/**
 * Returns a cleaned clone of `node`. Cloning first keeps the live page
 * untouched (the sites react to DOM mutations).
 */
export function cleanNode(node) {
  if (!node) return null;
  const clone = node.cloneNode(true);

  for (const match of [...clone.querySelectorAll(NOISE_RE)]) match.remove();
  for (const element of [...clone.querySelectorAll("*")]) {
    if (DROP_TAGS.has(element.tagName.toLowerCase())) {
      element.remove();
      continue;
    }
    for (const attr of [...element.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if (!ALLOWED_ATTRS.has(name)) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "src") && !SAFE_URL.test(attr.value.trim())) {
        element.removeAttribute(attr.name);
      }
    }
  }

  // Images: keep only real sources, remember the original for fetching.
  for (const img of clone.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!/^https?:|^data:image\//i.test(src)) {
      img.remove();
      continue;
    }
    img.setAttribute("data-original-src", src);
  }

  return clone;
}

/** Plain-text preview used for de-duplication and empty-message checks. */
export function textOf(node) {
  return (node?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** The pieces of a cleaned node, as markup the export page can turn into Markdown. */
export function htmlOf(cleanedNode) {
  if (!cleanedNode) return "";
  return cleanedNode.innerHTML ?? "";
}