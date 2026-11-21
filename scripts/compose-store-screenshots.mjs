/**
 * Compose the 1280x800 Chrome Web Store screenshots.
 *
 * screenshot 1: the export preview page, downscaled from the 2x capture
 * screenshot 2: the popup on a branded backdrop, with feature copy
 *
 * Both are 1280x800, which the store prefers over 640x400. Rendering the
 * second one in Chrome (rather than compositing pixels by hand) keeps the
 * Chinese text shapes native.
 *
 *   node build.mjs && node scripts/make-store-screenshots.mjs
 *   node scripts/compose-store-screenshots.mjs
 */

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "test/output");
const storeDir = path.join(root, "store");

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9335;
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

/** The composed page: popup card on the icon's own gradient. */
function popupPage(popupDataUri) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    display: flex; align-items: center; justify-content: center; gap: 76px;
    padding: 0 88px;
    background:
      radial-gradient(900px 520px at 12% 8%, rgba(56,189,248,.20), transparent 70%),
      radial-gradient(760px 480px at 92% 92%, rgba(168,85,247,.24), transparent 70%),
      linear-gradient(118deg, #0a1730 0%, #11224a 46%, #2a1a4d 100%);
    font: 400 15px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #eef4ff;
  }
  .shot { flex: none; width: 440px; filter: drop-shadow(0 28px 56px rgba(2,8,24,.55)); }
  .shot img {
    display: block; width: 100%; height: auto;
    border-radius: 14px;
    box-shadow: 0 0 0 1px rgba(255,255,255,.16);
  }
  .copy { width: 520px; }
  .brand { display: flex; align-items: center; gap: 14px; margin-bottom: 26px; }
  .brand img { width: 64px; height: 64px; border-radius: 16px; }
  .brand b { font-size: 26px; letter-spacing: .5px; }
  h1 { font-size: 34px; line-height: 1.35; font-weight: 700; margin-bottom: 22px; }
  h1 em { font-style: normal; color: #67e8f9; }
  ul { list-style: none; display: grid; gap: 14px; }
  li { display: flex; align-items: flex-start; gap: 11px; font-size: 16px; color: #c7d6ee; }
  li::before {
    content: ""; flex: none; width: 9px; height: 9px; margin-top: 8px;
    border-radius: 50%; background: #22d3ee;
    box-shadow: 0 0 10px 2px rgba(34,211,238,.55);
  }
</style></head>
<body>
  <div class="shot"><img src="${popupDataUri}" alt=""></div>
  <div class="copy">
    <div class="brand"><img src="${ICON_URI}" alt=""><b>AI 对话导出</b></div>
    <h1>把对话存成<br><em>干净的一份 Markdown</em></h1>
    <ul>
      <li>接口优先：拿到站点原生 Markdown，不受虚拟化列表影响</li>
      <li>推理过程折叠保留，表格、公式、代码围栏原样输出</li>
      <li>图片 base64 内嵌，单个 .md 文件自包含</li>
      <li>token 只用于本机请求，不保存、不上传</li>
    </ul>
  </div>
</body></html>`;
}

let ICON_URI = "";

async function main() {
  await mkdir(storeDir, { recursive: true });

  const profile = await mkdtemp(path.join(tmpdir(), "ai-exporter-compose-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "--allow-file-access-from-files",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

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
    if (!version) throw new Error("Chrome did not start");

    const browser = await Cdp.connect(version.webSocketDebuggerUrl);

    /* ---------- 1. export page, straight downscale ---------- */
    const exportPage = await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    const shot = await Cdp.connect(exportPage.webSocketDebuggerUrl);
    await shot.send("Page.enable");
    await shot.send("Runtime.enable");
    await shot.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 2,
      mobile: false,
    });

    const exportPng = (await readFile(path.join(outDir, "shot-export.png"))).toString("base64");
    const popupPng = (await readFile(path.join(outDir, "shot-popup.png"))).toString("base64");
    const iconPng = (await readFile(path.join(root, "src/icons/icon128.png"))).toString("base64");
    ICON_URI = `data:image/png;base64,${iconPng}`;

    // Re-render the export capture inside a 1280x800 viewport that contains
    // only the image, so the browser does the resampling.
    await shot.send("Page.navigate", {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(
        `<!doctype html><style>html,body{margin:0;width:${W}px;height:${H}px;overflow:hidden}
         img{display:block;width:${W}px;height:${H}px}</style>
         <img src="data:image/png;base64,${exportPng}">`,
      )}`,
    });
    await sleep(800);
    const first = await shot.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(storeDir, "screenshot-1-export.png"), Buffer.from(first.data, "base64"));
    console.log("store/screenshot-1-export.png");
    shot.close();

    /* ---------- 2. popup on branded backdrop ---------- */
    const composePage = await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
    const compose = await Cdp.connect(composePage.webSocketDebuggerUrl);
    await compose.send("Page.enable");
    await compose.send("Runtime.enable");
    await compose.send("Emulation.setDeviceMetricsOverride", {
      width: W,
      height: H,
      deviceScaleFactor: 2,
      mobile: false,
    });

    const html = popupPage(`data:image/png;base64,${popupPng}`);
    await compose.send("Page.navigate", {
      url: `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
    });
    await sleep(1200);

    const ready = await compose.send("Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        await document.fonts.ready;
        const imgs = [...document.images];
        await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
        return JSON.stringify({ imgs: imgs.length, sized: imgs.every((i) => i.naturalWidth > 0) });
      })()`,
    });
    console.log("compose:", ready.result.value);

    const second = await compose.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(path.join(storeDir, "screenshot-2-popup.png"), Buffer.from(second.data, "base64"));
    console.log("store/screenshot-2-popup.png");

    compose.close();
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