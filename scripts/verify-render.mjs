/**
 * End-to-end check of the export page in a real browser.
 *
 * Loads the unpacked extension in headless Chrome, opens the real export page
 * (chrome-extension:// — so the MV3 CSP applies), seeds an export through
 * chrome.storage, and verifies what the page produces: the Markdown text,
 * the download it triggers, the copy button, and that the page's own
 * stylesheet still loads under the MV3 CSP.
 *
 * node scripts/verify-render.mjs
 */

import { spawn } from "node:child_process";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, "dist");
const outDir = path.join(root, "test/output");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const started = Date.now();
const stage = (name) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${name}`);

/** Rejects (with the stage name) instead of hanging a CI run forever. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
    }),
  ]);
}

/** Minimal CDP client over the DevTools WebSocket. */
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

const SAMPLE = {
  title: "二分查找与复杂度分析",
  siteName: "DeepSeek",
  site: "deepseek",
  url: "https://chat.deepseek.com/a/abc/s/xyz",
  exportedAt: new Date().toISOString(),
  source: "api",
  warnings: ["示例提示：接口不可用时自动回退"],
  messages: [
    { role: "user", markdown: "解释二分查找，并给一个 Python 例子。", thinking: [], images: [], sources: [] },
    {
      role: "assistant",
      markdown: [
        "二分查找要求数组**有序**，每次比较把区间减半，因此复杂度是 $O(\\log n)$。",
        "",
        "| 版本 | 复杂度 | 说明 |",
        "| --- | --- | --- |",
        "| 迭代 | $O(\\log n)$ | 常量空间 |",
        "| 递归 | $O(\\log n)$ | 栈空间 $O(\\log n)$ |",
        "",
        "```python",
        "def bisect(xs, target):",
        "    lo, hi = 0, len(xs) - 1",
        "    while lo <= hi:",
        "        mid = (lo + hi) // 2",
        "        if xs[mid] == target:",
        "            return mid",
        "    return -1",
        "```",
        "",
        "引用示例[citation:1]。",
      ].join("\n"),
      thinking: [{ title: "思考过程", markdown: "先确认需要解释复杂度，再给代码。" }],
      images: [],
      sources: [{ title: "二分查找 - 维基百科", url: "https://zh.wikipedia.org/wiki/二分查找" }],
    },
    { role: "user", markdown: "谢谢。", thinking: [], images: [], sources: [] },
    { role: "assistant", markdown: "不客气！", thinking: [], images: [], sources: [] },
  ],
};

async function main() {
  const profile = await mkdtemp(path.join(tmpdir(), "ai-exporter-chrome-"));
  await mkdir(outDir, { recursive: true });

  // Chrome 137+ silently ignores --load-extension. Extensions.loadUnpacked
  // over CDP is the supported replacement, so the extension is loaded after
  // startup instead of through command-line switches.
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
    stage("chrome up");

    const browser = await Cdp.connect(version.webSocketDebuggerUrl);
    const loaded = await withTimeout(
      browser.send("Extensions.loadUnpacked", { path: dist }),
      30_000,
      "load extension",
    );
    const extensionId = loaded.id;
    console.log(`extension id: ${extensionId}`);
    await sleep(700);
    stage("extension loaded");

    // chrome.storage is unavailable on about:blank, so seeding happens on the
    // extension's own origin.
    const page = await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");

    const problems = [];
    const exceptions = [];
    cdp.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        exceptions.push(message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text);
      }
    });

    const exportId = "verify1";
    const url = `chrome-extension://${extensionId}/export/export.html?id=${exportId}`;
    await cdp.send("Page.navigate", { url });
    await sleep(1200);
    stage("export page");

    const where = await cdp.send("Runtime.evaluate", {
      returnByValue: true,
      expression: `JSON.stringify({ href: location.href, ready: document.readyState, hasStorage: !!(chrome?.storage) })`,
    });
    const pageState = JSON.parse(where.result.value);
    if (!pageState.href.startsWith(`chrome-extension://${extensionId}/export/`)) {
      throw new Error(`export page did not load (${pageState.href})`);
    }

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

    const seeded = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `chrome.storage.local.set(${JSON.stringify(entries)}).then(() => "ok")`,
    });
    if (seeded.exceptionDetails) {
      throw new Error(`seeding failed: ${seeded.exceptionDetails.exception?.description ?? seeded.exceptionDetails.text}`);
    }

    // A download is triggered on load; capture it rather than letting it land
    // in a temp dir we cannot inspect.
    await cdp.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});

    await cdp.send("Page.reload");
    await sleep(1800);
    stage("seeded + reloaded");

    const state = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(() => {
        const text = document.getElementById("markdown")?.textContent ?? "";
        return JSON.stringify({
          title: document.title,
          chars: text.length,
          text,
          toolbarVisible: !document.getElementById("actions").hidden,
          status: document.getElementById("status").textContent,
          footer: document.getElementById("footer").textContent,
          copyButton: !!document.getElementById("btn-copy"),
          headings: (text.match(/^## /gm) ?? []).length,
          details: (text.match(/<details>/g) ?? []).length,
          hasTable: text.includes("| 版本 | 复杂度 | 说明 |"),
          hasFence: text.includes("\\\`\\\`\\\`python"),
          hasMath: text.includes("$O(\\\\log n)$"),
          hasSources: text.includes("- [二分查找 - 维基百科](https://zh.wikipedia.org/wiki/二分查找)"),
          hasWarning: text.includes("导出提示"),
        });
      })()`,
    });
    if (state.exceptionDetails) {
      throw new Error(`inspection failed: ${state.exceptionDetails.exception?.description ?? state.exceptionDetails.text}`);
    }
    const summary = JSON.parse(state.result.value);
    const { text, ...checks } = summary;
    console.log("rendered:", checks);

    if (checks.title !== SAMPLE.title) problems.push(`document title: ${checks.title}`);
    if (checks.headings !== SAMPLE.messages.length) problems.push(`role headings: ${checks.headings}`);
    if (checks.details !== 1) problems.push(`thinking <details>: ${checks.details}`);
    if (!checks.hasTable) problems.push("table lost");
    if (!checks.hasFence) problems.push("python fence lost");
    if (!checks.hasMath) problems.push("math lost");
    if (!checks.hasSources) problems.push("source list lost");
    if (!checks.hasWarning) problems.push("warning lost");
    if (!checks.toolbarVisible) problems.push("toolbar hidden");
    if (!checks.copyButton) problems.push("copy button missing");
    if (!checks.status.includes("已开始下载")) problems.push(`status: ${checks.status}`);
    if (exceptions.length) problems.push(`page exceptions: ${exceptions.join(" | ")}`);
    // The preview must be the file itself, not a rendering of it.
    if (!text.startsWith(`# ${SAMPLE.title}`)) problems.push("preview does not start with the title");
    if (!text.endsWith("\n")) problems.push("file does not end with a newline");

    // Download path: intercept the blob the page creates and read it back.
    const downloadCheck = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const original = URL.createObjectURL;
        let captured = null;
        URL.createObjectURL = (blob) => {
          captured = blob;
          return original.call(URL, blob);
        };
        document.getElementById("btn-markdown").click();
        URL.createObjectURL = original;
        if (!captured) return JSON.stringify({ ok: false });
        const fileText = await captured.text();
        return JSON.stringify({ ok: true, type: captured.type, bytes: captured.size, matchesPreview: fileText === document.getElementById("markdown").textContent });
      })()`,
    });
    if (downloadCheck.exceptionDetails) {
      problems.push(`download check failed: ${downloadCheck.exceptionDetails.exception?.description}`);
    } else {
      const result = JSON.parse(downloadCheck.result.value);
      console.log("download:", result);
      if (!result.ok) problems.push("download button produced no blob");
      else {
        if (!result.type.startsWith("text/markdown")) problems.push(`download type: ${result.type}`);
        if (!result.matchesPreview) problems.push("downloaded file differs from the preview");
      }
    }

    // Copy button (clipboard may be refused without a user gesture; the code
    // falls back to selecting the text, so either outcome is acceptable —
    // what matters is that nothing throws).
    const copyCheck = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => { document.getElementById("btn-copy").click(); await new Promise(r => setTimeout(r, 150)); return document.getElementById("status").dataset.kind ?? "info"; })()`,
    });
    if (copyCheck.exceptionDetails) problems.push(`copy button threw: ${copyCheck.exceptionDetails.exception?.description}`);

    // Cheap regression guard: a CSP break would leave the page unstyled.
    const csp = await cdp.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `JSON.stringify({ styleSheets: document.styleSheets.length, bodyBg: getComputedStyle(document.body).backgroundColor })`,
    });
    const cspState = JSON.parse(csp.result.value);
    if (cspState.styleSheets === 0) problems.push("stylesheet blocked (CSP)");

    await writeFile(path.join(outDir, "sample.md"), text);
    stage("sample.md written");

    if (problems.length) {
      console.log("\nPROBLEMS:");
      for (const problem of problems) console.log(` - ${problem}`);
      process.exitCode = 1;
    } else {
      console.log("\nall export checks passed");
    }

    cdp.close();
  } finally {
    chrome.kill("SIGKILL");
    await sleep(200);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});