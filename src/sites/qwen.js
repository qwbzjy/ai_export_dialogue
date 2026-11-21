import {
  ExtractionError,
  fetchJson,
  parseToken,
  readLocalStorage,
  withAuthRetry,
} from "../content/extract/api.js";
import { asArray, normalizeMath, pick, tidy } from "../content/extract/text.js";
import { messagesFromRows, rowsByRole } from "./_dom.js";

const HOSTS = ["chat.qwen.ai"];
const CONVERSATION = /^\/c\/([A-Za-z0-9_-]{8,128})\/?$/;

function token() {
  return parseToken(readLocalStorage("token"));
}

function headers() {
  const bearer = token();
  if (!bearer) throw new ExtractionError("未登录 Qwen", "auth");
  return {
    Authorization: `Bearer ${bearer}`,
    source: "web",
    Accept: "application/json",
    "X-Request-Id": crypto.randomUUID(),
  };
}

/**
 * Open-WebUI lineage: `chat.history` is a message tree with `currentId` on the
 * edge of the visible branch. Walk parent links to get the branch on screen,
 * oldest first, instead of exporting every regenerated alternative.
 */
function activeChain(chat) {
  const history = pick(chat, "history") ?? chat;
  const messageMap = pick(history, "messages") ?? {};
  const currentId = pick(history, "currentId", "current_id");
  const byId = messageMap instanceof Map ? Object.fromEntries(messageMap) : messageMap;

  if (currentId && byId?.[currentId]) {
    const chain = [];
    const guard = new Set();
    let id = String(currentId);
    while (id && byId[id] && !guard.has(id)) {
      guard.add(id);
      chain.push(byId[id]);
      id = pick(byId[id], "parentId");
    }
    if (chain.length) return chain.reverse();
  }

  return asArray(pick(chat, "messages"))
    .map((message) => pick(message, "content") ?? message)
    .filter(Boolean);
}

/** content_list phases: think (reasoning), thinking_summary, answer. */
function parseContent(message) {
  const content = pick(message, "content");
  const phases = asArray(pick(content, "content_list", "contentList"));

  if (!phases.length) {
    const text = tidy(typeof content === "string" ? content : pick(content, "content", "text"));
    return { answer: text, thinking: "" };
  }

  const answer = [];
  const thinking = [];
  for (const phase of phases) {
    const phaseName = String(pick(phase, "phase", "type") ?? "").toLowerCase();
    const text = tidy(pick(phase, "content", "text", "value"));
    if (!text) continue;
    if (phaseName.includes("think")) thinking.push(text);
    else if (phaseName.includes("answer") || phaseName === "") answer.push(text);
    else answer.push(text);
  }
  return { answer: answer.join("\n\n"), thinking: thinking.join("\n\n") };
}

function convert(messages) {
  const output = [];
  for (const message of messages) {
    const role = String(pick(message, "role") ?? "").toLowerCase();
    const { answer, thinking } = parseContent(message);

    if (role === "user") {
      if (!answer) continue;
      output.push({ role: "user", markdown: normalizeMath(answer) });
      continue;
    }
    if (role !== "assistant") continue;
    if (!answer && !thinking) continue;
    output.push({
      role: "assistant",
      markdown: normalizeMath(answer),
      thinking: thinking ? [{ title: "思考过程", text: normalizeMath(thinking) }] : [],
    });
  }
  return output;
}

async function extractFromApi() {
  const id = location.pathname.match(CONVERSATION)?.[1];
  if (!id) throw new ExtractionError("当前不是 Qwen 会话页", "not-conversation");

  const response = await withAuthRetry(() =>
    fetchJson(`/api/v2/chats/${encodeURIComponent(id)}`, { headers: headers() }),
  );
  if (!response.ok || !response.json) throw new ExtractionError("Qwen 接口不可用", "api");

  const data = pick(response.json, "data") ?? response.json;
  const chat = pick(data, "chat") ?? data;
  const messages = convert(activeChain(chat));
  if (!messages.length) throw new ExtractionError("会话没有消息", "empty");

  return {
    source: "api",
    title: tidy(pick(data, "title") ?? pick(chat, "title")) || pageTitle(),
    messages,
  };
}

function pageTitle() {
  const heading = document.querySelector("[class*='chat-title'], [class*='conversation-title'], h1");
  return heading?.textContent?.trim() || document.title.replace(/\s*[-|]\s*Qwen.*$/i, "") || "Qwen 会话";
}

/* ---------------- DOM fallback (verified against a saved page) ---------------- */

function domMessages() {
  const rows = rowsByRole({
    userSelector: ".qwen-chat-message-user",
    assistantSelector: ".qwen-chat-message-assistant",
  });

  return messagesFromRows(rows, {
    bodySelector: ".user-message-content, .qwen-markdown, .chat-response-message-render-flow",
    thinkingSelectors: [".qwen-chat-thinking-tool-status-card-wraper"],
  });
}

export default {
  id: "qwen",
  name: "Qwen",
  match: (url) => HOSTS.includes(new URL(url).hostname),
  isConversationUrl: (url) => CONVERSATION.test(new URL(url).pathname),
  isLoggedIn: () => Boolean(token()),
  isGenerating: () => Boolean(document.querySelector(".qwen-chat-message-awaiting-response, [class*='stop']")),
  getTitle: pageTitle,
  extractFromApi,
  domFallback: {
    getMessages: domMessages,
    getScrollContainer: () => document.querySelector(".chat-messages, #chat-messages-scroll-container"),
  },
};