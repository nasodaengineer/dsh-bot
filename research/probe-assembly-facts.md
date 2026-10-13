# 装配实测：sessions 注入名 / slot 名全集 / HTTP 路由生效路 / api-gateway 命名空间

> 对应 issue #4（P0·实测）。时间：2026-10-14。
> 扫描基线：`E:\data\my-work\dsh\DSH-X\data\versions\0.2.1-alpha.2\node_modules\@deepseek-ai\`（299 包，版本 0.2.1-alpha.2）。
> `D:\app\DSH\` 是打包版桌面外壳（有 start.js，**没有** node_modules/@deepseek-ai 目录，包库不在那里，实测确认）。
> 标注约定：【实测】= 本机文件逐行核对；【推断】= 由机制推导，未跑运行时验证。
> 约束遵守：全程只读，未改动任何已装 profile 或用户目录，未执行安装。

---

## 1. `sessions` 这个 inject 名的真实来源

**一句话：类型里其实有两处声明（此前扫描漏了 `lib/types/client/` 子目录）；宿主侧运行时的 `sessions` 由 `dsh-session` 的 `SessionStore` 通过 Cordis `Service` 基类构造器自我注册；浏览器侧的 `sessions` 是 `dsh-api-session-controller` 客户端半边的 `ISessions` 远程面。同名不同物，两层各自存活。**

| 层 | 声明 | 运行时注册点 |
|---|---|---|
| 宿主（Host ctx） | `dsh-session/lib/types/index.d.ts:28` → `sessions: SessionStore` 【实测】 | `dsh-session/lib/index.js:1737` → `super(ctx, "sessions")`；基类 `cordis/lib/index.js:1770-1783` 的 `Service` 构造器执行 `self.ctx.reflect.provide(name, self, ...)`（:1782），fiber 卸载自动反注册 【实测】 |
| 浏览器（Client ctx） | `dsh-api-session-controller/lib/types/client/index.d.ts:29` → `sessions: import('./contract/sessions.ts').ISessions` 【实测】 | `dsh-api-session-controller/lib/client.js:3835` → `rootCtx.reflect.provide("sessions", this)`（客户端 remote 面，`lib/types/client/sessions/service.js:186` 同型）【实测】 |

- 佐证「宿主拿的是 dsh-session 那份」：`dsh-api-session-controller` 宿主插件的 `static inject` 里就写着 `"sessions"`（`dsh-api-session-controller/lib/index.js:2846`，同文件 `:2449` 的 ArchivedSessionGate 亦然）——API 控制面自己消费的是 dsh-session 的 SessionStore。ds-bot 的 `index.js` 同时 inject `sessions` 与 `sessionController`，正是「内核存储 + 控制面」并存的意思。【实测 + 推断】
- 之前类型扫描没命中 `sessions` 的原因【推断】：扫描只覆盖了 `lib/types/*.d.ts` 顶层，而 `ISessions` 那份声明在 `lib/types/client/` 子目录；`dsh-session` 那份在顶层 `index.d.ts:28`，机械扫描的原始结果 `research/_services-raw.txt` 里其实有它。

**对 dsh-bot 的结论：宿主插件 `inject: ['sessions', ...]` 拿到的是 `SessionStore`（append-only 事件日志 + 派生历史），不是 RPC 面；要控制面就用 `sessionController`。**

## 2. slot 名全集（除已知的 conversation.view / tool.call.toolview / shell.overlay）

**扫描方法【实测】**：全 299 包 `*.d.ts` 中含 `SlotMap` 的 26 个文件，提取声明块内带引号的键。slot 声明是消费方 `declare module` 合并进 `SlotMap`（`dsh-client-ui-slots/lib/types/index.d.ts` 为空接口基座）。按包归类（剔除非键名的类型参数如 kind/owner/scope）：

- **布局壳**（`dsh-client-ui-layout/lib/types/client/index.d.ts`）：`main`、`sidebar`、`rightbar`、`shell.bottom`、`shell.leading`、`shell.overlay`（list，可叠加）
- **对话区**（`dsh-client-ui-conversation/.../contract/slots.d.ts`）：`main.conversation`、`conversation.composer`、`conversation.composer.bar`、`conversation.composer.dock`、`conversation.header`、`conversation.header.leading`、`conversation.hero.agentPreset`、`conversation.hero.brand.mark`、`conversation.hero.workspace`、`conversation.hero.workspace.directoryFlow`（workspace 包）、`conversation.input.activity`、`conversation.input.attachments`、`conversation.input.dock`、`conversation.input.left`、`conversation.input.model`、`conversation.input.overlay`、`conversation.input.permission`、`conversation.input.plan`、`conversation.input.right`、`conversation.session`、`conversation.session.header`、`conversation.session.header.actions`、`conversation.session.header.corner`、`conversation.session.header.lineage`、`conversation.session.header.utilities`、`conversation.view`
- **聊天消息流**（`dsh-client-ui-chat/.../slots.d.ts`）：`conversation.chat.flow`、`conversation.chat.node`、`conversation.chat.turnTail`、`conversation.chat.assistant-actions`、`conversation.chat.commandview`、`conversation.chat.reasoning.body`、`conversation.message.images`、`shell.quota-notice`
- **侧栏**（`dsh-client-ui-sidebar/.../slots.d.ts` + workspace 包）：`sidebar.brand.mark`、`sidebar.brand.name`、`sidebar.footer.action`、`sidebar.panellist`、`sidebar.settings`、`sidebar.toggle.badge`、`sidebar.workspaces`、`sidebar.workspaces.directoryFlow`、`sidebar.workspaces.session.menu.item`、`sidebar.workspaces.session.row.action`、`sidebar.session.row.hover`、`sidebar.session.row.leading`
- **右侧栏**（`dsh-client-ui-sidebar-right/.../slots.d.ts`）：`rightbar.session`、`sidebar.right.pane.tab`、`sidebar.right.pane.tab.title`、`sidebar.right.tab.guide`、`sidebar.right.tab.guide.entry`、`sidebar.right.tab.menu.item`；文档/文件半边的：`sidebar.right.tab.document`、`sidebar.right.tab.document.action(s)`、`sidebar.right.tab.document.unpreviewable`、`sidebar.right.tab.document.office.pdf`、`sidebar.right.tab.files.actions`（documentpreview / sidebar-files 包）
- **工具视图**（`dsh-client-ui-tool` + cordis 包）：`tool.call.toolview`、`tool.call.images`、`tool.view.cordis`
- **插件管理页 —— Bot 详情页最相关**（`dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts`）【实测】：`plugins.item`、`plugins.add.actions`、`plugins.row.config`、`plugins.bundle.config`、`plugins.bundle.activation`、`plugins.detail.actions`、`plugins.detail.badge`、`plugins.detail.section`
- **设置页**（`dsh-client-ui-settings` + settings-models）：`settings.action`、`settings.close`、`settings.general.item`、`settings.header`、`settings.launcher`、`settings.onboarding`、`settings.plugins.tab`、`settings.section`、`settings.trigger`、`settings.models.footer`、`settings.models.provider-card`、`settings.models.sign-in`
- **审批/提问/目标/反馈/轨迹/子代理**：`conversation.approval.detail`（approval）、`conversation.plan-review.actions`（user-questions）、`deliverables.file.actions`、`deliverables.review.file.actions`（deliverables）、`conversation.trajectory.images`（trajectory）、`sidebar.chat.conversation`（subagent 的侧栏聊天）
- 注意【推断】：`dsh-client-ui-goal`、`message-feedback`、`model-selection` 的 slots.d.ts **不声明新 slot**（文件头原话：目标 slot 由 ui-conversation 声明，本包只贡献 entry），它们注入进 `conversation.input.dock` 等既有 slot。

纪律提醒（沿用 boundaries 报告 §B6）：注册进未声明 slot 会 throw；一个 slot 只能有一个声明者。**Bot 详情页挂 UI 用 `plugins.detail.section` / `plugins.detail.actions` / `plugins.detail.badge`。**

## 3. HTTP 路由：`connection.fetch.register` 与 `webServer.register` 哪条生效

**一句话：两条在 web profile 里都真实挂载、都生效，但服务的是不同命名空间——`connection` 独占唯一 `/api` 路由（会话 cookie 认证），`webServer` 拥有其余全部 HTTP 面。ds-bot 走的 `connection.fetch.register` 是对的。**

生效判定依据【实测】：

- `dsh-web-app/cordis.patch.yml:229` → `- id: connection / name: '@deepseek-ai/dsh-client-connection'`；`:179` → `- id: webserver / name: '@deepseek-ai/dsh-host-webserver'`（inject `[webStartup]`，默认 host `127.0.0.1` port `3080`）。web profile 的 bundle 列表含 `@deepseek-ai/dsh-web-app`（见 `research/dsh-plugin-boundaries.md` §1.8 的 profile package.json），两行都会装配。
- 宿主侧 `connection` 的 provide：`dsh-client-connection/lib/client.js:1477` → `ctx.provide("connection", handle)`（`HostConnectionHandle`，类型在 `lib/types/rpc-host.d.ts:9` 与 `rpc.d.ts:149`）。注：`connection` 的宿主半边由该包宿主入口装；浏览器半边同名 provide 在同包 `client.js`（README :32 明说宿主半边"always provides"路由注册表）。
- `webServer` 的 provide：`dsh-host-webserver/lib/index.js:270` → `super(ctx, "webServer")`（同款 Service 机制）。
- **文档原文**（`dsh-client-connection/README.md:32`）【实测引文】："The Host half always provides the carrier-neutral RPC and exact `GET`/`HEAD`/`POST` route registries. **When a Web carrier is present it also owns the sole `/api` route**, Fetch bridge, browser authentication, and Host/Origin checks … Typert Gateway claims generated Remote endpoints, feature packages register non-JSON responses such as Session-log downloads and raw file uploads, and **unclaimed requests return 404**."
- 分工【实测+推断】：`webServer.register`（`dsh-host-webserver/lib/types/index.d.ts:157`，另有 registerUpgrade :164 / registerFallback :173；README.md:39/57 记录 host/port/protocol 语义）适合自管路径、静态资源、WebSocket；`connection.fetch.register` 挂在共享 `/api` 之下、自动获得会话 cookie 认证，适合插件的 JSON RPC 端点（ds-bot 的 `POST /api/bot` 即此路）。

## 4. `dsh-api-gateway` 的 remote 命名空间全集

**一句话：`ctx.remote.<namespace>` 的命名空间由各能力包的生成文件 `lib/typert.remote-client.d.ts` 向 `ClientRemote`（`dsh-api-gateway/lib/types/client/index.d.ts:18`）做 declare module 合并贡献，全库实测共 27 个：**

| namespace | 包 | | namespace | 包 |
|---|---|---|---|---|
| `session` / `fileReferences` / `skills` | dsh-api-session-controller | | `schedule` | dsh-schedule |
| `workspace` / `directoryPicker` | dsh-api-workspace-controller | | `goals` | dsh-goal |
| `workspaceFiles` | dsh-api-workspace-files | | `llm` | dsh-llm |
| `terminal` | dsh-api-terminal-controller | | `commands` | dsh-commands |
| `job` | dsh-api-job-controller | | `subagents` | dsh-subagent |
| `settings` / `credentials` | dsh-api-settings-controller | | `agentPresets` | dsh-agent-preset-registry |
| `account` | dsh-api-account-controller | | `permissionPresets` | dsh-permission-presets |
| `pluginManager` | dsh-plugin-manager | | `userQuestions` | dsh-user-questions |
| `pluginInventory` | dsh-host-plugin-inventory | | `sessionFeedback` | dsh-command-feedback |
| `pluginRegistryProbe` | dsh-client-ui-plugin-manager | | `messageFeedback` | dsh-message-feedback |
| `dynamicCordisRunner` | dsh-cordis-host-runner | | `sessionReferenceResolver` | dsh-session-reference |
| `fileUploads` | dsh-client-file-upload | | `officeToPdf` | dsh-office-to-pdf |
| `productAnalytics` | dsh-client-product-analytics | | `speech` | dsh-experimental-api-speech-to-text |
| `cotTranslation` | dsh-experimental-client-ui-cot-translation | | | |

- 装配口径【实测】：平台中立的聚合面在 `dsh-api-remotes/lib/types/client/index.d.ts`（逐行 `export type {} from '<pkg>/remote'` 引入各贡献；speech / cotTranslation 两个实验性命名空间不在该核心清单里，随实验 bundle 另行装配）。
- `ctx.remote` 的 Context augmentation：`dsh-api-remotes/lib/types/client/index.d.ts:64-68`（`remote: ClientRemote`）。网关侧另有 `$stream` / `$host`（`dsh-api-gateway/lib/types/client/index.d.ts:24,30`）。
- 注意【推断】：命名空间是**客户端（浏览器半边）**的 RPC 面；宿主插件直接 inject 对应服务即可，不需要走 remote。

---

## 验证方式备注

- 全部结论来自对本机文件系统的只读 grep / 逐行读取（工具输出在会话中，本文件即沉淀）；未运行 DSH、未发 HTTP 请求，故「装配后真实可达」属静态推断，标注见各节。
- 版本锚点：所有引用包版本均为 0.2.1-alpha.2（与 `dsh-web-app/package.json` 中 `@deepseek-ai/dsh-host-webserver": "0.2.1-alpha.2"` 互证，DSH 各包共享单一版本）。
