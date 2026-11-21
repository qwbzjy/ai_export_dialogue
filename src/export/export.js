/**
 * The export page: preview the generated Markdown, then download it.
 *
 * A page (rather than a direct download from the content script) because a
 * blob URL can only be created where the document lives, and because the
 * user gets to look at the result before saving it. Showing the exact file
 * text in a <pre> means the preview cannot drift from the download.
 */

import { readExport, sweepExports } from "./storage.js";
import { buildMarkdown } from "./markdown.js";
import { exportFileName } from "../util/filename.js";

const params = new URLSearchParams(location.search);
const exportId = params.get("id");

const els = {
  doc: document.getElementById("doc"),
  markdown: document.getElementById("markdown"),
  title: document.getElementById("doc-title"),
  status: document.getElementById("status"),
  actions: document.getElementById("actions"),
  footer: document.getElementById("footer"),
  download: document.getElementById("btn-markdown"),
  copy: document.getElementById("btn-copy"),
};

let markdown = "";
let filename = "";

function setStatus(text, { kind = "info" } = {}) {
  if (!text) {
    els.status.hidden = true;
    return;
  }
  els.status.hidden = false;
  els.status.dataset.kind = kind;
  els.status.textContent = text;
}

function download() {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function copy() {
  try {
    await navigator.clipboard.writeText(markdown);
    setStatus("已复制到剪贴板。");
  } catch {
    // Clipboard permission can be denied; selecting the text is the fallback.
    const range = document.createRange();
    range.selectNodeContents(els.markdown);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    setStatus("无法自动复制，已选中内容，请按 ⌘C / Ctrl+C。", { kind: "error" });
  }
}

async function load() {
  let data;
  try {
    data = await readExport(exportId);
  } catch (error) {
    setStatus(error.message, { kind: "error" });
    return;
  }

  if (!data.messages.length) {
    setStatus("没有可导出的消息", { kind: "error" });
    return;
  }

  markdown = buildMarkdown(data);
  filename = exportFileName({ siteName: data.siteName, title: data.title, ext: "md" });

  document.title = data.title;
  els.title.textContent = data.title;
  els.markdown.textContent = markdown;
  els.actions.hidden = false;
  els.footer.hidden = false;
  els.footer.textContent = `${data.messages.length} 条消息 · ${new Blob([markdown]).size.toLocaleString()} 字节`;

  // The common case ("just export markdown") saves without extra clicks.
  download();
  setStatus("已开始下载；上方按钮可再次下载。");
}

els.download?.addEventListener("click", () => download());
els.copy?.addEventListener("click", () => copy());

/*
 * No unload cleanup on purpose. The service worker deletes the export when
 * this tab closes; doing it in `beforeunload` would also wipe the data on an
 * ordinary reload, leaving a blank page.
 */
sweepExports();
load();