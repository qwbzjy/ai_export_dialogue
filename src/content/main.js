/**
 * Content script: ties a site adapter to the floating UI and the storage pack.
 *
 * It is injected once per page (`run_at: document_idle`), but these are SPAs:
 * the URL changes without a reload, so route changes are watched and the
 * button's visibility follows them.
 */

import { siteForUrl } from "../sites/index.js";
import { collectFromDom } from "./extract/collect.js";
import { normalizeMessages } from "./extract/convert.js";
import { ExtractionError } from "./extract/api.js";
import { embedImages } from "./extract/image.js";
import { newExportId, packExport } from "./extract/pack.js";
import { createUi } from "./ui.js";

const POSITION_KEY = `position:${location.origin}`;

let ui = null;
let site = null;

function send(message) {
  try {
    return chrome.runtime.sendMessage(message);
  } catch (error) {
    // The extension was reloaded/updated while this page stayed open.
    throw new ExtractionError("插件已更新，请刷新页面后重试", "context");
  }
}

/* ---------------- extraction ---------------- */

async function extract(adapter, { useApi, onProgress }) {
  if (useApi) {
    try {
      if (!adapter.isLoggedIn()) throw new ExtractionError("未登录", "auth");
      if (adapter.isGenerating?.()) {
        throw new ExtractionError("回答仍在生成中，请稍后再导出", "generating");
      }
      const result = await adapter.extractFromApi();
      if (result?.messages?.length) {
        return { ...result, messages: result.messages.map((message) => ({ ...message, images: message.images ?? [] })) };
      }
      throw new ExtractionError("接口没有返回消息", "empty");
    } catch (error) {
      if (error instanceof ExtractionError && error.code === "generating") throw error;
      onProgress?.({ phase: "fallback", reason: error?.message ?? "接口不可用" });
    }
  }

  // Reasoning lives behind the site's own toggle; open it before snapshotting
  // so the collected DOM contains the text rather than an empty shell.
  if (adapter.expandThinking) {
    try {
      await adapter.expandThinking();
    } catch {
      /* the DOM fallback below still gets the visible content */
    }
  }

  const collected = await collectFromDom({
    getMessages: adapter.domFallback.getMessages,
    getScrollContainer: adapter.domFallback.getScrollContainer,
    onProgress: ({ count, step }) => onProgress?.({ phase: "dom", count, step }),
  });

  if (!collected.messages.length) {
    throw new ExtractionError(
      "页面上没有可导出的消息（若刚打开会话，等它加载完再试）",
      "empty",
    );
  }

  const warnings = [];
  if (!collected.complete) {
    warnings.push("导出时页面处于后台，部分内容可能未加载完整。");
  }

  return {
    source: "dom",
    title: adapter.getTitle?.() || document.title,
    messages: collected.messages,
    warnings,
  };
}

async function runExport({ useApi = true } = {}) {
  // Capture the adapter: the page can navigate mid-export.
  const adapter = site;
  if (!adapter) return { ok: false, error: "当前页面不受支持" };

  ui.setState("busy", "读取中…");
  ui.hideToast();

  try {
    if (!adapter.isConversationUrl(location.href)) {
      throw new ExtractionError("当前不是会话页面，请先打开一个对话", "not-conversation");
    }

    const raw = await extract(adapter, {
      useApi,
      onProgress: (progress) => {
        if (progress.phase === "dom") ui.setState("busy", `加载历史… ${progress.count} 条`);
        if (progress.phase === "fallback") ui.showToast(`接口不可用，改用页面内容（${progress.reason}）`);
      },
    });

    ui.setState("busy", "整理内容…");
    const normalized = await normalizeMessages(raw, {
      embedImages,
      onProgress: (progress) => {
        if (progress.phase === "images") ui.setState("busy", `处理图片 ${progress.done}/${progress.total}`);
      },
    });
    const { messages } = normalized;
    const warnings = [...new Set([...(raw.warnings ?? []), ...normalized.warnings])];

    if (!messages.length) throw new ExtractionError("没有可导出的内容", "empty");

    ui.setState("busy", "保存中…");
    const id = newExportId();
    const meta = {
      site: adapter.id,
      siteName: adapter.name,
      title: raw.title || adapter.getTitle?.() || document.title,
      url: location.href,
      exportedAt: new Date().toISOString(),
      source: raw.source,
      messageCount: messages.length,
      warnings,
    };

    try {
      await packExport({ id, meta, messages });
    } catch (error) {
      throw new ExtractionError(`保存失败：${error?.message ?? error}`, "storage");
    }

    await send({ type: "OPEN_EXPORT", id });
    ui.setState("idle");
    ui.showToast(`已生成 ${messages.length} 条消息，正在打开导出页`);
    return { ok: true, messages: messages.length };
  } catch (error) {
    const message = error?.message ?? String(error);
    console.warn("[ai-exporter]", error);
    if (error?.code === "auth") {
      ui.showToast("未登录或登录已失效，请重新登录后再试", { sticky: true });
    } else {
      ui.showToast(message, { sticky: true });
    }
    ui.setState("error", "导出失败");
    return { ok: false, error: message };
  }
}

/* ---------------- boot ---------------- */

async function loadPosition() {
  try {
    const stored = await chrome.storage.local.get(POSITION_KEY);
    return stored[POSITION_KEY] ?? null;
  } catch {
    return null;
  }
}

async function savePosition(position) {
  try {
    if (site) await chrome.storage.local.set({ [POSITION_KEY]: position });
  } catch {
    /* position is a convenience, never fatal */
  }
}

let mounted = false;

async function boot() {
  site = siteForUrl(location.href);
  if (!site) return;

  if (!ui) {
    ui = createUi({
      onExport: (options) => runExport(options),
      origin: location.origin,
      setPosition: savePosition,
    });
    ui.applyPosition(await loadPosition());
  }

  ui.mount();
  mounted = true;
  updateVisibility();
}

function updateVisibility() {
  if (!ui) return;
  if (!site || !mounted) return;
  const host = document.querySelector("#ai-exporter-host");
  if (!host) return;
  host.style.display = "";
}

function watchRoute() {
  let lastUrl = location.href;

  const changed = () => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    site = siteForUrl(location.href);
    if (!site) return;
    boot();
  };

  window.addEventListener("popstate", changed);
  window.addEventListener("navigation", changed);
  // Fallback for history.pushState without an event; cheap and idle otherwise.
  return setInterval(changed, 500);
}

/* ---------------- messages from popup ---------------- */

function onMessage(message, _sender, sendResponse) {
  if (message?.type === "PING") {
    sendResponse({ ok: true, site: siteForUrl(location.href)?.id ?? null });
    return false;
  }
  if (message?.type !== "RUN_EXPORT") return false;

  if (!adapterAt(location.href)) {
    sendResponse({ ok: false, error: "当前页面不受支持" });
    return false;
  }

  runExport({ useApi: message.useApi !== false })
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message ?? String(error) }));

  return true;
}

/** The adapter for this page, whether or not boot has finished yet. */
function adapterAt(url) {
  return site ?? siteForUrl(url);
}

/*
 * The popup re-injects this file when its PING went unanswered (which is what
 * happens after an extension reload, when the old copy's chrome APIs are dead
 * but its DOM and listeners may linger). Remove the previous listeners first,
 * otherwise every injected copy would run the same export once.
 */
const STATE = Symbol.for("ai-exporter.state");
const previous = window[STATE];
for (const listener of previous?.listeners ?? []) {
  try {
    chrome.runtime.onMessage.removeListener(listener);
  } catch {
    /* belongs to a context that no longer exists */
  }
}
if (previous?.routeTimer) clearInterval(previous.routeTimer);

chrome.runtime.onMessage.addListener(onMessage);
window[STATE] = { listeners: [onMessage], routeTimer: null };

boot().catch((error) => console.warn("[ai-exporter] boot failed", error));
window[STATE].routeTimer = watchRoute();