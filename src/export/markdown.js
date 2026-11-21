/**
 * The export file itself.
 *
 * This module produces the .md text and nothing else: the extension ships
 * Markdown only, so there is no HTML renderer, no KaTeX and no PDF pipeline.
 * The export page shows exactly these bytes in a <pre>, which means the
 * preview cannot differ from the downloaded file.
 */

import { htmlToMarkdown } from "./html-to-md.js";

/** Markdown text for DOM-derived thinking blocks. */
function thinkingMarkdown(block) {
  if (block.markdown) return block.markdown;
  if (block.html) return htmlToMarkdown(block.html);
  return "";
}

function messageMarkdown(message) {
  if (message.markdown) return message.markdown;
  if (message.html) return htmlToMarkdown(message.html);
  return "";
}

function displayRole(role, siteName) {
  return role === "user" ? "👤 用户" : `🤖 ${siteName}`;
}

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

/**
 * @param {object} data  unified export data (see content/extract/convert.js)
 * @returns {string} the .md file contents
 */
export function buildMarkdown(data) {
  const { title, siteName, url, exportedAt } = data;
  const lines = [`# ${title}`, ""];

  const meta = [`来源：${siteName}`];
  if (url) meta.push(`链接：${url}`);
  if (exportedAt) meta.push(`导出时间：${formatDate(exportedAt)}`);
  if (data.source === "dom") meta.push("提取方式：页面内容（接口不可用）");
  lines.push(`> ${meta.join(" · ")}`, "");

  for (const message of data.messages) {
    lines.push(`## ${displayRole(message.role, siteName)}`, "");

    for (const block of message.thinking ?? []) {
      const body = thinkingMarkdown(block);
      if (!body) continue;
      lines.push("<details>", `<summary>${block.title || "思考过程"}</summary>`, "", body, "", "</details>", "");
    }

    const body = messageMarkdown(message);
    if (body) lines.push(body, "");

    for (const image of message.images ?? []) {
      const src = image.dataUri || image.url;
      if (!src) continue;
      lines.push(`![${image.alt || "图片"}](${src})`, "");
    }

    for (const source of message.sources ?? []) {
      if (!source.url) continue;
      lines.push(`- [${source.title || source.url}](${source.url})`);
    }
    if (message.sources?.length) lines.push("");
  }

  if (data.warnings?.length) {
    lines.push("---", "", "> 导出提示：" + data.warnings.join("；"), "");
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}