/**
 * Service worker.
 *
 * Deliberately stateless: MV3 workers are killed after ~30s idle and a
 * single event is capped at 5 minutes. Every long loop (pagination, DOM
 * scrolling, image fetching) happens in the content script instead.
 *
 * Its two jobs:
 *  - CORS proxy: fetch a URL from the extension origin with cookies and
 *    return the raw text/base64. Used for hosts the page cannot reach
 *    (qianwen's API host, authenticated image CDNs).
 *  - Open the export page and clean up leftover export data.
 *
 * Export format is Markdown only. A PDF path would need a rendering page,
 * a canvas and several megabytes of libraries for a file the user can make
 * from the .md with any Markdown viewer.
 */

import { INDEX_KEY, PREFIX, deleteExport, sweepExports } from "./util/export-store.js";

chrome.runtime.onInstalled.addListener(() => sweepStaleExports());
chrome.runtime.onStartup.addListener(() => sweepStaleExports());

/**
 * Startup cleanup. The one place `get(null)` is acceptable: it runs at
 * startup, not on a user's export path, and a crash or an extension reload
 * can leave exp:* keys whose export never reached the index.
 */
async function sweepStaleExports() {
  try {
    const all = await chrome.storage.local.get(null);
    const known = all[INDEX_KEY] && typeof all[INDEX_KEY] === "object" ? all[INDEX_KEY] : {};
    const orphans = Object.keys(all)
      .filter((key) => key.startsWith(PREFIX) && key.endsWith(":meta"))
      .map((key) => key.slice(PREFIX.length, -":meta".length))
      .filter((id) => !(id in known));

    if (orphans.length) {
      const keys = [];
      for (const id of orphans) {
        const meta = all[`${PREFIX}${id}:meta`];
        const count = meta?.messageCount ?? 0;
        const images = meta?.imageCount ?? 0;
        keys.push(`${PREFIX}${id}:meta`, `${PREFIX}${id}:m:count`);
        for (let index = 0; index < count; index += 1) keys.push(`${PREFIX}${id}:m:${index}`);
        for (let index = 0; index < images; index += 1) keys.push(`${PREFIX}${id}:img:${index}`);
      }
      await chrome.storage.local.remove(keys);
    }

    await sweepExports();
  } catch (error) {
    console.warn("[ai-exporter] sweep failed", error);
  }
}

async function fetchAsText({ url, method = "GET", headers = {}, body, timeoutMs = 25_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body,
      credentials: "include",
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAsDataUrl({ url, timeoutMs = 25_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024) throw new Error("image too large");
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < buffer.length; index += chunk) {
      binary += String.fromCharCode.apply(null, buffer.subarray(index, index + chunk));
    }
    return {
      ok: true,
      dataUrl: `data:${blob.type || "image/png"};base64,${btoa(binary)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readCookie({ url, name }) {
  const cookie = await chrome.cookies.get({ url, name });
  return { ok: true, value: cookie?.value ?? null };
}

/**
 * The export page is opened for exactly one export. Cleanup belongs here, on
 * the tab lifecycle, not in the page's `beforeunload`: a reload (or a crash
 * restore) fires that event too, and deleting on reload would destroy data
 * the page is still showing.
 */
async function openExportPage({ id }) {
  const url = chrome.runtime.getURL(`export/export.html?id=${encodeURIComponent(id)}`);
  const tab = await chrome.tabs.create({ url, active: true });
  if (tab?.id != null) pendingExportTabs.set(tab.id, id);
  return { ok: true };
}

const pendingExportTabs = new Map();

chrome.tabs.onRemoved.addListener((tabId) => {
  const id = pendingExportTabs.get(tabId);
  if (!id) return;
  pendingExportTabs.delete(tabId);
  deleteExport(id);
});

// A navigation away also ends the export's useful life; a reload is fine,
// because the same tab id is kept for the same document URL.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const id = pendingExportTabs.get(tabId);
  if (!id || !changeInfo.url) return;
  if (changeInfo.url.includes(`id=${encodeURIComponent(id)}`)) return;
  pendingExportTabs.delete(tabId);
  deleteExport(id);
});

const handlers = {
  API_FETCH: fetchAsText,
  IMAGE_FETCH: fetchAsDataUrl,
  READ_COOKIE: readCookie,
  OPEN_EXPORT: openExportPage,
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));

  // Keep the message channel open for the async response.
  return true;
});