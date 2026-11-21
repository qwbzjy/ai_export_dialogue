/**
 * Normalises both extraction paths into one message shape before packing.
 *
 * API path: messages carry `markdown` (and `thinking[].text`).
 * DOM path:  messages carry `html`, which the export page turns into
 *            Markdown with Turndown (DOMParser lives there).
 */

const ROLES = new Set(["user", "assistant"]);

/**
 * Thinking blocks arrive as `{title, text}` from the adapters and as
 * `{title, html}` from the DOM collector. Both become `{title, markdown,
 * html}`; `text` is plain Markdown that needs no conversion.
 */
function normalizeThinking(blocks = []) {
  return blocks
    .map((block) => ({
      title: block.title || "思考过程",
      markdown: block.markdown ?? block.text ?? "",
      html: block.html ?? "",
    }))
    // A reasoning block with neither body is noise.
    .filter((block) => Boolean((block.markdown ?? "").trim() || (block.html ?? "").trim()));
}

function normalizeImages(images = []) {
  return images
    .map((image) => ({
      alt: image.alt ?? "",
      dataUri: image.dataUri ?? "",
      url: image.url || image.src || "",
    }))
    .filter((image) => image.dataUri || image.url);
}

/**
 * @param {{ source: "api"|"dom", messages: Array<object> }} raw
 * @param {{ embedImages?: import("./image.js").embedImages,
 *           onProgress?: (p: object) => void }} [options]
 */
export async function normalizeMessages(raw, { onProgress, embedImages } = {}) {
  const warnings = [];
  const messages = [];

  for (const message of raw.messages) {
    // Anything that is not explicitly a user turn is model output.
    const role = ROLES.has(message.role) ? message.role : "assistant";
    const markdown = message.markdown ?? "";
    const html = message.html ?? "";
    const thinking = normalizeThinking(message.thinking);
    const images = normalizeImages(message.images);
    const sources = message.sources ?? [];

    if (!markdown.trim() && !html.trim() && !thinking.length && !images.length) continue;

    messages.push({ role, markdown, html, thinking, images, sources });
  }

  // DOM path: images are URLs found in the cleaned HTML. Fetching happens in
  // the page; the export page could not send the site's cookies.
  const pending = [];
  for (const message of messages) {
    for (const image of message.images) {
      if (!image.dataUri && image.url && !pending.some((entry) => entry.src === image.url)) {
        pending.push({ src: image.url, alt: image.alt });
      }
    }
  }

  if (pending.length && embedImages) {
    onProgress?.({ phase: "images", done: 0, total: pending.length });
    const embedded = await embedImages(pending, {
      onProgress: (progress) => onProgress?.({ phase: "images", ...progress }),
    });
    warnings.push(...embedded.warnings);

    const byUrl = new Map(embedded.images.map((image) => [image.url, image.dataUri]));
    for (const message of messages) {
      for (const image of message.images) {
        if (!image.dataUri && image.url) image.dataUri = byUrl.get(image.url) ?? null;
      }
    }
  }

  return { messages, warnings: [...new Set(warnings)] };
}