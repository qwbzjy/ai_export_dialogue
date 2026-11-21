/**
 * The floating export button.
 *
 * Kept in a shadow root so the site's CSS reset cannot reach it, and so its
 * own reset cannot reach the site. The host is `pointer-events:none` with
 * the inner wrapper `pointer-events:auto`: a full-size click-blocking layer
 * over a chat page is a bug, not a feature.
 */

const STYLE = `
  :host { all: initial; }
  /* .panel and .toast set display, which would beat the UA's [hidden]. */
  [hidden] { display: none !important; }
  .wrap {
    position: fixed;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
    font: 13px/1.4 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    color: #1f2328;
    pointer-events: auto;
  }
  .fab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 13px;
    border: 1px solid rgba(0,0,0,.08);
    border-radius: 999px;
    background: #ffffff;
    box-shadow: 0 4px 16px rgba(0,0,0,.14);
    cursor: grab;
    user-select: none;
    transition: transform .12s ease, box-shadow .12s ease;
  }
  .fab:hover { box-shadow: 0 6px 22px rgba(0,0,0,.18); }
  .fab:active { cursor: grabbing; }
  .fab[data-state="busy"] { cursor: progress; }
  .fab .dot { width: 8px; height: 8px; border-radius: 50%; background: #1a7f37; }
  .fab[data-state="busy"] .dot { background: #bf8700; animation: pulse 1s infinite; }
  .fab[data-state="error"] .dot { background: #cf222e; }
  @keyframes pulse { 50% { opacity: .35; } }
  .panel {
    min-width: 190px;
    padding: 6px;
    border: 1px solid rgba(0,0,0,.08);
    border-radius: 12px;
    background: #fff;
    box-shadow: 0 8px 28px rgba(0,0,0,.18);
  }
  .panel[hidden] { display: none; }
  button {
    display: block;
    width: 100%;
    padding: 8px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    text-align: left;
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  button:hover { background: #f3f4f6; }
  button:disabled { color: #9aa0a6; cursor: not-allowed; background: transparent; }
  .hint { padding: 6px 10px 4px; color: #6b7280; font-size: 12px; }
  .toast {
    max-width: 260px;
    padding: 8px 11px;
    border-radius: 10px;
    background: rgba(31,35,40,.94);
    color: #fff;
    font-size: 12px;
    line-height: 1.45;
    white-space: pre-line;
  }
  .toast[hidden] { display: none; }
`;

const MENU = [{ id: "markdown", label: "导出 Markdown" }];

export function createUi({ onExport, storageKey, origin, setPosition }) {
  const host = document.createElement("div");
  host.id = "ai-exporter-host";
  host.style.cssText =
    "position:fixed;z-index:2147483647;pointer-events:none;right:24px;bottom:24px;";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = STYLE;

  const wrapper = document.createElement("div");
  wrapper.className = "wrap";

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.hidden = true;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.hidden = true;

  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "导出当前对话";
  panel.appendChild(hint);

  for (const item of MENU) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = item.label;
    button.dataset.action = item.id;
    button.addEventListener("click", () => {
      hidePanel();
      onExport({ useApi: !item.dom });
    });
    panel.appendChild(button);
  }

  const domButton = document.createElement("button");
  domButton.type = "button";
  domButton.textContent = "仅用页面内容导出（DOM）";
  domButton.dataset.action = "dom";
  domButton.title = "接口不可用时，直接读取页面上已渲染的内容";
  domButton.addEventListener("click", () => {
    hidePanel();
    onExport({ useApi: false });
  });
  panel.appendChild(domButton);

  const fab = document.createElement("div");
  fab.className = "fab";
  fab.dataset.state = "idle";
  fab.setAttribute("role", "button");
  fab.setAttribute("tabindex", "0");
  fab.title = "AI 对话导出（可拖动）";
  fab.innerHTML = '<span class="dot"></span><span class="label">导出对话</span>';
  const label = fab.querySelector(".label");

  wrapper.append(toast, panel, fab);
  shadow.append(style, wrapper);

  /* ---------------- state ---------------- */

  let busy = false;

  function setState(state, text) {
    busy = state === "busy";
    fab.dataset.state = state;
    label.textContent = text ?? (state === "busy" ? "正在导出…" : state === "error" ? "导出失败" : "导出对话");
    for (const button of panel.querySelectorAll("button")) button.disabled = busy;
    if (state !== "error") return;
    // Return to idle after the error has been read.
    setTimeout(() => {
      if (!busy) setState("idle");
    }, 4000);
  }

  function showToast(message, { sticky = false } = {}) {
    toast.textContent = message;
    toast.hidden = false;
    if (sticky) return;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => {
      toast.hidden = true;
    }, 3500);
  }

  function hideToast() {
    clearTimeout(showToast.timer);
    toast.hidden = true;
  }

  function showPanel() {
    panel.hidden = false;
  }

  function hidePanel() {
    panel.hidden = true;
  }

  function togglePanel() {
    if (busy) return;
    if (panel.hidden) showPanel();
    else hidePanel();
  }

  /* ---------------- drag ---------------- */

  let dragState = null;

  fab.addEventListener("pointerdown", (event) => {
    // Prevents the site's textarea from losing focus, which breaks
    // Enter-to-send and discards a draft.
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rect: host.getBoundingClientRect(),
      moved: false,
    };
    fab.setPointerCapture(event.pointerId);
  });

  fab.addEventListener("pointermove", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const dx = event.clientX - dragState.startX;
    const dy = event.clientY - dragState.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragState.moved = true;
    if (!dragState.moved) return;

    const width = dragState.rect.width;
    const height = dragState.rect.height;
    const left = clamp(dragState.rect.left + dx, 8, window.innerWidth - width - 8);
    const top = clamp(dragState.rect.top + dy, 8, window.innerHeight - height - 8);
    host.style.left = `${left}px`;
    host.style.top = `${top}px`;
    host.style.right = "auto";
    host.style.bottom = "auto";
  });

  fab.addEventListener("pointerup", (event) => {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const moved = dragState.moved;
    dragState = null;
    fab.releasePointerCapture?.(event.pointerId);
    if (moved) {
      const rect = host.getBoundingClientRect();
      setPosition?.({
        right: Math.max(8, window.innerWidth - rect.right),
        bottom: Math.max(8, window.innerHeight - rect.bottom),
      });
    } else {
      togglePanel();
    }
  });

  fab.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      togglePanel();
    }
  });

  shadow.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || panel.hidden) return;
    // Only stop propagation while our menu is open.
    event.stopPropagation();
    hidePanel();
  });

  document.addEventListener("pointerdown", (event) => {
    if (panel.hidden) return;
    if (!event.composedPath().includes(host)) hidePanel();
  });

  /* ---------------- placement ---------------- */

  function applyPosition(position) {
    if (!position) return;
    host.style.right = `${position.right ?? 24}px`;
    host.style.bottom = `${position.bottom ?? 24}px`;
    host.style.left = "auto";
    host.style.top = "auto";
  }

  function keepOneCopy() {
    for (const existing of document.querySelectorAll("#ai-exporter-host")) {
      if (existing !== host) existing.remove();
    }
  }

  function mount() {
    keepOneCopy();
    const parent = document.fullscreenElement ?? document.body;
    if (host.parentElement !== parent) parent.appendChild(host);
  }

  document.addEventListener("fullscreenchange", mount);

  return {
    mount,
    applyPosition,
    setState,
    showToast,
    hideToast,
    showPanel,
    hidePanel,
    get busy() {
      return busy;
    },
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}