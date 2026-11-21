import {
  ExtractionError,
  fetchJson,
  findPageRequestQuery,
  proxyFetch,
} from "../content/extract/api.js";
import { asArray, normalizeMath, pick, tidy } from "../content/extract/text.js";
import { messagesFromRows, rowLayout } from "./_dom.js";

const HOSTS = ["www.doubao.com", "doubao.com"];
const CONVERSATION = /^\/chat\/(\d{4,32})\/?$/;

/** Session cookie auth only — no token in localStorage. */
const CHAIN_PATH = "/im/chain/single";

/**
 * The page's own request carries the device id, app id and one-shot anti-bot
 * fields. A hand-built query gets a 4xx, so reuse what the page sent. When the
 * page has not sent one yet, the defaults the web app ships cover the common
 * case; the caller falls back to the DOM when that fails anyway.
 */
function requestQuery() {
  return findPageRequestQuery(CHAIN_PATH) ?? "";
}

async function postChain(body, { viaProxy = false } = {}) {
  const url = `${CHAIN_PATH}${requestQuery()}`;
  const init = {
    method: "POST",
    headers: {
      "Content-Type": "application/json; encoding=utf-8",
      // Without this, int64 ids arrive as JSON numbers and lose precision,
      // which makes pagination anchors mismatch.
      "agw-js-conv": "str",
    },
    body: JSON.stringify(body),
  };
  const response = viaProxy ? await proxyFetch({ url: new URL(url, location.origin).href, ...init }) : await fetchJson(url, init);
  if (!response.ok || !response.json) throw new ExtractionError("豆包接口不可用", "api");
  const status = pick(response.json, "status_code");
  if (status !== undefined && Number(status) !== 0) {
    throw new ExtractionError(`豆包接口错误 ${status}`, "api");
  }
  const downlink = pick(response.json, "downlink_body", "downlinkBody") ?? response.json;
  return downlink;
}

/**
 * Messages come newest-first, 50 at a time. `anchor_index` walks backwards;
 * start at the top of the id range and follow `next_index` until it stops.
 */
async function listMessages(conversationId) {
  const collected = [];
  let anchor = Number.MAX_SAFE_INTEGER;
  for (let page = 0; page < 40; page += 1) {
    const downlink = await postChain({
      cmd: 3100,
      sequence_id: `0${Date.now()}`,
      channel: "chat",
      version: "1",
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: conversationId,
          anchor_index: anchor,
          conversation_type: 3,
          direction: 1,
          limit: 50,
          ext: {},
          filter: { index_list: [] },
        },
      },
    });

    const body = pick(downlink, "pull_singe_chain_downlink_body", "pullSingeChainDownlinkBody") ?? downlink;
    const batch = asArray(pick(body, "messages", "message_list"));
    collected.push(...batch);
    if (!pick(body, "has_more", "hasMore")) break;
    const next = Number(pick(body, "next_index", "minIndex", "nextIndex"));
    if (!Number.isFinite(next) || next <= 0 || next >= anchor) break;
    anchor = next;
  }
  return collected.reverse();
}

/** block_type 10000 is text; thinking rides 10056 / a `thinking_content` field. */
function messageText(message) {
  const blocks = asArray(pick(message, "content_block", "content_blocks", "blocks"));
  const texts = [];
  for (const block of blocks) {
    const type = Number(pick(block, "block_type", "type"));
    if (type === 10000 || type === 1) {
      const text = tidy(pick(pick(block, "content") ?? block, "text", "text_block")?.text ?? pick(block, "text"));
      if (text) texts.push(text);
    }
  }
  if (texts.length) return texts.join("\n\n");
  return tidy(pick(message, "text", "content"));
}

function messageThinking(message) {
  const direct = tidy(pick(message, "thinking_content", "thinkingContent"));
  if (direct) return direct;
  const blocks = asArray(pick(message, "content_block", "content_blocks", "blocks"));
  const pieces = blocks
    .filter((block) => Number(pick(block, "block_type", "type")) === 10056)
    .map((block) => tidy(pick(block, "content")?.text ?? pick(block, "text")))
    .filter(Boolean);
  return pieces.join("\n\n");
}

function convert(messages) {
  const output = [];
  for (const message of messages) {
    const userType = Number(pick(message, "user_type", "userType") ?? 2);
    const text = messageText(message);
    const thinking = messageThinking(message);

    if (userType === 1) {
      if (!text && !thinking) continue;
      output.push({ role: "user", markdown: normalizeMath(text) });
      continue;
    }

    if (!text && !thinking) continue;
    output.push({
      role: "assistant",
      markdown: normalizeMath(text),
      thinking: thinking ? [{ title: "思考过程", text: normalizeMath(thinking) }] : [],
    });
  }
  return output;
}

function pageTitle() {
  const heading = document.querySelector("[class*='conversation-title'], [class*='chat-title'], h1");
  return heading?.textContent?.trim() || document.title.replace(/\s*[-|]\s*豆包.*$/i, "") || "豆包会话";
}

async function extractFromApi() {
  const conversationId = location.pathname.match(CONVERSATION)?.[1];
  if (!conversationId) throw new ExtractionError("当前不是豆包会话页", "not-conversation");

  // Try the page's own query first; without one, try the proxy, which can
  // still reach the API with cookies but cannot reproduce anti-bot fields.
  let raw = [];
  try {
    raw = await listMessages(conversationId);
  } catch (error) {
    if (error.code === "api") raw = await listMessages(conversationId).catch(() => []);
    if (!raw.length) throw error;
  }

  const messages = convert(raw);
  if (!messages.length) throw new ExtractionError("会话没有消息", "empty");
  return { source: "api", title: pageTitle(), messages };
}

/* ---------------- DOM fallback (best effort) ---------------- */

const SENT = "[data-testid='send_message']";
const RECEIVED = "[data-testid='receive_message']";
const BODY = "[class*='md-box'], [class*='markdown'], [class*='message-text']";

/**
 * The long-copied `[data-testid="message_text_content"]` / `.flow-markdown-body`
 * selectors no longer match the live bundle; these are the current families.
 *
 * Rows are pinned by `data-message-id` when it exists — one per turn, the
 * only reliable boundary — because `rowLayout` cannot see rows whose
 * assistant body is the sole Markdown element in the list.
 */
function domMessages() {
  const items = [...document.querySelectorAll("[data-message-id]")].filter(
    (row) => !row.parentElement?.closest("[data-message-id]"),
  );

  const rows = items.length
    ? items.map((row) => ({ row, role: row.matches(SENT) || row.querySelector(SENT) ? "user" : "assistant" }))
    : rowLayout(BODY).rows.map((row) => ({
        row,
        role: row.matches(SENT) || row.querySelector(SENT) ? "user" : "assistant",
      }));

  return messagesFromRows(rows, {
    userSelector: SENT,
    bodySelector: BODY,
    thinkingSelectors: ["[class*='thinking'], [class*='think-block']"],
  });
}

export default {
  id: "doubao",
  name: "豆包",
  match: (url) => HOSTS.includes(new URL(url).hostname),
  isConversationUrl: (url) => CONVERSATION.test(new URL(url).pathname),
  isLoggedIn: () => Boolean(document.cookie) && !document.querySelector("[class*='login-modal']"),
  isGenerating: () => Boolean(document.querySelector("[class*='stop-generate'], [class*='stop-btn']")),
  getTitle: pageTitle,
  extractFromApi,
  domFallback: {
    getMessages: domMessages,
    getScrollContainer: () => document.querySelector("[class*='flow-scrollbar'], [class*='scroller']"),
  },
};