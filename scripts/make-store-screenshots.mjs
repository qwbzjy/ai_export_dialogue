/**
 * Capture Chrome Web Store screenshots (1280x800) from the real extension.
 *
 * The store requires at least one screenshot and rejects listings without it,
 * so this produces them from the actual built page rather than a mock:
 *
 *   node build.mjs && node scripts/make-store-screenshots.mjs
 *
 * Writes test/output/shot-export.png and test/output/shot-popup.png, which
 * scripts/compose-screenshots.py then lays out into store/.
 *
 * Captured at deviceScaleFactor 2 and downscaled by the compositor, so text
 * stays crisp at 1280x800.
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const outDir = path.join(root, "test/output");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const W = 1280;
const H = 800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

const httpJson = async (url, init) => (await fetch(url, init)).json();

/** A believable conversation: roles, folded reasoning, table, code, sources. */
const SAMPLE = {
  title: "二分查找的复杂度与实现",
  siteName: "DeepSeek",
  site: "deepseek",
  url: "https://chat.deepseek.com/a/8f2c/s/1d9b",
  exportedAt: new Date().toISOString(),
  source: "api",
  warnings: [],
  messages: [
    {
      role: "user",
      markdown: "解释一下二分查找，并给一个 Python 例子。",
      thinking: [],
      images: [],
      sources: [],
    },
    {
      role: "assistant",
      markdown: [
        "二分查找要求数组**有序**。每次取中间元素与目标比较，把搜索区间缩小一半，因此时间复杂度是 $O(\\log n)$。",
        "",
        "| 实现方式 | 时间复杂度 | 额外空间 |",
        "| --- | --- | --- |",
        "| 迭代 | $O(\\log n)$ | $O(1)$ |",
        "| 递归 | $O(\\log n)$ | $O(\\log n)$ |",
        "",
        "```python",
        "def bisect(xs, target):",
        "    lo, hi = 0, len(xs) - 1",
        "    while lo <= hi:",
        "        mid = (lo + hi) // 2",
        "        if xs[mid] == target:",
        "            return mid",
        "        if xs[mid] < target:",
        "            lo = mid + 1",
        "        else:",
        "            hi = mid - 1",
        "    return -1",
        "```",
        "",
        "注意循环条件是 `lo <= hi`；写成 `lo < hi` 会漏掉最后一个元素。",
      ].join("\n"),
      thinking: [
        {
          title: "思考过程",
          markdown: "用户要的是概念加示例，先讲区间收缩的直觉，再给可直接运行的代码，最后提一个常见边界错误。",
        },
      ],
      images: [],
      sources: [{ title: "二分查找 - 维基百科", url: "https://zh.wikipedia.org/wiki/二分查找" }],
    },
  ],
};

async function main() {
  const profile = await mkdtemp(path.join(tmpdir(), "ai-exporter-shots-"));
  await mkdir(outDir, { recursive: true });

  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--enable-unsafe-extension-debugging",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    let version = null;
    for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
      await sleep(250);
      try {
        version = await httpJson(`http://127.0.0.1:${PORT}/json/version`);
      } catch {
        /* not up yet */
      }
    }
    if (!version) throw new Error(`Chrome did not start\n${stderr.slice(-2000)}`);

    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    const { id: extensionId } = await browser.send("Extensions.loadUnpacked", { path: dist });
    await sleep(700);
    console.log("extension id:", extensionId);

    const page = await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});

    /* -------- 1. export preview page -------- */
    const exportId = "shots1";
    const entries = { [`exp:${exportId}:m:count`]: { count: SAMPLE.messages.length } };
    SAMPLE.messages.forEach((message, index) => {
      entries[`exp:${exportId}:m:${index}`] = message;
    });
    entries[`exp:${exportId}:meta`] = {
      __isMeta: true,
      createdAt: Date.now(),
      id: exportId,
      site: SAMPLE.site,
      siteName: SAMPLE.siteName,
      title: SAMPLE.title,
      url: SAMPLE.url,
      exportedAt: SAMPLE.exportedAt,
      source: SAMPLE.source,
      messageCount: SAMPLE.messages.length,
      imageCount: 0,
      warnings: SAMPLE.warnings,
    };
    entries["exp:index"] = { [exportId]: Date.now() };

    await cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/export/export.html?id=${exportId}` });
    await sleep(1200);
    await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `chrome.storage.local.set(${JSON.stringify(entries)}).then(() => "ok")`,
    });
    await cdp.send("Page.reload");
    await sleep(2000);

    const exportShot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(outDir, "shot-export.png"), Buffer.from(exportShot.data, "base64"));
    console.log("shot-export.png");

    /* -------- 2. popup, with a plausible active tab -------- */
    // The popup asks chrome.tabs for the active tab. Stubbing the API before
    // popup.js runs is the only way to show the "ready" state outside a real
    // chat site; if the API cannot be patched the shot falls back to the
    // unsupported state, which is still a truthful picture of the popup.
    const popupCdp = await Cdp.connect(
      (await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).webSocketDebuggerUrl,
    );
    await popupCdp.send("Page.enable");
    await popupCdp.send("Runtime.enable");
    await popupCdp.send("Emulation.setDeviceMetricsOverride", {
      width: 420,
      height: 560,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await popupCdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        try {
          chrome.tabs.query = async () => ([{
            id: 1,
            url: "https://chat.deepseek.com/a/8f2c/s/1d9b",
            title: "二分查找的复杂度与实现"
          }]);
        } catch (error) { /* read-only binding */ }
      `,
    });
    await popupCdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/popup/popup.html` });
    await sleep(1000);

    const state = await popupCdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `JSON.stringify({
        site: document.getElementById("site").textContent,
        actionsHidden: document.getElementById("actions").hidden
      })`,
    });
    console.log("popup state:", state.result.value);

    const popupShot = await popupCdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(outDir, "shot-popup.png"), Buffer.from(popupShot.data, "base64"));
    console.log("shot-popup.png");

    popupCdp.close();
    cdp.close();
    browser.close();
  } finally {
    chrome.kill("SIGKILL");
    await sleep(200);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});