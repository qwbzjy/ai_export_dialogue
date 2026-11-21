/**
 * DOM fallback: walk the message list upwards until the whole history is
 * rendered, snapshotting as we go.
 *
 * Why snapshots instead of one final pass: Doubao, Yuanbao and DeepSeek
 * virtualise their lists, so a message that scrolls out of view is removed
 * from the DOM. Each step is keyed by role + a text hash, and the first
 * occurrence wins, so re-rendered messages never duplicate.
 */

import { cleanNode, htmlOf, textOf } from "./sanitize.js";
import { sleep } from "./api.js";

/** Waits for mutations inside `root` to stop for `quietMs`, or until `maxMs`. */
function waitForQuiet(root, { quietMs = 220, maxMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let quietTimer;
    let maxTimer;

    const finish = () => {
      observer.disconnect();
      clearTimeout(quietTimer);
      clearTimeout(maxTimer);
      resolve();
    };

    const observer = new MutationObserver(() => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });

    observer.observe(root, { childList: true, subtree: true, characterData: true });
    quietTimer = setTimeout(finish, quietMs);
    maxTimer = setTimeout(finish, maxMs);
  });
}

/**
 * The scroll container: the largest ancestor of `probe` that actually
 * scrolls vertically. Sites routinely put the list inside a wrapper with
 * overflow:auto and a fixed height, so this is more reliable than guessing.
 */
export function findScrollContainer(probe = document.body) {
  let best = null;
  let bestArea = 0;
  let node = probe;

  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
    if (scrollable && node.scrollHeight > node.clientHeight + 8) {
      const area = node.clientWidth * node.clientHeight;
      if (area >= bestArea) {
        best = node;
        bestArea = area;
      }
    }
    node = node.parentElement;
  }

  return best ?? document.scrollingElement ?? document.documentElement;
}

function stableKey(role, text) {
  // A cheap, stable hash; collisions are practically impossible for
  // messages that differ only deep in their text.
  let hash = 0x811c9dc5;
  const sample = text.slice(0, 200) + "\u0001" + text.length;
  for (let index = 0; index < sample.length; index += 1) {
    hash ^= sample.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${role}:${(hash >>> 0).toString(36)}`;
}

/**
 * @param {object} options
 * @param {() => Array<{ role: "user"|"assistant", node: Element }>} options.getMessages
 * @param {() => HTMLElement} [options.getScrollContainer]
 * @param {boolean} [options.loadAll=true]  walk upwards to load history
 * @param {(progress: {count: number, step: number}) => void} [options.onProgress]
 */
export async function collectFromDom({
  getMessages,
  getScrollContainer,
  loadAll = true,
  maxSteps = 120,
  onProgress,
}) {
  const container = getScrollContainer?.() ?? findScrollContainer();
  const originalTop = container.scrollTop;

  // Chronological order. Each snapshot is the viewport, top to bottom; we
  // only ever scroll upwards, so a batch of new messages belongs *before*
  // everything seen so far. Prepending keeps replay order stable when a
  // virtualised list unmounts messages the moment they leave the view.
  const ordered = [];
  const seen = new Set();

  /** @returns {number} the total message count seen so far */
  function snapshot() {
    const batch = [];
    for (const { role, node } of getMessages() ?? []) {
      if (!node) continue;
      const key = stableKey(role, textOf(node));
      if (seen.has(key)) continue;
      const cleaned = cleanNode(node);
      if (!cleaned || !textOf(cleaned)) continue;
      seen.add(key);

      // Adapters wrap reasoning in <details data-thinking>; pull it out here
      // so both extraction paths produce the same message shape.
      const thinking = [];
      for (const details of [...cleaned.querySelectorAll("details[data-thinking]")]) {
        const summary = details.querySelector("summary")?.textContent?.trim() || "思考过程";
        // wrapThinking may attach several .thinking-body blocks to one block.
        const blocks = [...details.querySelectorAll(".thinking-body")]
          .map((node) => node.innerHTML.trim())
          .filter(Boolean);
        if (blocks.length) thinking.push({ title: summary, html: blocks.join("\n") });
        details.remove();
      }

      const images = [...cleaned.querySelectorAll("img")].map((img) => ({
        src: img.getAttribute("data-original-src") ?? img.getAttribute("src") ?? "",
        alt: img.getAttribute("alt") ?? "",
      }));

      batch.push({ role, html: htmlOf(cleaned), thinking, images });
    }
    if (batch.length) ordered.unshift(...batch);
    return seen.size;
  }

  snapshot();

  if (loadAll) {
    let step = 0;
    let lastCount = seen.size;
    while (step < maxSteps) {
      step += 1;
      const beforeHeight = container.scrollHeight;
      const viewport = container.clientHeight || 600;
      container.scrollTop = Math.max(0, container.scrollTop - Math.floor(viewport * 0.85));
      await waitForQuiet(container);
      snapshot();
      onProgress?.({ count: seen.size, step });

      const atTop = container.scrollTop <= 1;
      const grew = container.scrollHeight > beforeHeight + 8;
      // Stop once at the top and nothing new arrived either as height or as
      // messages; a list that virtualises without changing height still
      // stops because `snapshot` adds nothing new twice in a row.
      if (atTop && !grew && seen.size === lastCount) break;
      lastCount = seen.size;
      await sleep(80);
    }
  }

  snapshot();
  container.scrollTop = originalTop;

  return {
    source: "dom",
    messages: ordered,
    complete: document.visibilityState !== "hidden",
    count: seen.size,
  };
}