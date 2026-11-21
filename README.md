# AI 对话导出

一个 Chrome 扩展（Manifest V3），把 **元宝、千问、豆包、DeepSeek、Kimi** 的当前对话导出为 Markdown。

导出的文件是一个自包含的 `.md`：角色标题、推理过程（`<details>` 折叠）、表格、行内/块级公式（TeX 原样）、代码块（带语言标记）、图片（base64 内嵌）、参考来源。文件名 `{站点}-{标题}-{时间}.md`。

## 安装

```bash
npm install
npm run build        # 产物在 dist/
```

打开 `chrome://extensions` → 右上角打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `dist/` 目录。

## 使用

两个入口，功能一致：

1. 打开支持站点的某个对话页，点扩展图标 → 「导出当前对话（Markdown）」。
2. 对话页右下角的**悬浮按钮**（可拖动，位置按站点记忆）→ 「导出 Markdown」。

「仅用页面内容导出」跳过站点接口，直接抓页面已渲染的内容，用于接口改版或未登录时的兜底。

导出会打开扩展自己的预览页，显示的就是 `.md` 原文（与下载的文件逐字一致），并立即开始下载；页面上有「下载 Markdown」和「复制 Markdown」两个按钮。关闭该标签页后，临时数据自动清除。

## 支持范围

| 站点 | 域名 |
| --- | --- |
| DeepSeek | `chat.deepseek.com` |
| Kimi | `www.kimi.com`、`kimi.com`、`kimi.moonshot.cn` |
| 豆包 | `www.doubao.com`、`doubao.com` |
| 元宝 | `yuanbao.tencent.com` |
| Qwen Chat | `chat.qwen.ai` |
| 千问 | `www.qianwen.com`、`qianwen.com`、`qianwen.aliyun.com`、`tongyi.aliyun.com` |

导出的是**当前会话**。生成中的回答会拒绝导出并提示稍后重试。

## 上架素材

- 扩展图标：`src/icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png`（构建时拷到 `dist/icons/`）。
- Chrome Web Store 商品页宣传图：`store/promo-440x280.png`。
- 隐私政策：`PRIVACY.md`，需发布到公网后填进商店后台。
- 上传包：`npm run build && cd dist && zip -r ../ai-chat-exporter-v0.1.0.zip .`

## 隐私

- 所有内容只留在本机。扩展不上传任何数据，没有远程服务端。
- 接口路径需要登录凭证时，token 只在请求头里即时读取并使用；**不写入导出文件、不存进 `chrome.storage`、不做任何持久化**。
- 导出数据临时存放在 `chrome.storage.local`（分片存储，键前缀 `exp:`），关闭导出标签页时按精确键删除；扩展启动时另有一次孤儿数据清理。
- 导出页是 `chrome-extension://` 特权页面，按「内容皆不可信」处理：`.md` 原文用 `textContent` 写入 `<pre>`，没有任何 HTML 渲染；DOM 路径先清洗（移除脚本、事件属性、`javascript:` 链接）再转 Markdown。
- 权限只有 `storage`、`unlimitedStorage`、`scripting`、`activeTab`、`cookies`，外加各站点域名。没有 `tabs`、`downloads`、`debugger`，也没有 `web_accessible_resources`。

## 工作方式

**优先走站点自己的会话接口**：一次返回完整历史，不受虚拟化列表影响，原始 Markdown 也不需要 HTML 转换。接口不可用（未登录、改版、风控、Cookie 被拦）时自动回退到 **DOM 抓取**：向上滚动加载全文，按「角色 + 文本哈希」去重，再用新批次前插还原时间顺序，结果里会标注「提取方式：页面内容」。

分片写 storage 而不是走 `chrome.runtime.sendMessage`：后者单条消息上限 64 MiB 且序列化会翻倍内存，带多图的长对话必然超限。

### 已知限制

- 站点接口未公开，改版就需要单点修复。豆包接口的参数含一次性风控字段，属「尽力而为」路径，DOM 回退是预期路径。
- DOM 回退受虚拟化与混淆类名影响，极端情况下可能缺消息。页面在后台标签页时内容可能不完整（会给出提示）。
- 超长对话 + 多图会明显增大体积与耗时；图片单张缩到最宽 1600px，总量超过约 60MB 后改为保留原链接。
- 推理过程保存在 `<details>` 里，默认折叠；在 Obsidian、VS Code、GitHub 等支持 HTML 的 Markdown 环境里可展开，纯文本编辑器里会显示为标签加正文。
- 不含 PDF 导出。需要 PDF 时，用任意 Markdown 工具（如 Typora、VS Code、Obsidian 的导出插件）转一次即可。

## 开发

```bash
npm run dev          # esbuild watch
npm test             # 单元测试（33 项，jsdom）
npm run verify       # 真实 Chromium 端到端校验（见下）
```

### `npm run verify`

用 headless Chrome 真实加载 `dist/`，打开 `chrome-extension://` 导出页，写入一份样例导出，然后断言：Markdown 文本（标题、角色、`<details>`、表格、代码围栏、公式、来源、提示）、工具栏与状态文案、下载按钮产出的 Blob（类型 `text/markdown`，内容与预览逐字一致）、复制按钮不抛错、以及页面样式在 MV3 CSP 下正常加载。产物写到 `test/output/sample.md`。

一个必须知道的环境坑：Chrome 137+ **静默忽略** `--load-extension`。脚本改用 `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked`（启动命令里不带旧 flag），拿到真实扩展 id。

### 目录

```
src/
  manifest.json
  background.js          # 无状态路由 + 跨域 fetch 代理 + 导出数据清理
  content/
    main.js              # 站点识别、SPA 路由监听、导出流程
    ui.js                # 悬浮按钮（Shadow DOM，可拖动）
    extract/             # api / collect(DOM 回退) / convert / sanitize / image / pack
  sites/                 # deepseek / kimi / doubao / yuanbao / qwen / qianwen
  export/
    export.html/.js      # 预览页：<pre> 原文 + 下载 / 复制
    markdown.js          # 统一数据 → .md（唯一产出文件文本的地方）
    html-to-md.js        # Turndown + GFM（仅 DOM 路径）
    storage.js           # 按批读回分片导出
  popup/                 # 扩展弹窗
  util/                  # 文件名清洗、storage 键布局
build.mjs                # esbuild 打包 + 静态文件拷贝
test/                    # run.mjs（单元测试）、dom-fixtures.js（各站页面夹具）
scripts/verify-render.mjs
```