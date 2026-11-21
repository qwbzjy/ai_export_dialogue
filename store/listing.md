# Chrome Web Store 上架材料

直接复制下面各节到开发者后台对应字段。素材文件都在 `store/` 和 `src/icons/`。

## 名称 / 简介

- **名称**：AI 对话导出
- **简介（manifest description，已写入，42 字符）**：把元宝、千问、豆包、DeepSeek、Kimi 的当前对话导出为 Markdown。
- **分类**：生产力工具（Productivity）
- **语言**：中文（简体）

## 详细描述

```
把 AI 聊天记录存成干净的一份 Markdown。

支持 DeepSeek、Kimi、豆包、元宝、Qwen Chat、千问六个站点，一键导出当前正在看的这个对话。

■ 导出的是什么
- 一个自包含的 .md 文件：标题、角色、正文、推理过程（折叠在 <details> 里）、表格、公式（TeX 原样）、代码块（带语言标记）、图片（base64 内嵌）、参考来源。
- 文件名形如「DeepSeek-会话标题-20261121-1530.md」，可直接拖进 Obsidian、Typora、VS Code 等编辑器继续整理。

■ 怎么取的数据
优先调用站点自己的会话接口，拿到的是原生 Markdown，不受虚拟化列表影响，长对话也完整；
接口不可用时（未登录、改版、风控）自动回退到读取页面已渲染的内容，向上滚动补齐历史后按角色和内容去重还原顺序，结果里会注明「提取方式：页面内容」。

■ 两个入口
- 点浏览器工具栏的扩展图标 → 导出当前对话；
- 或者对话页右下角的悬浮按钮（可拖动，位置按站点记忆）。

■ 隐私
所有处理都在你的电脑上完成，没有服务器，不上传任何内容。
登录凭证只在发请求那一刻读取一次、只放在发往该站点的请求头里：不写入导出文件、不做任何持久化。
权限只申请了实际用得到的几项，导出文件由浏览器按默认下载目录保存。

■ 已知限制
- 站点接口未公开，站点改版后可能需要更新插件。
- 页面内容回退路径受虚拟化列表与混淆类名影响，极端情况下可能缺消息。
- 只导出当前会话，不批量导出历史列表。
```

## 图片素材

| 用途 | 文件 | 尺寸 |
| --- | --- | --- |
| 商店图标 | `src/icons/icon128.png` | 128×128 |
| 小宣传图（建议必传） | `store/promo-440x280.png` | 440×280 |
| 截图 1：导出预览页 | `store/screenshot-1-export.png` | 1280×800 |
| 截图 2：弹窗与功能说明 | `store/screenshot-2-popup.png` | 1280×800 |

截图 1 是真实扩展页面在 Chrome 里的截图（不是示意图）；截图 2 由弹窗真实渲染结果合成。

## Privacy 标签页

### Single purpose description

```
把用户在受支持的 AI 对话站点上打开的当前会话，导出成本机上的一个 Markdown 文件。
```

### 权限理由（逐个字段）

- **storage / unlimitedStorage**：导出内容先分片暂存在本机 `chrome.storage.local`，供扩展自己的预览页读取；长对话带多图时体积大，需要 unlimitedStorage。关闭预览页即按精确键删除。
- **scripting / activeTab**：用户点导出后，在**当前标签页**执行导出脚本。不申请 `tabs`，不在后台扫描其他页面。
- **cookies**：部分站点把登录状态放在 Cookie 里。导出时读取该站点的会话 Cookie，只放进发往**该站点自己**接口的请求头，用完即弃，不存储、不外发。
- **host_permissions（站点页）**：六个站点各自的域名及其别名域，用于在该对话页注入导出脚本、调用该站点自己的会话接口。
- **host_permissions（图片 CDN，`*.tencent.com`、`*.aliyuncs.com`、`*.doubao.com`、`*.qwen.ai`、`*.deepseek.com`）**：对话里的图片存放在这些 CDN 上，需要跨域下载后转成 base64 内嵌进 .md。只 GET 图片，不读取其他数据。

> 提示：`https://*.tencent.com/*` 和 `https://*.aliyuncs.com/*` 是较宽的匹配。若审核要求收紧，可改成实测到的具体子域（元宝图片在 `*.yuanbao.tencent.com` 系，千问/豆包图片在具体 OSS 域）。改完重新打包上传即可。

### Remote code

选 **No, I am not using remote code.**（所有 JS 都打包在 zip 内，没有 CDN、没有 eval。）

### 数据使用（Data usage）

「收集的数据类型」**全部不勾选**。依据：Chrome 把「收集」定义为数据离开用户设备；本扩展没有服务端，导出内容只写本机下载目录和本机 `chrome.storage`。

「合规声明」三条全部勾选：
- 不出售或转让用户数据给第三方（经批准的情况除外）；
- 不将数据用于与单一用途无关的目的；
- 不将数据用于判定信用度或用于借贷。

### 隐私政策 URL

`PRIVACY.md` 必须在公网上可访问。最简单：直接用

```
https://github.com/qwbzjy/ai_export_dialogue/blob/main/PRIVACY.md
```

## Distribution 标签页

- 付款：免费。
- 可见性：**公开（Public）**。
- 地区：全部，或只选中国区（如果只想给中文用户）。

## Test instructions（审核要用）

审核员要能真的跑通导出，就必须在受支持站点登录。两条路，选一条填进去：

1. **提供测试账号**（推荐，但请自建一次性账号，不要用你自己的常用账号）：在 DeepSeek 或 Kimi 注册一个空账号 → 开一段对话 → 把邮箱/密码写进 Test instructions。审核只会用于验证功能。
2. **不提供账号**：写明「导出需要用户自己的登录状态；未登录时插件会提示『未登录或登录已失效』。功能可由 code review 核实：API 路径在 `src/sites/*.js`，DOM 回退在 `src/content/extract/collect.js`，导出页在 `src/export/`。」

## 提交前自查

- [ ] `npm run build && npm test && node scripts/verify-render.mjs` 全绿
- [ ] 重新打包：`cd dist && zip -r ../ai-chat-exporter-v0.1.0.zip .`（不要包含 `node_modules`、`.git`）
- [ ] `dist/manifest.json` 里 `version` 已递增（首次提交 0.1.0 即可）
- [ ] 图标 128×128 已放进 zip（`icons/icon128.png`）
- [ ] 至少一张 1280×800 截图
- [ ] 隐私政策 URL 能匿名打开
- [ ] 权限理由逐条填写（见上）
- [ ] 确认图标右下角的原图水印「元宝 / AI生成」可接受，或换成无水印原图重新生成图标

## 审核节奏

- 首次注册开发者账号需支付一次性注册费，并绑定支持 2FA 的 Google 账号。
- 首次发布通常在几天内出结果，也可能到几周；被拒会给出条款条目，按提示改完重新提交即可。
- 新账号默认最多同时发布 2 个扩展。