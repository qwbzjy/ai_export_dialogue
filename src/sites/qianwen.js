import {
  ExtractionError,
  fetchFromHost,
  findPageRequestQuery,
  readLocalStorage,
  sleep,
} from "../content/extract/api.js";
import { asArray, normalizeMath, pick, tidy, withSources } from "../content/extract/text.js";
import { messagesFromRows, rowsByRole } from "./_dom.js";

const HOSTS = ["www.qianwen.com", "qianwen.com", "qianwen.aliyun.com", "tongyi.aliyun.com"];
const CONVERSATION = /^\/chat\/([A-Za-z0-9_-]{8,128})\/?$/;
const API_BASE = "https://chat2-api.qianwen.com";
const MSG_LIST_PATH = "/api/v1/session/msg/list";

/**
 * This API needs `ut` and friends in the query; without them it answers 400.
 * They are read off the page's own request rather than rebuilt.
 */
function commonQuery() {
  const query = findPageRequestQuery(MSG_LIST_PATH);
  if (!query) return null;
  return new URLSearchParams(query);
}

async function xsrfToken() {
  // The XSRF cookie belongs to the API host, which the page's own cookie
  // string cannot see, so ask the browser for it.
  try {
    const result = await chrome.runtime.sendMessage({
      type: "READ_COOKIE",
      url: `${API_BASE}/`,
      name: "XSRF-TOKEN",
    });
    if (result?.value) return decodeURIComponent(result.value);
  } catch {
    /* fall through */
  }
  const local = readLocalStorage("XSRF-TOKEN") ?? readLocalStorage("xsrfToken");
  return local ? decodeURIComponent(local) : null;
}

async function loadTurns(sessionId) {
  const base = commonQuery();
  if (!base) {
    throw new ExtractionError(
      "未找到页面请求参数（请先滚动或发送过一次消息再导出）",
      "params",
    );
  }

  const headers = { Accept: "application/json" };
  const xsrf = await xsrfToken();
  if (xsrf) headers["x-xsrf-token"] = xsrf;

  const turns = [];
  for (let page = 1; page <= 60; page += 1) {
    const params = new URLSearchParams(base);
    params.set("session_id", sessionId);
    params.set("page", String(page));
    params.set("page_size", "20");
    params.set("forward", "false");
    params.set("return_response_messages", "true");
    params.set("event_filter", "all");

    const response = await fetchFromHost(`${API_BASE}${MSG_LIST_PATH}?${params.toString()}`, { headers });
    if (!response.ok || !response.json) throw new ExtractionError("千问接口不可用", "api");
    const payload = response.json;
    if (pick(payload, "success") === false) {
      throw new ExtractionError(pick(payload, "code", "message") || "千问接口返回错误", "api");
    }
    const batch = asArray(pick(pick(payload, "data")) ?? payload, "list");
    if (!batch.length) break;
    turns.push(...batch);
    if (batch.length < 20) break;
    await sleep(60);
  }
  return turns.reverse();
}

/** Each turn is { request_messages[], response_messages[] | qwen_response_messages[] }. */
function parseTurn(turn) {
  const question = tidy(
    asArray(pick(turn, "request_messages"))
      .map((message) => tidy(pick(message, "content", "text")))
      .filter(Boolean)
      .join("\n\n"),
  );

  const answers = asArray(pick(turn, "response_messages") ?? pick(turn, "qwen_response_messages"));
  const answer = [];
  const thinking = [];
  const sources = [];

  for (const message of answers) {
    const text = tidy(pick(message, "content", "text"));
    if (text) answer.push(text);
    for (const item of asArray(pick(message, "multi_load"))) {
      const type = String(pick(item, "type") ?? "");
      const reason = tidy(pick(item, "think_content", "thinkContent"));
      if (type.includes("think") && reason) thinking.push(reason);
      for (const resource of asArray(pick(item, "resources") ?? pick(item, "resource_infos"))) {
        const url = pick(resource, "url");
        if (url) sources.push({ url, title: pick(resource, "title", "name") ?? url });
      }
    }
  }

  // Turn-level reasoning when the messages do not carry it.
  if (!thinking.length) {
    const reason = tidy(pick(turn, "think_content", "deep_think"));
    if (reason) thinking.push(reason);
  }

  return {
    question,
    answer: answer.join("\n\n"),
    thinking: thinking.join("\n\n"),
    sources,
  };
}

function convert(turns) {
  const output = [];
  for (const turn of turns) {
    const parsed = parseTurn(turn);
    if (parsed.question) output.push({ role: "user", markdown: normalizeMath(parsed.question) });

    const { markdown, sources } = withSources(normalizeMath(parsed.answer), parsed.sources);
    if (markdown || parsed.thinking) {
      output.push({
        role: "assistant",
        markdown,
        thinking: parsed.thinking ? [{ title: "思考过程", text: normalizeMath(parsed.thinking) }] : [],
        sources,
      });
    }
  }
  return output;
}

function pageTitle() {
  const heading = document.querySelector("[class*='session-title'], [class*='conversation-title'], h1");
  return heading?.textContent?.trim() || document.title.replace(/\s*[-|]\s*(千问|Qwen).*$/i, "") || "千问会话";
}

async function extractFromApi() {
  const sessionId = location.pathname.match(CONVERSATION)?.[1];
  if (!sessionId) throw new ExtractionError("当前不是千问会话页", "not-conversation");
  const messages = convert(await loadTurns(sessionId));
  if (!messages.length) throw new ExtractionError("会话没有消息", "empty");
  return { source: "api", title: pageTitle(), messages };
}

/* ---------------- DOM fallback (low confidence; API is the main path) ---------------- */

function domMessages() {
  const rows = rowsByRole({
    userSelector: "[class*='user-message'], [class*='question']",
    assistantSelector: "[class*='assistant-message'], [class*='markdown-body'], [class*='response']",
  });

  return messagesFromRows(rows, {
    bodySelector: ".markdown-body, [class*='markdown']",
    thinkingSelectors: ["[class*='think'], [class*='deep-think']"],
  });
}

export default {
  id: "qianwen",
  name: "千问",
  match: (url) => HOSTS.includes(new URL(url).hostname),
  isConversationUrl: (url) => CONVERSATION.test(new URL(url).pathname),
  isLoggedIn: () => Boolean(document.querySelector("[class*='chat'], [class*='session']")),
  isGenerating: () => Boolean(document.querySelector("[class*='stop'], [class*='generating']")),
  getTitle: pageTitle,
  extractFromApi,
  domFallback: { getMessages: domMessages },
};