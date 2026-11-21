/**
 * Minimal page markup per site, using the selectors the adapters target.
 * Each entry is a conversation URL plus HTML for `document.body`.
 *
 * The API fixtures (test/fixtures/*.json) cover payload parsing; these cover
 * the DOM fallback, which is what runs when a site's interface changes or the
 * token cannot be read. A selector rename in src/sites/ shows up here first.
 */

export const DOM_FIXTURES = {
  deepseek: {
    url: "https://chat.deepseek.com/a/abc/s/xyz",
    body: `
      <div class="ds-scroll-area" style="height:600px;overflow-y:auto">
        <div class="ds-message"><div class="user-text">什么是二分查找？</div></div>
        <div class="ds-message">
          <div class="ds-think-content"><div class="ds-markdown"><p>推理：先比较中点。</p></div></div>
          <div class="ds-markdown"><p>二分查找需要有序数组。</p></div>
        </div>
        <div class="ds-message"><div class="user-text">给个例子</div></div>
        <div class="ds-message"><div class="ds-markdown"><p>例子如下。</p></div></div>
      </div>`,
    expect: {
      roles: ["user", "assistant", "user", "assistant"],
      answers: ["二分查找需要有序数组", "例子如下"],
      thinking: 1,
      absent: ["推理：先比较中点"],
    },
  },

  kimi: {
    url: "https://www.kimi.com/chat/1234abcd",
    body: `
      <div class="chat-container">
        <div class="chat-content-item-user">
          <div class="segment-user"><div class="markdown-container"><p>写个表格</p></div></div>
        </div>
        <div class="chat-content-item-assistant">
          <div class="segment-assistant">
            <div class="thinking-container">先列两列。</div>
            <div class="markdown-container">
              <table><thead><tr><th>名称</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>
            </div>
            <div class="segment-assistant-actions"><button>复制</button></div>
          </div>
        </div>
      </div>`,
    expect: {
      roles: ["user", "assistant"],
      answers: ["<table", "名称"],
      thinking: 1,
      absent: ["复制", "先列两列"],
    },
  },

  doubao: {
    url: "https://www.doubao.com/chat/1234567890",
    body: `
      <div class="flow-scrollbar" style="height:600px;overflow-y:auto">
        <div data-message-id="1" data-testid="send_message"><div class="message-text">你好</div></div>
        <div data-message-id="2">
          <div class="md-box"><p>你好，有什么可以帮你？</p></div>
          <div class="toolbar"><button>复制</button></div>
        </div>
      </div>`,
    expect: {
      roles: ["user", "assistant"],
      answers: ["有什么可以帮你"],
      absent: ["复制"],
    },
  },

  yuanbao: {
    url: "https://yuanbao.tencent.com/chat/naQivTmsDa/1234567890abcd",
    body: `
      <div class="agent-chat__list__content" style="height:600px;overflow-y:auto">
        <div class="agent-chat__row"><div class="agent-chat__bubble--human"><div class="hyc-content-text">你好</div></div></div>
        <div class="agent-chat__row">
          <div class="agent-chat__bubble--ai">
            <div class="hyc-component-reasoner__think">思考中……</div>
            <div class="hyc-common-markdown"><p>你好，有什么可以帮你？</p></div>
            <div class="agent-chat__toolbar"><button>复制</button></div>
          </div>
        </div>
      </div>`,
    expect: {
      roles: ["user", "assistant"],
      answers: ["有什么可以帮你"],
      thinking: 1,
      absent: ["复制", "思考中……"],
    },
  },

  qwen: {
    url: "https://chat.qwen.ai/c/12345678-abcd",
    body: `
      <div class="chat-messages" style="height:600px;overflow-y:auto">
        <div class="qwen-chat-message-user"><div class="user-message-content">写个表格</div></div>
        <div class="qwen-chat-message-assistant">
          <div class="qwen-markdown">
            <table><thead><tr><th>名称</th><th>值</th></tr></thead>
              <tbody><tr><td>A</td><td>1</td></tr></tbody></table>
          </div>
          <div class="qwen-chat-package-comp-new-action-control"><button>复制</button></div>
        </div>
      </div>`,
    expect: {
      roles: ["user", "assistant"],
      answers: ["<table", "名称"],
      absent: ["复制"],
    },
  },

  qianwen: {
    url: "https://www.qianwen.com/chat/12345678-abcd",
    body: `
      <div class="chat-list" style="height:600px;overflow-y:auto">
        <div class="user-message"><span>你好</span></div>
        <div class="assistant-message">
          <div class="markdown-body"><p>你好，有什么可以帮你？</p></div>
        </div>
      </div>`,
    expect: {
      roles: ["user", "assistant"],
      answers: ["有什么可以帮你"],
    },
  },
};

/** Selector for the scroll container each fixture declares inline. */
export const SCROLL_SELECTOR = "div[style*='overflow-y']";

/**
 * Installs a fixture into a document; returns the scroll element.
 * @param {Document} document
 * @param {{body: string}} fixture
 */
export function mountFixture(document, fixture) {
  document.body.innerHTML = fixture.body;
  return document.body.querySelector(SCROLL_SELECTOR);
}