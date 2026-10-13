# dsh-bot 差距分析与路线图

> 本文是 s4 的产物，是三份侦察报告的合成件。
> 上游：[`grok-bot-features.md`](./grok-bot-features.md)（Grok Bot 功能面，15 域 173 条）、[`ds-bot-architecture.md`](./ds-bot-architecture.md)（DS Bot 参考实现，1777 行）、[`dsh-plugin-boundaries.md`](./dsh-plugin-boundaries.md)（DSH 插件边界，能做 23 / 受限 12 / 做不了 8）、[`dsh-plugin-skeleton.md`](./dsh-plugin-skeleton.md)（可照抄的工程骨架）。
> 判定状态：「功能面可归纳」「会话即Bot」「计算机不可复刻」三条判断均已检验，判**支持**。

---

## 0. 一句话结论

**dsh-bot 能把 Grok Bot 十五个能力域里的十二个做到「可用」，两个做到「部分」，一个（云计算机）明确不做；** 而十二个里的六个**不需要新建任何机制**——DSH 本体的 `ctx.agentTeams`、`ctx.schedule`、`ctx.credentials`、`ctx.approval`、`ctx.slots`、`dsh-mcp-client` 已经把骨架搭好了。真正要自己写的是**记忆、人格持久化、群聊投递、模板分发**这四块，它们都没有原生服务。

所以 dsh-bot 的工程量分布是反直觉的：**最像 Grok Bot 的那部分（一支能互相派活的 Bot 团队）最省力，最不像的那部分（每个 Bot 记得住事、有自己的性格、能被打包送给别人）最费力。**

---

## 1. 差距总表（十五域）

难度口径：**S** = 一两天；**M** = 一周量级；**L** = 数周；**X** = 插件边界外。

| # | 能力域 | Grok Bot 有 | DSH 能到什么程度 | 差距性质 | 难度 |
|---|---|---|---|---|---|
| 1 | Bot 本体与人格 | Name/Title/Description 三字段 + 头像/颜色 | `ctx.agentPresets` 的 `register`/`list`/`mount`/`select`，比 Grok 的三字段更强；`ctx.systemPrompt.section` 注入人格 | 工程量 | **S** |
| 2 | 云计算机 | 每 Bot 一块 1920×1200 屏、可回收、云上持久、桌面/iOS 同一台 | **不能**（三条独立证据链）。替代：每 Bot 一个工作空间 + 一个 Desktop 浏览器面板 + 一套自有文件 | **能力缺口（不可补）** | **X** |
| 3 | 浏览器与网页操作 | 登录站点、跨 app 工作、截屏、录视频 | 受限：Desktop 端可用 Electron `<webview>` + 独立 storage partition；**Web 端完全做不到**（iframe 站点拒嵌、跨域读不到） | 能力缺口（平台相关） | **L** |
| 4 | 例程与触发 | 排期 + **监听外部事件**（Slack thread、GitHub PR）+ 右键 Pause/Resume/Test/Edit/Delete | `ctx.schedule` 六种形态（after/at/every/daily/weekly/**cron**）+ `schedule_*` 四个模型工具 | 缺事件触发器 | **M** |
| 5 | 记忆 | 跨会话保持、Bot 之间互相学习、Library tab | **无原生服务**（129 个服务名里没有 `ctx.memory`）。只有构件：`systemPrompt.section` + `tools.register` + 自选存储 | **机制缺口** | **L** |
| 6 | 权限与审批 | 自然语言规则 + 独立 reviewer agent + allow/block 列表；Ask first / Always allow 粒度到「该 Bot」或「所有 Team Bot」 | `ctx.approval`（`request`/`setPolicy`/`overrideOf`）+ `permissionPresets` 三档 + `dsh-experimental-auto-review` | 缺 Bot 级粒度 | **M** |
| 7 | 连接器与凭据 | Connectors 一键授权、每服务多账号 | `ctx.credentials`（`resolve`/`describe`/`set`/`listRecords`/`modifyRecord`）+ `dsh-mcp-client`；**比 DS Bot 自建的 `secrets.json` 规范得多** | 基本无差距 | **M** |
| 8 | 技能与插件 | 同 Cursor 的 MCP servers / plugins / skills | `ctx.skills` + `ctx.commands` + `ctx.tools` + `dsh-mcp-client` | 基本无差距 | **S** |
| 9 | 模板与团队分发 | Share as Template 打包 skills+memories+plugins；Team Bots 一键发布给全团队 | 插件分发有 `pluginManager.installBundle`；**「人格 + 记忆 + 技能」打包没有格式** | **机制缺口** | **L** |
| 10 | 多 Bot 协作 | 互相发消息、群聊自主协调、交接所有权、只在需要判断时拉人 | **原生强项**：`ctx.agentTeams`（`spawnTeammate`/`sendMessage`/任务板 DAG/`waitForChange`/`interrupt`）+ 九个模型工具 + Web 面板 | **无差距，甚至有优势** | **M** |
| 11 | 项目与任务编排 | Project（会规划工作、跑自己 agents 的 Cloud Agent） | `agentTeams` 任务板 + `ctx.workflowEngine` + `ctx.goals` + `ctx.subagents` | 无差距 | **M** |
| 12 | 多渠道触达 | desktop / iOS / **Slack** / 邮件 | 自建 HTTP 端点（`connection.fetch.register` / `webServer.register`）+ Web 面板；**Slack 与邮件要自己接，DSH 无渠道抽象** | 机制缺口 | **L** |
| 13 | 交付物形态 | slide decks、格式化邮件、pages | **DSH 更强**：`dsh-office-to-pdf`（LibreOfficeKit 预编译引擎）+ `sidebar-documentpreview` + `dsh-tool-present` | 无差距，有优势 | **S** |
| 14 | 治理、用量与企业能力 | 账户级配额、Audit Logs、Action Recording、Team Secrets、SSO | 只有**会话级**用量（`ctx.tokenMeter` + `sessionStats` 投影）。账户级配额、审计导出、企业 SSO 在插件边界内**没有 API** | 分层：会话级是工程量，账户级是能力缺口 | **M**（会话级）/ **X**（账户级） |
| 15 | 客户端界面 | 侧栏、Bot 详情页、Marketplace、状态短语 | `ctx.slots`（`conversation.view` / `tool.call.toolview` / `shell.overlay`）+ `sidebarRight.openTab` + `locale.register` | 工程量 | **M** |

**汇总**：**无差距或有优势 5 域**（7 连接器与凭据 · 8 技能与插件 · 10 多 Bot 协作 · 11 项目与任务编排 · 13 交付物形态）· **纯工程量 2 域**（1 Bot 本体与人格 · 15 客户端界面）· **机制缺口 4 域**（5 记忆 · 6 权限的 Bot 级粒度 · 9 模板分发 · 12 多渠道触达）· **能力缺口 3 域**（2 云计算机 · 3 Web 端浏览器 · 14 治理的账户级部分）· 4 例程为工程量与机制缺口的混合（时间调度是工程量，事件触发器是机制缺口）。

三类之间的界线不是难度，是**投入能不能换来结果**：工程量缺口投入就有，机制缺口投入要**先设计**，能力缺口投入再多也只能得到一个绕过边界的脆实现。

---

## 2. 三类差距，三种应对

### 2.1 能力缺口（2、3、14）——不做，或换个定义做

这三域**不是「还没写」，是「DSH 没建模」**。区别很重要：前者靠投入能补，后者投入再多也补不上，只会得到一个绕过边界的脆实现。

- **云计算机**：已判**支持不可复刻**。三条证据链见 `dsh-plugin-boundaries.md` §4.1。`ctx.computerUse` 是**独占名额的注册表**（第二次注册即使同名也失败），README 原文是「共享桌面」「模型不能在运行时切换已注册的驱动」——与「每 Bot 一块屏、可回收」语义正好相反。
- **浏览器**：Web 端做不到是硬边界。Desktop 端 ds-bot 已实证可行，代价是页面活在 app 窗口里、宿主读页面要走客户端长轮询通道、`MAX_LIVE = 6`。
- **治理与用量**：`ctx.tokenMeter` 是会话级的，没有账户级配额或计费 API。要做「每个 Bot 花了多少」只能自己扫会话日志（ds-bot 用 `usage.sqlite` 扫日志 + 流式拦截补齐）。

**应对**：把「云计算机」重新定义为**「每个 Bot 一个工作空间 + 一个浏览器面板 + 一套自有文件」**，把价值重心（团队 + 共享计算资源 + 例程）复刻出来，「云端多租户持久桌面」这一层明确不做。治理域降级为「会话级用量面板」，账户级与企业级**留白并写进 README 的限制章节**。

### 2.2 机制缺口（5、9、12）——自建，且这是主要工作量

这三域 DSH 给的是**构件不是成品**：

- **记忆**：129 个服务名里没有 `ctx.memory`。要自己定目录布局、注入时机、检索方式。DS Bot 的 Agent Memory Repo 格式（`MEMORY.md` + 主题文件 + `journal.jsonl` + snapshots）是可借鉴的完整方案。
- **模板分发**：`pluginManager.installBundle(spec, options)` 只解决**插件**的分发。Grok Bot 的模板是「skills + memories + plugins」三件套，其中 memories 与人格是我们自己定义的数据，**没有现成格式**。
- **多渠道**：`connection.fetch.register` 与 `webServer.register` 能开出端点，但 DSH 没有「渠道」抽象。接 Slack 意味着自己处理 OAuth、事件订阅、thread 映射、审批卡渲染。

**应对**：这三块**必须放在路线图的中后段**，因为它们的形状取决于前面定下来的状态模型。特别是记忆——它和「Bot 是不是一个 root Session」这个决策强耦合。

### 2.3 工程量缺口（1、15、4 的一半）——照抄骨架，快

`dsh-plugin-skeleton.md` 已经把 `dsh-mmaping` 这个同构原生插件的形状抄下来了：`package.json` 的 `dsh.bundle.patch` + `dsh.client.inject`、`cordis.patch.yml` 的 `insert` 两行、host 入口的 `name`/`inject`/`apply` 三件套、`ToolDefinition` 契约、client 入口的两个 slot、**以及最重要的类型策略**——

> The bundle never imports `@deepseek-ai/*` client packages: the loader's module table provides the services at runtime, and every interface here is the exact slice those packages document. Keeping the types local avoids a peer-version coupling on a moving pre-stable API while the runtime contract stays the shipped one.

打包用 tsdown 两个 target：host 走 `esm`/`node`，client 走 `cjs`/`browser` + 手写模块协议（`window.__ModuleLoader__.load({id, factory})` 包住、`react`/`react-dom`/`@deepseek-ai/cordis` 从 module table require、其余全部内联）。

---

## 3. 路线图

分五段。每段末尾给了**可核对的验收**——不是「功能做完」，是「跑一条命令能看到什么」。

### P0 · 地基（先把「一个 Bot」立起来）

**做**：
1. 建插件工程：`package.json`（`type: module` / `main: lib/index.js` / `dsh.bundle.patch` / `dsh.client.inject` / `exports` 含 `./client`）+ `cordis.patch.yml` + `tsdown.config.ts` 两个 target。
2. host 入口：`export const name = 'dsh-bot'`；`export const inject = [...]`；`export function apply(ctx)`。**inject 里先只放真正用到的**——DS Bot 一次性 inject 了 8 个服务，其中 `sessions` 这个名在类型扫描里根本没命中，是个隐患。
3. 状态层：`$DSH_HOME/bot/state.json` 单文件 + 并发保护。**这一步直接借 DS Bot 的形**（`store.js` 的 temp → ensureLock → rename 写入模式）。
4. Bot 名册：**用 `ctx.agentPresets` 而不是自建 roster**。`register(definition)` / `list()` / `mount(ctx, id)` / `select(agent, id)` 是官方原语，比 DS Bot 的 `state.json` 名册更规范。
5. 人格注入：`ctx.systemPrompt.section(...)` 把 Name/Title/Description 拼成提示词段。

**关键决策（必须先定）**：**选边——原生 Agent Teams 还是自建 roster。** s2 §5 的结论是**分层混合**：名册与生命周期用原生 `ctx.agentTeams`，而「Bot 的持久身份」（名字、颜色、人格、记忆路径）用自己的状态文件，因为原生 roster **扁平且不可变**（无重命名、无删除、名字不复用）。

**验收**：装进 web profile，侧栏出现一个 Bot；给它改名后重启 dsh，名字还在；它的系统提示词里能看到自己的 Title。

### P1 · 单 Bot 可用（让它真的能干活）

**做**：
1. 模型选择：`ctx.agentDefaultModel` + `ctx.llm.listModels/listProviders` + `ctx.sessionController.selectModel`，选择随 Session 持久。
2. 工具集：`ctx.tools.register` 注册 Bot 专属工具；`dsh-mcp-client` 接 MCP 连接器（**一个实例只连一个 server**，`serverName` 全局唯一且决定工具公开名 `mcp__<serverName>__<rawName>`）。
3. 凭据：`ctx.credentials` 的 `resolve`/`describe`/`set`/`listRecords`。**不要学 DS Bot 自建 `secrets.json`**——DSH 原生的两个键空间（`CredentialRef` 是 POSIX shell 标识符，`CredentialKey` 是 `<scope>/<id>`）已经处理好了注入与作用域。
4. 审批：`ctx.approval.request` + `permissionPresets` 三档。**注意 fail-closed**：策略 `'ask'` 且无 answerer 时结果是 `'unavailable'`。
5. 例程：`ctx.schedule.create(sessionId, request)` 六种形态。**注意 B4 限制**：绑定到「被委派子代理拥有的 Session」会被拒（错误码 `subagent_session`），所以 Bot 的定时任务**必须挂在 root Session 上**。

**验收**：给 Bot 排一个 cron 例程，到点它自己跑完并把结果留在会话里；中途需要读一个受保护文件时弹出审批卡。

### P2 · 团队与协作（这是原生强项，尽快做）

**做**：
1. 用 `ctx.agentTeams` 起队友：`spawnTeammate(caller, {name, description, prompt, context: 'fresh'|'fork', provider})`。**每个方法都要求传确切的 live 调用方 Agent 作为权限凭据**——这是原生 API 的安全模型，别想绕。
2. 任务板：`createTask`/`listTasks`/`updateTask`/`waitForChange`，依赖全完成才可 claim，`writeScopes` 是文件提示（**只是提示**，Bash 与 formatter 能绕过）。
3. 群聊：这是**唯一必须自建的协作机制**。DSH 原生**没有「多 Bot 同一会话」**——`TeamId === SessionId`，一个 Session 一个 Agent。DS Bot 的方案是「每个群聊一个 root Session + 宿主侧投递 + 自建 HTTP 端点」。
   - **必须自己接管 `approval/request`**：群聊 Session 是隐藏的，DSH 的审批卡在那里**永远不出现**，turn 会一直等（B5）。
   - 群聊 Session 不让模型决策、在 `llm/stream` 上伪造工具调用（DS Bot `groups.js:652-655` 的做法）**过于激进，不学**。
4. 客户端：`ctx.slots.inject('conversation.view', ...)` 加团队面板；`ctx.sidebarRight.openTab` 开 Bot 详情页；`locale.register` 双语。

**验收**：一个 Lead Bot 起两个队友，给它们派一个带依赖的任务；第二个队友等第一个完成才 claim；期间它们的往来在同一个群聊视图里可见；需要审批时卡片出现在群聊里而不是消失。

### P3 · 记忆、模板与外部触达（主要工作量在这里）

**做**：
1. **记忆**（最大的一块）：定目录布局 + 注入时机 + 检索。建议借 DS Bot 的 Agent Memory Repo 格式（`MEMORY.md` 索引 + 主题文件 + `journal.jsonl` 追加日志 + snapshots），但**存储换成 `ctx.storage`**（KV hub，`registry.register(name, backend)`）而不是裸文件。
2. **模板分发**：定义「人格 + 记忆 + 技能」的打包格式。插件部分复用 `pluginManager.installBundle`。**注意 Grok Bot 模板的一条关键事实**：非标准插件（MCP servers、脚本、代码）**不包含在模板里**——这条限制是合理的，照搬。
3. **外部触达**：先做**自建 HTTP 端点**（`connection.fetch.register({path, methods, requestBody, fetch})`，挂在共享 `/api` 通道、用会话 cookie 认证），把 Bot 暴露成一个可被外部调用的接口。Slack / 邮件**放到最后，且当作独立项目**。
4. **交付物**：接 `dsh-office-to-pdf` + `dsh-tool-present`，这是 DSH 少有的**强于 Grok Bot**的地方，早点用上。

**验收**：Bot 重启后记得上一轮对话里定下的偏好；把一个 Bot 导出成模板文件再导入，人格与技能都在、记忆按选择带或不带；用 curl 打自建端点能触发一次 Bot 运行。

### P4 · 留白（明确不做）

- 云计算机 / 云端多租户远程桌面 —— **不做**，写进 README 的限制章节并说明替代方案。
- 账户级配额、Audit Logs、企业 SSO —— **不做**，超出插件边界。
- Web 端的浏览器操作 —— **不做**，只做 Desktop。
- 事件触发器（监听 GitHub PR / Slack thread）—— **暂不做**。`ctx.schedule` 只给时间不给事件；要做需要自己轮询，成本和收益不成比例。

---

## 4. 五个需要人裁决的决策点

这些**不该由我替你定**，因为答案取决于你想拿 dsh-bot 干什么：

| # | 决策 | 选项 A | 选项 B | 我的倾向 |
|---|---|---|---|---|
| 1 | 团队基座 | 用原生 `ctx.agentTeams` | 学 DS Bot 自建 roster | **A**（分层混合：原生管生命周期，自有状态管持久身份） |
| 2 | Bot 的状态放哪 | `$DSH_HOME/bot/state.json` 单文件（DS Bot 路线） | `ctx.storage` KV hub | **B**（A 在并发与迁移上迟早要还债） |
| 3 | 群聊怎么做 | 一个群聊一个隐藏 root Session + 自建投递（DS Bot 路线） | 用原生团队消息，不造群聊 Session | **A 但简化**（必须自己接管审批，但不学伪造工具调用） |
| 4 | 浏览器做不做 | Desktop-only Electron `<webview>` | 完全不做 | 取决于你是否只用 Desktop |
| 5 | 外部触达做到哪 | 只做 HTTP 端点 | 端点 + Slack + 邮件 | **先只做端点**（Slack 是独立项目） |

---

## 5. 与 DS Bot 的关系：借鉴什么，不借鉴什么

`.refs/DeepSeek-Bot` 是**参考**不是**对标对象**（对标的是 Grok Bot）。它的价值与风险都很具体：

**借鉴**：
- `store.js` 的单文件状态 + 并发保护模式（`home-lock.js`）
- `memory.js` 的 Agent Memory Repo 目录布局与「可回溯」设计
- `parts.js` 的「一次小模型决策 + 两种执行」分片机制
- `usage.js` 的两条计量来源 + 一个归属规则
- `test/` 的工程实践：fake-ctx、harness-resolve、mock 模型（`dev/mock-llm.mjs`，**测试不需要 API key**）、`check.sh` 六步、CI 四矩阵
- **客户端 bundle 的依赖白名单被测试钉死**（`test/client-bundle.test.js:26-33` 用假 require 断言集合精确相等）——这条纪律值得直接抄

**不借鉴**：
- **自建 roster 与自建 secrets**——DSH 原生的 `agentPresets` 与 `credentials` 更好
- **群聊 Session 伪造工具调用**（`groups.js:652-655`）——为了一个 UI 效果去骗模型，代价与风险都不对等
- **一次性 inject 8 个服务**——`sessions` 这个名在类型扫描里没命中，是隐患
- **完全绕开原生 Agent Teams**——它明明存在且更规范

**一条硬事实**：DS Bot 全仓库对 `experimental` 的唯一命中是语音输入插件，它对 DSH 原生 Agent Teams **零引用**，是**刻意绕开重造**。dsh-bot 必须**先选边，不能两边都沾**——这是 P0 的第一件事。

---

## 6. 工程纪律（从两个参考实现里提炼的硬约束）

1. **Plugin only**：绝不 patch DSH，绝不依赖 DSH 安装目录内的文件。DSH 缺东西就停下来说。
2. **不碰用户数据**：测试台数据放 `.dsh-test-<name>/`，绝不指向 `~/.dsh`。
3. **客户端不 import `@deepseek-ai/*`**：把用到的服务切片手写成本地 interface（`dsh-mmaping/src/client/types.ts` 头注释的策略）。这条规避 pre-stable API 的版本耦合。
4. **一切路径锚在会话 cwd**：`agent.session?.header?.cwd`，**不用 `process.cwd()`**——dsh 进程可能从任何目录启动（DSH-X 从 `~/.dsh` 启动）。
5. **`agent/created` 里的注入必须包 try/catch**，失败只 `ctx.logger?.warn(...)`，绝不破坏会话启动。
6. **client.js 是生成物**：改源码、跑 build、两个文件都提交、绝不手改。
7. **声明写错 → fiber FAILED，UI 完全不出现**（`dsh-client-modules/index.d.ts:74-76`）——`dsh.client.inject` 与 slot 名写错不会报编译错，只会静默不出现。

---

## 7. 尚未确定的事项

诚实列出**还不知道**的，它们会影响路线图：

1. **`sessions` 这个 inject 名对应哪个包**——类型扫描里没命中，但 DS Bot 同时 inject 了 `sessions` 与 `sessionController`，说明实际装配里两者并存。P0 必须实测清楚。
2. **除 `conversation.view` / `tool.call.toolview` / `shell.overlay` 外还有哪些 slot 名**——只确认了三个，Bot 详情页可能需要别的。
3. **`dsh-api-gateway` 的 remote 命名空间全集**——只确认了 `remote.workspaceFiles`。
4. **插件如何注册 HTTP 路由**——`connection.fetch.register` 与 `webServer.register` 两条路都看到了签名，但没有实测过哪条在 web profile 里真正生效。
5. **原生 Agent Teams 与自建状态的具体接缝**——分层混合是方向，但「原生 roster 不可重命名/不可删除」这个限制到底有多疼，要写完 P0 才知道。

前四条在 P0/P1 阶段会被实测掉；第五条是 P0 的主要产出。
