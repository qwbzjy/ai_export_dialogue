/**
 * Smoke tests, run with `npm test`.
 *
 * These cover the parts that can be exercised outside a browser: payload
 * normalisation (adapter → unified model), Markdown generation, filename
 * hygiene and the storage key layout. They cannot prove a site adapter's
 * selectors still match the live bundle — that needs a real session — but
 * they do catch shape regressions in our own code.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split("\n")[0]}`);
  }
}

/* ---------------- text helpers ---------------- */

const { tidy, normalizeMath, withSources, collectSources, pick, looseJson } = await import(
  "../src/content/extract/text.js"
);

await test("normalizeMath rewrites both delimiter styles", () => {
  assert.equal(normalizeMath("a \\(x^2\\) b"), "a $x^2$ b");
  assert.match(normalizeMath("前\n\\[E=mc^2\\]\n后"), /\$\$\nE=mc\^2\n\$\$/);
});

await test("withSources numbers markers and appends the reference list", () => {
  const { markdown, sources } = withSources("结论[citation:1]，另一处【2†docs】。", [
    { title: "维基", url: "https://a.example/1" },
    { title: "文档", url: "https://b.example/2" },
  ]);
  assert.match(markdown, /结论\[1\]/);
  assert.match(markdown, /另一处\[2\]/);
  assert.equal(sources.length, 2);
  assert.match(markdown, /\*\*参考来源\*\*/);
  assert.match(markdown, /1\. \[维基\]\(https:\/\/a\.example\/1\)/);
});

await test("unknown citation markers are dropped, not kept as noise", () => {
  const { markdown, sources } = withSources("只有标记[[source_group_web_3]]。", []);
  assert.equal(markdown, "只有标记。");
  assert.equal(sources.length, 0);
});

await test("withSources reuses one number for a repeated source", () => {
  const { markdown } = withSources("[citation:2] 和 [citation:1]", [
    { title: "A", url: "https://a.example" },
    { title: "B", url: "https://a.example" },
  ]);
  assert.equal(markdown.match(/\[1\]/g).length, 2);
});

await test("collectSources walks nested payloads for url/title", () => {
  const found = collectSources({
    result: { items: [{ url: "https://x.example", title: "X", cite_index: 1 }], other: "no url" },
  });
  assert.deepEqual(found.map((item) => item.url), ["https://x.example"]);
  assert.equal(found[0].index, 1);
});

await test("pick is case-insensitive and skips nulls", () => {
  assert.equal(pick({ CamelKey: "v", plain: null }, "camelkey"), "v");
  assert.equal(pick({ plain: null }, "plain", "missing"), undefined);
});

await test("looseJson unwraps a doubly encoded JSON string", () => {
  assert.deepEqual(looseJson(JSON.stringify(JSON.stringify({ a: 1 }))), { a: 1 });
  assert.equal(looseJson("not json"), "not json");
});

/* ---------------- filename ---------------- */

const { sanitizeName, exportFileName, fileStamp } = await import("../src/util/filename.js");

await test("sanitizeName strips path characters and keeps Chinese", () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a b c d e f g h i j");
  assert.equal(sanitizeName("  二分查找  "), "二分查找");
  assert.equal(sanitizeName(""), "untitled");
  assert.equal(sanitizeName("..."), "untitled");
  assert.equal(sanitizeName("CON"), "CON_");
});

await test("sanitizeName caps length at 80 characters", () => {
  assert.equal(sanitizeName("长".repeat(200)).length, 80);
});

await test("exportFileName has site, title and a minute stamp", () => {
  const date = new Date(2026, 10, 20, 17, 30);
  assert.equal(fileStamp(date), "20261120-1730");
  assert.equal(
    exportFileName({ siteName: "DeepSeek", title: "二分查找", ext: "md", date }),
    "DeepSeek-二分查找-20261120-1730.md",
  );
});

/* ---------------- storage key layout ---------------- */

const { exportKeys, deleteExport } = await import("../src/util/export-store.js");

await test("exportKeys lists meta, count, messages and images", () => {
  const keys = exportKeys("abc", { count: 2, imageCount: 1 });
  assert.deepEqual(keys, [
    "exp:abc:meta",
    "exp:abc:m:count",
    "exp:abc:m:0",
    "exp:abc:m:1",
    "exp:abc:img:0",
  ]);
});

await test("deleteExport removes only one export's keys", async () => {
  const store = new Map([
    ["exp:index", { abc: Date.now(), def: Date.now() }],
    ["exp:abc:meta", { messageCount: 1, imageCount: 1 }],
    ["exp:abc:m:count", { count: 1 }],
    ["exp:abc:m:0", { role: "user" }],
    ["exp:abc:img:0", "data:image/png;base64,"],
    ["exp:def:meta", { messageCount: 3, imageCount: 0 }],
    ["exp:def:m:0", {}],
  ]);
  globalThis.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(list.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
        },
        set: async (entries) => {
          for (const [key, value] of Object.entries(entries)) store.set(key, value);
        },
        remove: async (keys) => {
          for (const key of keys) store.delete(key);
        },
      },
    },
  };

  await deleteExport("abc");
  assert.equal(store.has("exp:abc:meta"), false);
  assert.equal(store.has("exp:abc:img:0"), false);
  assert.equal(store.has("exp:abc:m:0"), false);
  assert.equal(store.has("exp:def:m:0"), true);
  assert.deepEqual(Object.keys(store.get("exp:index")), ["def"]);
  delete globalThis.chrome;
});

/* ---------------- normalizeMessages ---------------- */

const { normalizeMessages } = await import("../src/content/extract/convert.js");

await test("normalizeMessages keeps adapter thinking text and drops empties", async () => {
  const { messages, warnings } = await normalizeMessages({
    source: "api",
    messages: [
      { role: "user", markdown: "问" },
      {
        role: "assistant",
        markdown: "答",
        thinking: [{ title: "思考过程", text: "因为……" }],
        images: [{ url: "https://img.example/a.png" }, { url: "" }],
      },
      { role: "assistant", markdown: "   ", thinking: [] },
    ],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].thinking[0].markdown, "因为……");
  assert.equal(messages[1].images.length, 1);
  assert.equal(messages[1].images[0].url, "https://img.example/a.png");
  assert.deepEqual(warnings, []);
});

await test("normalizeMessages maps an unknown role to assistant, never drops it", async () => {
  const { messages } = await normalizeMessages({
    source: "api",
    messages: [{ role: "system", markdown: "系统提示" }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "assistant");
});

await test("normalizeMessages embeds images once per unique URL", async () => {
  const calls = [];
  const { messages, warnings } = await normalizeMessages(
    {
      source: "dom",
      messages: [
        { role: "user", html: "<p>x</p>", images: [{ src: "https://img.example/a.png" }] },
        { role: "assistant", html: "<p>y</p>", images: [{ src: "https://img.example/a.png" }] },
      ],
    },
    {
      embedImages: async (images) => {
        calls.push(images.length);
        return {
          images: images.map((image) => ({ url: image.src, dataUri: "data:image/png;base64,AAA" })),
          warnings: ["一次失败"],
        };
      },
    },
  );
  assert.deepEqual(calls, [1]);
  assert.equal(messages[0].images[0].dataUri, "data:image/png;base64,AAA");
  assert.equal(messages[1].images[0].dataUri, "data:image/png;base64,AAA");
  assert.deepEqual(warnings, ["一次失败"]);
});

/* ---------------- adapters (API payload → messages) ---------------- */

// The adapters read `location`, so a tiny stand-in is enough for the pure
// payload conversions; the DOM paths need jsdom and are tested separately.
function fakeLocation(url) {
  const parsed = new URL(url);
  return { href: parsed.href, pathname: parsed.pathname, origin: parsed.origin, hostname: parsed.hostname };
}

globalThis.navigator ??= { language: "zh-CN" };

/** The adapters read tokens through `window.localStorage` in the page. */
function fakeWindow(entries = {}) {
  globalThis.window = {
    localStorage: {
      getItem: (key) => (key in entries ? entries[key] : null),
    },
  };
}

/** Only the title lookup touches the DOM on the API path. */
function stubDocument(title) {
  globalThis.document ??= {
    title,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ appendChild() {} }),
  };
}

await test("deepseek adapter walks only the active branch and keeps math", async () => {
  const payload = JSON.parse(
    readFileSync(path.join(root, "fixtures/deepseek-history.json"), "utf8"),
  );
  globalThis.location = fakeLocation("https://chat.deepseek.com/a/abc/s/xyz");
  fakeWindow({ userToken: JSON.stringify({ value: "tok" }) });
  stubDocument("DeepSeek");

  const responses = [payload];
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(responses.shift()),
  });

  const adapter = (await import("../src/sites/deepseek.js")).default;
  const result = await adapter.extractFromApi();

  assert.equal(result.source, "api");
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "user", "assistant"]);
  // The alternate branch (m1) is not part of the current conversation.
  assert.equal(result.messages.some((message) => message.markdown.includes("旧分支")), false);
  const answer = result.messages[2];
  assert.match(answer.markdown, /\$O\(\\log n\)\$/);
  assert.match(answer.markdown, /```python/);
  assert.match(answer.thinking[0].text, /复杂度/);
  assert.equal(answer.sources[0].url, "https://example.com/binary-search");
});

await test("qwen adapter follows history.currentId and keeps user content_list", async () => {
  globalThis.location = fakeLocation("https://chat.qwen.ai/c/12345678-abcd");
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        data: {
          title: "表格示例",
          chat: {
            history: {
              currentId: "b",
              messages: {
                a: { _id: "a", role: "user", content: "写个表格", parentId: null },
                x: { _id: "x", role: "assistant", content: "被弃用的回答", parentId: "a" },
                b: {
                  _id: "b",
                  role: "assistant",
                  parentId: "a",
                  content: {
                    content_list: [
                      { phase: "think", content: "先列两列。" },
                      { phase: "answer", content: "| 名称 | 值 |\n| --- | --- |\n| A | 1 |" },
                    ],
                  },
                },
              },
            },
          },
        },
      }),
  });
  fakeWindow({ token: "tok" });

  const adapter = (await import("../src/sites/qwen.js")).default;
  const result = await adapter.extractFromApi();

  assert.equal(result.title, "表格示例");
  assert.deepEqual(result.messages.map((message) => message.role), ["user", "assistant"]);
  assert.match(result.messages[1].markdown, /\| 名称 \| 值 \|/);
  assert.match(result.messages[1].thinking[0].text, /先列两列/);
});

/* ---------------- DOM collection (jsdom) ---------------- */

const { JSDOM } = await import("jsdom");
const { collectFromDom } = await import("../src/content/extract/collect.js");
const { siteForUrl } = await import("../src/sites/index.js");

/** Points the module-level globals a browser content script would have. */
function installDom(html, url) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { url });
  const { window } = dom;
  for (const name of [
    "window",
    "document",
    "DOMParser",
    "MutationObserver",
    "Node",
    "Element",
    "HTMLElement",
    "getComputedStyle",
  ]) {
    globalThis[name] = window[name];
  }
  globalThis.location = fakeLocation(url);
  // jsdom has no layout: every element reports height 0, which would make the
  // scroll container loop spin. Report the inline height when there is one.
  globalThis.getComputedStyle = () => ({ overflowY: "auto" });
  return dom;
}

await test("collectFromDom prepends batches loaded later, preserving order", async () => {
  installDom("", "https://chat.deepseek.com/a/abc/s/xyz");
  document.body.innerHTML = `
    <div id="scroll">
      <div class="row" data-n="1">问题一</div>
      <div class="row" data-n="2"><div class="ds-markdown"><p>回答一</p></div></div>
      <div class="row" data-n="3">问题二</div>
      <div class="row" data-n="4"><div class="ds-markdown"><p>回答二</p></div></div>
    </div>`;
  const row = (n) => document.querySelector(`.row[data-n="${n}"]`);

  // First snapshot: only the newest two rows are rendered (virtualised list).
  // After the scroll step the older pair appears.
  let calls = 0;
  let progress = 0;
  const collected = await collectFromDom({
    getMessages: () => {
      calls += 1;
      return calls === 1
        ? [
            { role: "user", node: row(3) },
            { role: "assistant", node: row(4) },
          ]
        : [
            { role: "user", node: row(1) },
            { role: "assistant", node: row(2) },
            { role: "user", node: row(3) },
            { role: "assistant", node: row(4) },
          ];
    },
    getScrollContainer: () => document.querySelector("#scroll"),
    onProgress: () => {
      progress += 1;
    },
  });

  assert.deepEqual(
    collected.messages.map((message) => message.html.replace(/<[^>]+>/g, "")),
    ["问题一", "回答一", "问题二", "回答二"],
  );
  assert.equal(collected.count, 4);
  assert.ok(progress >= 1);
});

await test("collectFromDom deduplicates and strips toolbar buttons", async () => {
  installDom("", "https://chat.deepseek.com/a/abc/s/xyz");
  document.body.innerHTML = `
    <div id="scroll">
      <div class="row">问</div>
      <div class="row"><div class="ds-markdown"><p>答</p><button>复制</button></div></div>
    </div>`;
  const collected = await collectFromDom({
    getMessages: () => [
      { role: "user", node: document.querySelector(".row") },
      { role: "assistant", node: document.querySelector(".row:nth-child(2)") },
    ],
    loadAll: false,
  });
  assert.equal(collected.messages.length, 2);
  assert.equal(collected.messages[1].html.includes("复制"), false);
  assert.equal(collected.messages[1].html.includes("<button"), false);
});

await test("deepseek DOM: reasoning's nested .ds-markdown never becomes the answer", async () => {
  installDom("", "https://chat.deepseek.com/a/abc/s/xyz");
  document.body.innerHTML = `
    <div class="ds-message"><div class="user-text">为什么天是蓝的？</div></div>
    <div class="ds-message">
      <div class="ds-think-content">
        <div class="ds-markdown"><p>先回忆瑞利散射的推导，这里是推理内容。</p></div>
      </div>
      <div class="ds-markdown"><p>因为瑞利散射。</p></div>
    </div>`;
  const adapter = (await import("../src/sites/deepseek.js")).default;
  const { collectFromDom: collect } = await import("../src/content/extract/collect.js");
  const collected = await collect({
    getMessages: adapter.domFallback.getMessages,
    loadAll: false,
  });

  assert.deepEqual(collected.messages.map((message) => message.role), ["user", "assistant"]);
  const answer = collected.messages[1];
  assert.match(answer.html, /瑞利散射/);
  assert.equal(/推理内容/.test(answer.html), false, "chain of thought leaked into the answer");
  assert.equal(answer.thinking.length, 1);
  assert.match(answer.thinking[0].html, /推理内容/);
});

await test("deepseek DOM: roles fall back to parity when no answer signal exists", async () => {
  installDom("", "https://chat.deepseek.com/a/abc/s/xyz");
  document.body.innerHTML = `
    <div class="ds-message"><p>第一问</p></div>
    <div class="ds-message"><p>第一答</p></div>
    <div class="ds-message"><p>第二问</p></div>
    <div class="ds-message"><p>第二答</p></div>`;
  const adapter = (await import("../src/sites/deepseek.js")).default;
  const messages = adapter.domFallback.getMessages();
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
});

await test("kimi DOM: think wrapper is not mistaken for the answer, code keeps its language", async () => {
  installDom("", "https://www.kimi.com/chat/1234abcd");
  document.body.innerHTML = `
    <div class="chat-content-item-user">
      <div class="segment-user"><div class="markdown-container"><p>写个快速排序</p></div></div>
    </div>
    <div class="chat-content-item-assistant">
      <div class="segment-assistant">
        <div class="thinking-container"><div class="markdown-container toolcall-content-text"><p>需要先选基准。</p></div></div>
        <div class="markdown-container"><p>下面是实现。</p></div>
        <div class="segment-code"><div class="segment-code-lang">Python</div><pre><code>def qs(x): return x</code></pre></div>
        <div class="segment-assistant-actions"><button>复制</button></div>
      </div>
    </div>`;
  const adapter = (await import("../src/sites/kimi.js")).default;
  const { collectFromDom: collect } = await import("../src/content/extract/collect.js");
  const collected = await collect({
    getMessages: adapter.domFallback.getMessages,
    loadAll: false,
  });

  assert.deepEqual(collected.messages.map((message) => message.role), ["user", "assistant"]);
  const answer = collected.messages[1];
  assert.match(answer.html, /下面是实现/);
  assert.equal(/需要先选基准/.test(answer.html), false, "reasoning leaked into the answer");
  assert.equal(answer.thinking.length, 1);
  assert.equal(/复制/.test(answer.html), false, "action bar was kept");
  assert.match(answer.html, /data-language="python"/);
  assert.equal(/Python<\/div>/.test(answer.html), false, "language label left in the body");
});

await test("kimi API: think/text blocks split, direction and Connect headers sent", async () => {
  globalThis.location = fakeLocation("https://www.kimi.com/chat/1234abcd");
  fakeWindow({ access_token: "tok" });
  stubDocument("Kimi");

  const calls = [];
  globalThis.fetch = async (_url, init) => {
    calls.push({ headers: init.headers, body: JSON.parse(init.body) });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          messages: [
            {
              role: "assistant",
              blocks: [
                { think: { content: "先想一下。" } },
                { text: { content: "答案是 **42**。" } },
              ],
            },
            { role: "user", blocks: [{ text: { content: "终极问题？" } }] },
          ],
        }),
    };
  };

  const adapter = (await import("../src/sites/kimi.js")).default;
  const result = await adapter.extractFromApi();

  // No timestamps → API order is preserved (not sorted arbitrarily).
  assert.deepEqual(result.messages.map((message) => message.role), ["assistant", "user"]);
  assert.match(result.messages[0].markdown, /\*\*42\*\*/);
  assert.equal(result.messages[0].thinking[0].text, "先想一下。");
  assert.equal(calls[0].headers["connect-protocol-version"], "1");
  assert.equal(calls[0].body.direction, "DIRECTION_FORWARD");
  assert.equal(calls[0].body.chatId, "1234abcd");
});

/* Every adapter's DOM fallback, against its page fixture. */
const { DOM_FIXTURES, mountFixture } = await import("./dom-fixtures.js");

for (const [siteId, fixture] of Object.entries(DOM_FIXTURES)) {
  await test(`${siteId} DOM fallback exports the page fixture cleanly`, async () => {
    installDom("", fixture.url);
    const scroll = mountFixture(document, fixture);
    const adapter = siteForUrl(fixture.url);
    assert.equal(adapter?.id, siteId, `${fixture.url} mapped to ${adapter?.id}`);

    const { collectFromDom: collect } = await import("../src/content/extract/collect.js");
    const collected = await collect({
      getMessages: adapter.domFallback.getMessages,
      getScrollContainer: () => scroll,
      loadAll: false,
    });

    const { expect } = fixture;
    assert.deepEqual(collected.messages.map((message) => message.role), expect.roles);

    const answers = collected.messages.filter((message) => message.role === "assistant");
    for (const needle of expect.answers ?? []) {
      assert.ok(
        answers.some((message) => message.html.includes(needle)),
        `no answer contains ${JSON.stringify(needle)}: ${JSON.stringify(answers.map((a) => a.html))}`,
      );
    }
    if (expect.thinking != null) {
      assert.equal(answers.reduce((sum, message) => sum + message.thinking.length, 0), expect.thinking);
    }
    for (const needle of expect.absent ?? []) {
      const leaked = answers.filter((message) => message.html.includes(needle));
      assert.equal(leaked.length, 0, `answer still contains ${JSON.stringify(needle)}`);
    }
  });
}

await test("siteForUrl recognises every supported host", () => {
  const cases = [
    ["https://chat.deepseek.com/a/x/s/y", "deepseek"],
    ["https://www.kimi.com/chat/1234abcd", "kimi"],
    ["https://www.doubao.com/chat/1234567890", "doubao"],
    ["https://yuanbao.tencent.com/chat/naQivTmsDa/1234567890abcd", "yuanbao"],
    ["https://chat.qwen.ai/c/12345678-abcd", "qwen"],
    ["https://www.qianwen.com/chat/12345678-abcd", "qianwen"],
    ["https://tongyi.aliyun.com/chat/12345678-abcd", "qianwen"],
  ];
  for (const [url, id] of cases) {
    assert.equal(siteForUrl(url)?.id, id, url);
  }
  assert.equal(siteForUrl("https://example.com/"), null);
});

await test("isConversationUrl rejects list pages", () => {
  const kimi = siteForUrl("https://www.kimi.com/chat/history");
  assert.ok(kimi);
  assert.equal(kimi.isConversationUrl("https://www.kimi.com/chat/history"), false);
  assert.equal(kimi.isConversationUrl("https://www.kimi.com/chat/1234abcd"), true);
});

/* ---------------- Markdown rendering ---------------- */

const { buildMarkdown } = await import("../src/export/markdown.js");

const SAMPLE = {
  site: "deepseek",
  siteName: "DeepSeek",
  title: "二分查找 & 例子",
  url: "https://chat.deepseek.com/a/abc/s/xyz",
  exportedAt: "2026-11-20T09:30:00.000Z",
  source: "api",
  warnings: [],
  messages: [
    { role: "user", markdown: "什么是二分查找？", thinking: [], images: [], sources: [] },
    {
      role: "assistant",
      markdown: "复杂度是 $O(\\log n)$。\n\n```python\nprint(1)\n```",
      thinking: [{ title: "思考过程", markdown: "先想一下。" }],
      images: [{ alt: "图", dataUri: "data:image/png;base64,AAA" }],
      sources: [{ title: "维基", url: "https://example.com/w" }],
    },
  ],
};

await test("buildMarkdown writes the title, metadata, roles and thinking", () => {
  const markdown = buildMarkdown(SAMPLE);
  assert.match(markdown, /^# 二分查找 & 例子$/m);
  assert.match(markdown, /> 来源：DeepSeek · 链接：/);
  assert.match(markdown, /## 👤 用户/);
  assert.match(markdown, /## 🤖 DeepSeek/);
  assert.match(markdown, /<details>\n<summary>思考过程<\/summary>/);
  assert.match(markdown, /```python\nprint\(1\)\n```/);
  assert.match(markdown, /!\[图\]\(data:image\/png;base64,AAA\)/);
  assert.match(markdown, /- \[维基\]\(https:\/\/example\.com\/w\)/);
});

await test("buildMarkdown reports when the DOM fallback was used", () => {
  const markdown = buildMarkdown({ ...SAMPLE, source: "dom" });
  assert.match(markdown, /提取方式：页面内容（接口不可用）/);
});

/* ---------------- report ---------------- */

console.log("");
if (failures.length) {
  console.log(`${failures.length} failed, ${passed} passed`);
  for (const { name, error } of failures) {
    console.log(`\n--- ${name}\n${error.stack ?? error.message}`);
  }
  process.exit(1);
}
console.log(`${passed} passed`);