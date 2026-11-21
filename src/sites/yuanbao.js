import { ExtractionError, fetchJson, sleep, withAuthRetry } from "../content/extract/api.js";
import { asArray, collectSources, normalizeMath, pick, tidy, withSources } from "../content/extract/text.js";
import { messagesFromRows, rowsByRole } from "./_dom.js";

const HOSTS = ["yuanbao.tencent.com"];
const CONVERSATION = /^\/chat\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{8,128})\/?$/;
const DEFAULT_AGENT = "naQivTmsDa";
const DETAIL_PATH = "/api/user/agent/conversation/v1/detail";

async function fetchDetail(agentId, conversationId, offset, limit) {
  return withAuthRetry(() =>
    fetchJson(DETAIL_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ conversationId, agentId, offset, limit }),
    }),
  );
}

/** The API answers {code, ...}; anything but 0 is an error. */
function unwrap(response) {
  if (!response.ok || !response.json) throw new ExtractionError("元宝接口不可用", "api");
  const payload = response.json;
  const code = pick(payload, "code") ?? 0;
  if (String(code) !== "0") throw new ExtractionError(pick(payload, "msg", "message") || "元宝接口返回错误", "api");
  return pick(payload, "data") ?? payload;
}

async function loadConversation(agentId, conversationId) {
  const pageSize = 30;
  const collected = [];
  let offset = 0;
  let title = "";

  for (let page = 0; page < 60; page += 1) {
    const data = unwrap(await fetchDetail(agentId, conversationId, offset, pageSize));
    const convs = asArray(pick(data, "convs", "conversations", "messages"));
    title = title || tidy(pick(data, "title", "conversationTitle"));
    if (!convs.length) break;
    collected.push(...convs);
    const total = Number(pick(data, "total", "totalCount") ?? 0);
    offset += convs.length;
    if (convs.length < pageSize || (total && offset >= total)) break;
    await sleep(60);
  }

  return { title, convs: collected.reverse() };
}

/** speechesV2 holds text / searchGuid / deepSearch (its texts are the reasoning). */
function parseSpeech(speech) {
  const answer = [];
  const thinking = [];
  const sources = [];

  for (const item of asArray(pick(speech, "content", "contents", "speechesV2"))) {
    const type = String(pick(item, "type") ?? "").toLowerCase();

    if (type.includes("think") || pick(item, "thinkDeepInfo")) {
      const info = pick(item, "thinkDeepInfo") ?? item;
      const text = tidy(pick(info, "text", "msg", "content"));
      if (text) thinking.push(text);
      continue;
    }

    if (type.includes("deepsearch")) {
      const texts = asArray(pick(item, "texts") ?? [])
        .map((entry) => tidy(pick(entry, "text") ?? entry))
        .filter(Boolean);
      if (texts.length) thinking.push(texts.join("\n\n"));
      continue;
    }

    if (pick(item, "searchGuid") || type.includes("search")) {
      sources.push(...collectSources(pick(item, "docs") ?? item));
    }

    const text = tidy(pick(item, "msg", "text", "content"));
    if (text) answer.push(text);
  }

  return { answer: answer.join("\n\n"), thinking: thinking.join("\n\n"), sources };
}

function convert(convs) {
  const output = [];
  for (const conv of convs) {
    const speaker = String(pick(conv, "speaker", "role") ?? "").toLowerCase();
    const speeches = asArray(pick(conv, "speechesV2", "speeches", "speech"));

    if (!speeches.length) {
      const text = tidy(pick(conv, "displayPrompt", "text", "content"));
      if (text) output.push({ role: speaker === "ai" ? "assistant" : "user", markdown: normalizeMath(text) });
      continue;
    }

    const merged = { answer: [], thinking: [], sources: [] };
    for (const speech of speeches) {
      const parsed = parseSpeech(speech);
      if (parsed.answer) merged.answer.push(parsed.answer);
      if (parsed.thinking) merged.thinking.push(parsed.thinking);
      merged.sources.push(...parsed.sources);
    }

    if (speaker === "human" || speaker === "user") {
      output.push({ role: "user", markdown: normalizeMath(merged.answer.join("\n\n")) });
      continue;
    }

    const { markdown, sources } = withSources(normalizeMath(merged.answer.join("\n\n")), merged.sources);
    const thinking = merged.thinking.join("\n\n");
    if (!markdown && !thinking) continue;
    output.push({
      role: "assistant",
      markdown,
      thinking: thinking ? [{ title: "深度思考", text: normalizeMath(thinking) }] : [],
      sources,
    });
  }
  return output;
}

function pageTitle() {
  const heading = document.querySelector(".agent-chat__title, [class*='conversation-title'], h1");
  return heading?.textContent?.trim() || document.title.replace(/\s*[-|]\s*腾讯元宝.*$/i, "") || "元宝会话";
}

async function extractFromApi() {
  const match = location.pathname.match(CONVERSATION);
  if (!match) throw new ExtractionError("当前不是元宝会话页", "not-conversation");
  const [, agentId, conversationId] = match;

  const { title, convs } = await loadConversation(agentId || DEFAULT_AGENT, conversationId);
  const messages = convert(convs);
  if (!messages.length) throw new ExtractionError("会话没有消息", "empty");
  return { source: "api", title: title || pageTitle(), messages };
}

/* ---------------- DOM fallback (selectors verified in live CSS) ---------------- */

function domMessages() {
  const rows = rowsByRole({
    userSelector: ".agent-chat__bubble--human, [data-speaker='human'], .agent-chat__conv--human",
    assistantSelector: ".agent-chat__bubble--ai, [data-speaker='ai'], .agent-chat__conv--ai",
  });

  return messagesFromRows(rows, {
    bodySelector: ".hyc-common-markdown:not(.hyc-common-markdown-style-cot), .hyc-content-md, .hyc-content-text",
    thinkingSelectors: [
      ".hyc-component-reasoner__think",
      ".hyc-component-deepsearch-cot__think",
      ".hyc-think-content-scroller",
    ],
  });
}

export default {
  id: "yuanbao",
  name: "元宝",
  match: (url) => HOSTS.includes(new URL(url).hostname),
  isConversationUrl: (url) => CONVERSATION.test(new URL(url).pathname),
  isLoggedIn: () => Boolean(document.querySelector(".agent-chat__list, .agent-chat__bubble")),
  isGenerating: () =>
    Boolean(document.querySelector(".agent-chat__bubble--ai [class*='stream'], .agent-chat__bubble--ai [class*='typing']")),
  getTitle: pageTitle,
  extractFromApi,
  domFallback: {
    getMessages: domMessages,
    getScrollContainer: () => document.querySelector(".agent-chat__list__content, .agent-chat__list__content-wrapper"),
  },
};