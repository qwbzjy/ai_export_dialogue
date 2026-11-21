import { SITE_LIST, siteForUrl } from "../sites/index.js";

const els = {
  site: document.getElementById("site"),
  actions: document.getElementById("actions"),
  note: document.getElementById("note"),
  list: document.getElementById("site-list"),
};

els.list.innerHTML = SITE_LIST.map((site) => `<li>${site.name}</li>`).join("");

let tab = null;

function setNote(text, { kind = "info" } = {}) {
  els.note.textContent = text;
  els.note.dataset.kind = kind;
}

function setBusy(busy) {
  for (const button of els.actions.querySelectorAll("button")) button.disabled = busy;
}

/**
 * Messaging fails when the content script is not in the tab — the extension
 * was just installed or reloaded, or the tab predates it. Injecting it on
 * demand is why `scripting` is a permission.
 */
async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (pong !== undefined) return true;
  } catch {
    /* not injected yet */
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return true;
  } catch (error) {
    console.warn("[ai-exporter] inject failed", error);
    return false;
  }
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = tab?.url ? siteForUrl(tab.url) : null;

  if (!site) {
    els.site.textContent = "当前页面不受支持";
    els.site.dataset.state = "unsupported";
    setNote("打开支持站点的对话页后再点这里。");
    return;
  }

  els.site.textContent = `${site.name}：${site.isConversationUrl(tab.url) ? "对话页" : "非对话页"}`;
  els.site.dataset.state = "ready";
  els.actions.hidden = false;

  if (!site.isConversationUrl(tab.url)) {
    setNote("当前不是会话页面，请先打开一个对话。", { kind: "error" });
  }
}

els.actions.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button || !tab) return;

  setBusy(true);
  setNote("正在读取会话…");

  const ready = await ensureContentScript(tab.id);
  if (!ready) {
    setNote("无法在当前页面运行，请刷新页面后重试。", { kind: "error" });
    setBusy(false);
    return;
  }

  try {
    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "RUN_EXPORT",
      useApi: button.dataset.action !== "export-dom",
    });
    if (result?.ok) {
      setNote(`已导出 ${result.messages} 条消息，Markdown 已开始下载。`);
      setTimeout(() => window.close(), 900);
    } else {
      setNote(result?.error ?? "导出失败", { kind: "error" });
      setBusy(false);
    }
  } catch (error) {
    setNote(`导出失败：${error?.message ?? error}`, { kind: "error" });
    setBusy(false);
  }
});

init().catch((error) => setNote(`初始化失败：${error?.message ?? error}`, { kind: "error" }));