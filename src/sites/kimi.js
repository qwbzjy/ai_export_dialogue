import {
  ExtractionError,
  fetchJson,
  parseToken,
  readLocalStorage,
  withAuthRetry,
} from "../content/extract/api.js";
import {
  asArray,
  collectSources,
  normalizeMath,
  pick,
  tidy,
  withSources,
} from "../content/extract/text.js";
import { textOf } from "../content/extract/sanitize.js";
import { expandThinking, wrapThinking } from "./_dom.js";

const HOSTS = ["www.kimi.com", "kimi.com", "kimi.moonshot.cn"];
const CONVERSATION = /^\/chat\/(?!history\/?$)([A-Za-z0-9_-]{8,128})\/?$/;
const SERVICE = "/apiv2/kimi.gateway.chat.v1.ChatService";
const LIST_MESSAGES = `${SERVICE}/ListMessages`;

function token() {
  return parseToken(readLocalStorage("access_token"));
}

const pickChatIdFromPath = () => location.pathname.match(CONVERSATION)?.[1] ?? null;

function requestHeaders() {
  const bearer = token();
  if (!bearer) throw new ExtractionError("未登录 Kimi", "auth");
  return {
    Authorization: `Bearer ${bearer}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    // Connect-RPC uses these to answer with plain JSON instead of the
    // streaming framing the page's own client would negotiate.
    "connect-protocol-version": "1",
    "x-msh-platform": "web",
    "x-language": "zh-CN",
  };
}

function blocksOf(message) {
  return asArray(pick(message, "blocks", "content", "contents"));
}

/**
 * Each block is a oneof: {text:{content}}, {think:{content}}, {search:…},
 * {file:…}, {tool:…}. Only the first two carry answer text.
 */
function blockText(block) {
  if (!block || typeof block !== "object") return "";
  const oneof = pick(block, "text", "think", "content", "value");
  if (typeof oneof === "string") return tidy(oneof);
  if (oneof && typeof oneof === "object") return tidy(pick(oneof, "content", "text", "value"));
  return tidy(pick(block, "content", "text"));
}

function isThinkBlock(block) {
  if (!block || typeof block !== "object") return false;
  if (pick(block, "think") !== undefined) return true;
  return String(pick(block, "type") ?? "").toLowerCase() === "think";
}

function splitBlocks(blocks) {
  const answer = [];
  const thinking = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (!text) continue;
    if (isThinkBlock(block)) thinking.push(text);
    else answer.push(text);
  }
  return { answer: answer.join("\n\n"), thinking: thinking.join("\n\n") };
}

/** Normalises whichever reference shape this API version returns. */
function referencesOf(message) {
  const refs = [
    ...asArray(pick(message, "references")),
    ...asArray(pick(message, "search_results")),
    ...asArray(pick(message, "reference")),
    ...blocksOf(message)
      .filter((block) => block && pick(block, "search") !== undefined)
      .flatMap((block) => collectSources(pick(block, "search"))),
  ];
  const seen = new Set();
  return refs
    .map((ref) => ({
      title: tidy(pick(ref, "title", "matchedText", "matched_text", "name")),
      url: pick(ref, "url", "link"),
    }))
    .filter((ref) => ref.url && !seen.has(ref.url) && seen.add(ref.url));
}

/** Proto JSON timestamps arrive as ms, seconds, or RFC3339 strings. */
function messageTime(message) {
  const raw = pick(message, "createdAt", "created_at", "createTime", "create_time");
  if (raw == null) return null;
  const number = typeof raw === "number" ? raw : Number(raw);
  if (Number.isFinite(number) && number > 0) return number < 1e12 ? number * 1000 : number;
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Only reorders when every message carries a timestamp (stable otherwise). */
function inChronologicalOrder(messages) {
  const times = messages.map(messageTime);
  if (!messages.length || times.some((time) => time == null)) return messages;
  return messages
    .map((message, index) => ({ message, index, time: times[index] }))
    .sort((left, right) => left.time - right.time || left.index - right.index)
    .map((entry) => entry.message);
}

async function requestPage(chatId, { direction, pageToken }) {
  const body = { chatId, pageSize: 50, direction };
  if (pageToken) body.pageToken = pageToken;
  return withAuthRetry(() =>
    fetchJson(LIST_MESSAGES, { method: "POST", headers: requestHeaders(), body: JSON.stringify(body) }),
  );
}

/** Connect-RPC pages; each call returns one page of messages. */
async function listMessages(chatId) {
  const collected = [];
  let pageToken = "";
  let direction = "DIRECTION_FORWARD";

  for (let page = 0; page < 40; page += 1) {
    let response = await requestPage(chatId, { direction, pageToken });
    if (response.status === 400 && direction !== 1) {
      // Older builds expect the numeric enum value.
      direction = 1;
      response = await requestPage(chatId, { direction, pageToken });
    }
    if (!response.ok || !response.json) throw new ExtractionError("Kimi 接口不可用", "api");

    const batch = asArray(pick(response.json, "messages", "items", "data"));
    collected.push(...batch);
    const next = pick(response.json, "nextPageToken", "next_page_token");
    if (!next || !batch.length) break;
    pageToken = String(next);
  }

  return inChronologicalOrder(collected);
}

function convert(messages) {
  const output = [];
  for (const message of messages) {
    const role = String(pick(message, "role", "authorRole") ?? "").toLowerCase();
    const { answer, thinking } = splitBlocks(blocksOf(message));

    if (role === "user" || role === "human") {
      if (!answer) continue;
      output.push({ role: "user", markdown: normalizeMath(answer) });
      continue;
    }
    if (!["assistant", "bot", "ai", "model"].includes(role)) continue;

    const { markdown, sources } = withSources(normalizeMath(answer), referencesOf(message));
    if (!markdown && !thinking) continue;
    output.push({
      role: "assistant",
      markdown,
      thinking: thinking ? [{ title: "思考过程", text: normalizeMath(thinking) }] : [],
      sources,
    });
  }
  return output;
}

function pageTitle() {
  const heading = document.querySelector("[class*='header'] [class*='title'], .chat-title, h1");
  const text = heading?.textContent?.trim();
  return text || document.title.replace(/\s*[-|]\s*Kimi.*$/i, "") || "Kimi 会话";
}

async function extractFromApi() {
  const chatId = pickChatIdFromPath();
  if (!chatId) throw new ExtractionError("当前不是 Kimi 会话页", "not-conversation");
  const messages = convert(await listMessages(chatId));
  if (!messages.length) throw new ExtractionError("会话没有消息", "empty");
  return { source: "api", title: pageTitle(), messages };
}

/* ---------------- DOM fallback ---------------- */

// `chat-content-item` is sometimes a base class and sometimes a prefix of the
// per-role modifier, so both shapes are matched by substring.
const ITEM_ANY = "[class*='chat-content-item']";
const SEGMENT_USER = ".segment-user";
const SEGMENT_ASSISTANT = ".segment-assistant";
/*
 * Reasoning is rendered in a Markdown wrapper too — it just carries
 * `.toolcall-content-text`. Without the :not(), the chain of thought would be
 * exported as the answer.
 */
const ANSWER = ".markdown-container:not(.toolcall-content-text)";
const THINKING = ".thinking-container";
const NOISE = ".segment-assistant-actions, .segment-actions, .segment-toolcall";

/** Message rows: one item per turn, falling back to the segment wrappers. */
function domRows() {
  const items = [...document.querySelectorAll(ITEM_ANY)].filter(
    (node) => !node.parentElement?.closest(ITEM_ANY),
  );
  if (items.length) return items;
  return [...document.querySelectorAll(`${SEGMENT_USER}, ${SEGMENT_ASSISTANT}`)];
}

function domRole(row) {
  if (row.querySelector(SEGMENT_USER) || /\bchat-content-item-user\b/.test(String(row.className))) return "user";
  if (row.querySelector(SEGMENT_ASSISTANT) || /\bchat-content-item-assistant\b/.test(String(row.className))) {
    return "assistant";
  }
  return row.querySelector(`${ANSWER}, ${THINKING}`) ? "assistant" : "user";
}

/**
 * The language lives in a sibling label, not on the <pre>. Copy it onto the
 * <pre> so the Markdown keeps the fence info string, then drop the label so
 * it does not end up as stray text inside the code block.
 */
function annotateCode(wrapper) {
  for (const block of wrapper.querySelectorAll(".segment-code, [class*='segment-code']")) {
    const pre = block.querySelector("pre");
    const label = block.querySelector(".segment-code-lang")?.textContent?.trim();
    if (pre && label && /^[\w+#.-]{1,20}$/.test(label)) pre.setAttribute("data-language", label.toLowerCase());
  }
  for (const label of wrapper.querySelectorAll(".segment-code-lang")) label.remove();
}

function domMessages() {
  const output = [];

  for (const row of domRows()) {
    if (!textOf(row)) continue;
    const role = domRole(row);

    // Clone the segment (question or answer) rather than the whole turn, so a
    // row that holds both never duplicates one of them.
    const part =
      role === "assistant"
        ? (row.querySelector(SEGMENT_ASSISTANT) ?? row)
        : (row.querySelector(SEGMENT_USER) ?? row);

    const wrapper = document.createElement("div");
    wrapper.appendChild(part.cloneNode(true));

    for (const noise of [...wrapper.querySelectorAll(NOISE)]) noise.remove();
    annotateCode(wrapper);

    const thinkingHosts = [...wrapper.querySelectorAll(THINKING)].filter((host) => !host.closest("details"));
    const details = wrapThinking(thinkingHosts);
    for (const host of thinkingHosts) host.remove();
    if (details) wrapper.appendChild(details);

    output.push({ role, node: wrapper });
  }

  return output;
}

export default {
  id: "kimi",
  name: "Kimi",
  match: (url) => HOSTS.includes(new URL(url).hostname),
  isConversationUrl: (url) => CONVERSATION.test(new URL(url).pathname),
  isLoggedIn: () => Boolean(token()),
  isGenerating: () => Boolean(document.querySelector("[class*='stop'], [class*='loading']")),
  getTitle: pageTitle,
  extractFromApi,
  expandThinking: async () => {
    const result = await expandThinking([...document.querySelectorAll(THINKING)]);
    return result.clicked;
  },
  domFallback: { getMessages: domMessages },
};