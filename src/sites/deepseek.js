import {
  ExtractionError,
  fetchJson,
  parseToken,
  readLocalStorage,
  sleep,
  withAuthRetry,
} from "../content/extract/api.js";
import { asArray, collectSources, looseJson, normalizeMath, pick, tidy, withSources } from "../content/extract/text.js";
import { textOf } from "../content/extract/sanitize.js";
import { expandThinking, wrapThinking } from "./_dom.js";

const HOSTS = ["chat.deepseek.com"];
const CONVERSATION = /^\/a\/[A-Za-z0-9_-]+\/s\/([A-Za-z0-9_-]{1,128})\/?$/;

function token() {
  return parseToken(readLocalStorage("userToken"));
}

function headers() {
  const bearer = token();
  if (!bearer) throw new ExtractionError("未登录 DeepSeek", "auth");
  return {
    Authorization: `Bearer ${bearer}`,
    "x-client-bundle-id": "com.deepseek.chat",
    "x-client-platform": "web",
    "x-client-version": "2.3.0",
    "x-client-locale": navigator.language.replace("-", "_") || "zh_CN",
    "x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
  };
}

/** Walks the message tree from the on-screen message back to the root. */
function activeBranch(session, messages) {
  const byId = new Map();
  for (const message of messages) {
    const id = pick(message, "message_id", "id");
    if (id != null) byId.set(String(id), message);
  }

  let currentId = pick(session, "current_message_id", "currentMessageId");
  const branch = [];
  const guard = new Set();

  while (currentId != null) {
    const key = String(currentId);
    if (guard.has(key)) break;
    guard.add(key);
    const message = byId.get(key);
    if (!message) break;
    branch.push(message);
    currentId = pick(message, "parent_id", "parentId");
  }

  if (branch.length) return branch.reverse();

  // No tree (older sessions): keep the API's own order.
  return messages;
}

function fragmentType(fragment) {
  return String(pick(fragment, "type") ?? "").toUpperCase();
}

/** Concatenates a message's fragments of the accepted types. */
function fragmentsText(message, accepted) {
  const parts = asArray(pick(message, "fragments"))
    .filter((fragment) => accepted.includes(fragmentType(fragment)))
    .map((fragment) => tidy(pick(fragment, "content")))
    .filter(Boolean);
  if (parts.length) return parts.join("\n\n");
  return tidy(pick(message, "content"));
}

function thinkingText(message) {
  const parts = asArray(pick(message, "fragments"))
    .filter((fragment) => fragmentType(fragment) === "THINK")
    .map((fragment) => tidy(pick(fragment, "content")))
    .filter(Boolean);
  if (parts.length) return parts.join("\n\n");
  return tidy(pick(message, "thinking_content"));
}

function filesOf(message) {
  return [
    ...asArray(pick(message, "files")),
    ...asArray(pick(message, "fragments"))
      .filter((fragment) => fragmentType(fragment) === "FILE")
      .flatMap((fragment) => [...asArray(pick(fragment, "files")), ...asArray([pick(fragment, "file")])]),
  ].filter(Boolean);
}

function fileUrl(file) {
  const path = pick(file, "signed_path", "url");
  if (!path) return null;
  try {
    if (/^\/file(?:\?|$)/.test(path)) {
      const url = new URL(`https://files.deepseeksvc.com/api${path}`);
      if (!url.searchParams.has("ty")) url.searchParams.set("ty", "p");
      return url.href;
    }
    const url = new URL(path, "https://chat.deepseek.com");
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function convert(message) {
  const role = String(pick(message, "role") ?? "").toUpperCase();
  const files = filesOf(message);

  const attachments = files
    .filter((file) => !isImageFile(file))
    .map((file) => `📎 ${pick(file, "file_name", "filename", "name") ?? "附件"}`);

  const imageFiles = files
    .filter(isImageFile)
    .map((file) => ({ url: fileUrl(file), alt: pick(file, "file_name", "filename", "name") ?? "" }))
    .filter((image) => image.url);

  if (role === "USER") {
    const text = tidy(pick(message, "content")) || tidy(
      asArray(pick(message, "fragments"))
        .filter((fragment) => ["REQUEST", "FILE"].includes(fragmentType(fragment)))
        .map((fragment) => tidy(pick(fragment, "content")))
        .filter(Boolean)
        .join("\n\n"),
    );
    const markdown = [text, ...attachments].filter(Boolean).join("\n\n");
    if (!markdown && !imageFiles.length) return null;
    return { role: "user", markdown: normalizeMath(markdown), images: imageFiles };
  }

  if (role !== "ASSISTANT") return null;

  const body = fragmentsText(message, ["RESPONSE", "TEMPLATE_RESPONSE"]);
  const sources = collectSources({
    fragments: asArray(pick(message, "fragments")).filter((fragment) =>
      ["SEARCH", "TOOL_SEARCH", "TOOL_OPEN"].includes(fragmentType(fragment)),
    ),
    search_results: pick(message, "search_results"),
  });
  const { markdown, sources: cited } = withSources(normalizeMath(body), sources);
  const thinking = thinkingText(message);

  if (!markdown && !thinking) return null;
  return {
    role: "assistant",
    markdown,
    thinking: thinking ? [{ title: "思考过程", text: normalizeMath(thinking) }] : [],
    sources: cited,
  };
}

function isImageFile(file) {
  const name = String(pick(file, "file_name", "filename", "name") ?? "");
  const mime = String(pick(file, "mime_type", "mimetype") ?? "");
  return pick(file, "is_image") === true || mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(name);
}

async function extractFromApi() {
  const conversationId = location.pathname.match(CONVERSATION)?.[1];
  if (!conversationId) throw new ExtractionError("当前不是 DeepSeek 会话页", "not-conversation");

  const response = await withAuthRetry(() =>
    fetchJson(
      `/api/v0/chat/history_messages?${new URLSearchParams({ chat_session_id: conversationId })}`,
      { headers: headers() },
    ),
  );

  if (!response.ok || !response.json) throw new ExtractionError("DeepSeek 接口不可用", "api");
  const payload = response.json;
  if (payload.code !== 0 && payload.code !== undefined) {
    throw new ExtractionError(payload.msg || "DeepSeek 接口返回错误", "api");
  }

  const data = looseJson(pick(looseJson(pick(payload, "data")), "biz_data"));
  const messages = activeBranch(pick(data, "chat_session") ?? {}, asArray(pick(data, "chat_messages")));

  const converted = messages.map(convert).filter(Boolean);
  if (!converted.length) throw new ExtractionError("会话没有消息", "empty");

  return {
    source: "api",
    title: pageTitle(),
    messages: converted,
  };
}

function pageTitle() {
  // The first question is the row without an answer body; falling back to
  // any row keeps this useful on a virtualised list that has scrolled away
  // from the top.
  const rows = domRows().filter((row) => textOf(row));
  const question = rows.find((row) => !answerBodies(row).length) ?? rows[0];
  const userText = question?.textContent?.replace(/\s+/g, " ").trim().slice(0, 60);
  const title = userText || document.title.replace(/\s*[-|]\s*DeepSeek.*$/i, "");
  return title || "DeepSeek 会话";
}

/* ---------------- DOM fallback ---------------- */

const THINKING = ".ds-think-content, [class*='ds-think']";
const MARKDOWN = ".ds-markdown, .ds-markdown--block";
const MESSAGE = ".ds-message";

/**
 * The message rows, in document order.
 *
 * The list is virtualised: rows live under
 * `.ds-virtual-list-visible-items`. Class hashes on the rows rotate between
 * builds (four projects disagree on them), so they are never matched here.
 */
function domRows() {
  const rows = [...document.querySelectorAll(MESSAGE)];
  if (rows.length) return rows;
  const viewport = document.querySelector(".ds-virtual-list-visible-items");
  return viewport ? [...viewport.children] : [];
}

/**
 * Answer bodies for one row, excluding those inside the reasoning block.
 * The think content contains its own nested `.ds-markdown`; treating it as
 * the answer is the classic "exported the chain of thought instead of the
 * reply" bug.
 */
function answerBodies(row) {
  return [...row.querySelectorAll(MARKDOWN)].filter((body) => !body.closest(THINKING));
}

/**
 * Each result is a detached wrapper (body clone + a cloned reasoning block).
 * Reasoning must be cloned into the wrapper: the collector only looks for
 * `details[data-thinking]` there.
 *
 * Roles: the assistant signal is "has an answer body or a reasoning block".
 * It is cross-checked against DOM parity (turn i is user for even i) and
 * discarded if it disagrees too often, so a build that renders user text as
 * Markdown cannot flip every role.
 */
function domMessages() {
  const rows = domRows();
  const isAssistantSignal = rows.map((row) => answerBodies(row).length > 0 || Boolean(row.querySelector(THINKING)));

  let agree = 0;
  let signalled = 0;
  rows.forEach((_row, index) => {
    if (!isAssistantSignal[index]) return;
    signalled += 1;
    if (index % 2 === 1) agree += 1;
  });
  const trustSignal = signalled > 0 && agree / signalled > 0.75;

  const output = [];
  rows.forEach((row, index) => {
    if (!textOf(row)) return;
    const role = trustSignal ? (isAssistantSignal[index] ? "assistant" : "user") : index % 2 === 0 ? "user" : "assistant";

    if (role === "user") {
      output.push({ role: "user", node: row });
      return;
    }

    const bodies = answerBodies(row);
    const wrapper = document.createElement("div");
    for (const body of bodies) wrapper.appendChild(body.cloneNode(true));
    if (!bodies.length) wrapper.appendChild(row.cloneNode(true));

    const thinking = [...row.querySelectorAll(THINKING)].filter((node) => !node.closest("details"));
    const details = wrapThinking(thinking);
    if (details) wrapper.appendChild(details);

    output.push({ role: "assistant", node: wrapper });
  });

  return output;
}

/**
 * The scroll area. The page also renders narrow "gutter" elements whose class
 * matches `scroll-area`; those never scroll, so candidates are validated by
 * the one property that matters. Falls back to the generic ancestor walk.
 */
function scrollContainer() {
  const candidates = [
    ...document.querySelectorAll("[class*='scroll-area']:not([class*='gutter'])"),
  ].filter((node) => node.scrollHeight > node.clientHeight + 8);
  if (!candidates.length) return null;
  return candidates.reduce((best, node) => (node.clientHeight > best.clientHeight ? node : best));
}

export default {
  id: "deepseek",
  name: "DeepSeek",
  match: (url) => HOSTS.includes(new URL(url).hostname),
  isConversationUrl: (url) => CONVERSATION.test(new URL(url).pathname),
  isLoggedIn: () => Boolean(token()),
  isGenerating: () =>
    Boolean(document.querySelector(".ds-loading, [class*='stop-button'], [class*='ds-loading']")),
  getTitle: pageTitle,
  extractFromApi,
  expandThinking: async () => {
    const result = await expandThinking([...document.querySelectorAll(THINKING)]);
    return result.clicked;
  },
  domFallback: {
    getMessages: domMessages,
    getScrollContainer: scrollContainer,
  },
};