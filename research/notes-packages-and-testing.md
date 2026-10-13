# 第 6 / 7 / 8 节素材：DSH 原生包、Agent Teams 对照、测试与工程实践

> 对象：`.refs/DeepSeek-Bot/`（只读）。路径一律相对该目录。
> 这三节是 `ds-bot-architecture.md` 目前**完全没有覆盖**的部分：全量 grep 显示 `research/` 下所有文件对 `smoke.mjs` / `mock-llm` / `dev/` 的命中数都是 **0**。
> 每条结论后附源码路径。行号取自实测。

---

## 6. 用了哪些 DSH 原生包

### 6.1 宿主侧静态 import（全表，逐个 grep 实测）

| 包 | 引入的文件:行 | 引了什么 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh-tools` | `src/host/browser.js:6`、`groups.js:19`、`memory.js:28`、`secrets.js:8`、`tools.js:4` | `defineTool` | 注册模型可见工具的唯一途径。25 个工具全部经它声明 |
| `@deepseek-ai/dsh-llm` | `src/host/channel.js:3`、`delivery.js:3`、`groups.js:18`、`parts.js:18`、`time-context.js:1` | `createUserMessage` | 构造要投递进 Session 的 user message。投递、群回合、时间上下文、检查点都走它 |
| `@deepseek-ai/dsh-llm` | `src/host/images.js:7`、`memory.js:27`、`parts.js:18` | `BlockAssembler` | 把流式响应块拼回完整答复。记忆复盘、摘要、读图、检查点这些**插件自己发起的**模型调用都用它 |
| `@deepseek-ai/dsh-web` | `web-search.js:11` | `WebError` | 只在 `auto` 搜索 provider 里用，与 Bot 团队代码无关 |

宿主侧**只有这三个包**是静态 import。没有第四个。

### 6.2 动态引用：以字符串存在的 DSH 包

这几处不写 `import`，而是运行时经 `ctx.get('loader').import(...)` 或 `import.meta.resolve` 取：

| 包 | 位置 | 为什么是动态的 |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` | `src/host/capabilities.js:3`（常量）、`:243`（`loader.import(MCP_CLIENT)`）；`src/host/connectors.js:14`、`:84` | MCP 是可选能力。DSH 若没装这个包，能力库与连接器降级，而不是整个插件起不来。`capabilities.js:243` 在 loader 不可用时抛 `This DSH cannot load MCP servers.` |
| `@deepseek-ai/dsh-app-boot` | `src/host/dsh-update.js:19`（常量 `APP_BOOT`）、`:42-49` | 用来问「正在跑我们的 DSH 是哪个版本」。拿不到就退化成从 `process.argv[1]` 往上找最近的 `@deepseek-ai/*` 包目录读 `package.json`（`dsh-update.js:50-60`） |
| `@deepseek-ai/dsh` | `src/host/dsh-update.js:20`（常量 `DSH_PACKAGE`） | DSH 本体更新时比对的包名 |
| `@deepseek-ai/dsh-llm` | `src/host/diagnostics.js:103`、`:107` | 用 `import.meta.resolve('@deepseek-ai/dsh-llm')` 定位 DSH 安装目录，再往上找同名 `package.json` 取版本号——**DSH 的所有包共享一个版本**，所以随便哪个都能代表 DSH 版本（注释原文：「DSH packages share one version; the LLM package is always beside the plugin.」） |

### 6.3 客户端侧：只允许三个平台模块

客户端源码里对 `@deepseek-ai/*` 的引用只有两处形态：

| 形态 | 位置 | 引了什么 |
|---|---|---|
| 静态 import | `src/client/cells.js:3` | `MarkdownText` |
| 静态 import | `src/client/new-chat.js:2`、`palette.js:2`、`sidebar.js:3` | `FishLogo` |
| 命名空间 import | `src/client/user-message.js:2` | `import * as ui`，用到 `ui.projectUserText`、`ui.fileExtension`、`ui.fileSizeText`、`ui.FileTypeIcon`、`ui.JsonBlock`（`user-message.js:15,55,65,67,95`），全部带 `?.` 或 `typeof === 'function'` 兜底 |
| 纯字符串常量 | `src/client/speech.js:4` | `export const VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'` —— DSH 的本地 SenseVoice 语音输入插件，用于探测它是否装上 |

**整个客户端只 require 三个平台模块**：`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`。这一条不是约定，是被测试钉死的：

- 打包器把它们列为 external（`scripts/build-client.mjs`，`PLATFORM_MODULES = ['react','react-dom','@deepseek-ai/dsh-client-ui-primitives']`）；
- `test/client-bundle.test.js` 用一个**只认这三个键**的假 require 跑打包产物，断言 `requested` 去重排序后恰好等于这三个（`test/client-bundle.test.js:26-33`）。任何新增的客户端 DSH 依赖都会让这个测试红。

产物里实测到的 require 语句只有 `require("react")`、`require("react-dom")`、`require("@deepseek-ai/dsh-client-ui-primitives")` 三种（`client.js` 内 `require(` 去重）。

### 6.4 peerDependencies 与一处刻意的缺席

`package.json` 声明了四个 peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-web`，版本都是 `*`（放宽到任意版本，因为 DSH 的版本由用户的 profile 决定）。

**但 `@deepseek-ai/cordis` 在整个仓库里一次都没有被 import**（对 `index.js`、`web-search.js`、`src/host/*.js`、`src/client/*.js`、`src/shared/*.js`、`test/*`、`dev/*.mjs`、`scripts/*.mjs` 全量 grep `cordis` 的结果为空）。它只作为 peer 存在，因为插件的 `apply(ctx)` 形态、`export const inject`、`ctx.on/ctx.effect/ctx.tools.register` 这套 API 是 Cordis 提供的——类型上的依赖，不是 import 上的依赖。

### 6.5 结论

DS Bot 对 DSH 的依赖面**窄得反常**：宿主三个包、客户端一个包。它没有用 DSH 的：
- subagent / agentTeams 服务（见第 7 节）；
- 任何 `dsh-client-ui-*` 的组件库（除了 primitives 里的两个组件 + 一批可选函数）；
- 任何 DSH 的持久化 / 会话查询包（团队状态全在自己写的 `store.js` 里）。

换来的是：插件只依赖 DSH 最稳定的那层（工具、LLM 消息原语、流式块拼装），其余全部自建。代价见第 5 节的「疑点」。

---

## 7. 与 DSH 原生 Agent Teams 的关系

### 7.1 DSH 本体已有的四件套（实测位置与版本）

位于 DSH 安装目录 `node_modules/@deepseek-ai/` 下，版本统一 `0.2.1-alpha.2`：

| 包 | 描述 | 关键内容 |
|---|---|---|
| `dsh-experimental-agent-team` | *Implicit-root Agent Teams roster, direct peer messaging, and shared task DAG* | 暴露 `ctx.agentTeams`（`TeamService`）。方法：`membership` / `listMembers` / `spawnTeammate` / `sendMessage` / `createTask` / `getTask` / `listTasks` / `updateTask` / `waitForChange` / `interrupt` / `tryMembership`。peer 依赖 `dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-session-persistence`、`dsh-session-projection`、`dsh-subagent` |
| `dsh-experimental-tool-agent-team` | *Scoped model-facing Agent Teams tools over ctx.agentTeams* | 九个模型可见工具（创建 teammate / 发消息 / 看状态 / 等进展 / 中断 / 任务板）。README 明确它**取代**同名的旧版 subagent 控件 |
| `dsh-experimental-client-ui-agent-team` | *Web Agent Teams roster, task board, and teammate navigation* | 纯浏览器投影：从共享 Session store 读 Lead Session 的 `agentTeam` 投影。`dsh.client.inject` 列了五个 `dsh-client-ui-*` / `dsh-api-*` 包，`platform: web` |
| `dsh-experimental-agent-team-profile` | *Agent Teams collaboration, tools, and Web UI in one experimental bundle* | 组合包。`dsh.bundle.patch = ./cordis.patch.yml`，patch 内容：`disabled: true` 掉 `tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork` 四个条目，再 insert `agent-team` / `tool-agent-team` / `ui-agent-team` 三条 |

`agent-team` 的配置项与默认值（`dsh-experimental-agent-team/README.zh.md:47-54`）：

| 配置 | 默认 | 含义 |
|---|---|---|
| `maxMembers` | `16` | 一支团队最多创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `disposalTimeoutMs` | `5,000` | 关闭清理允许的时间 |

组合包的 patch 里 `agent-team` 实际给的是 `maxMembers: 8`（比默认更小），`freshProvider: spawn`、`forkProvider: fork`。

组合包 README 的原话：**「本包随 dsh 安装提供，默认关闭，可在插件页开启或添加到已初始化的 profile。」** 也就是 opt-in，没有任何 shipped profile 默认打开它。

### 7.2 证据：DS Bot 对四件套零引用

对 `.refs/DeepSeek-Bot/ds-bot/` 全量 grep `agentTeams|agent-team|teammate|subagent`，排除 `client.js`（812,835 B 的生成物）：

- `src/client/at-menu.js:56` —— `row.origin !== 'subagent'`，把 **DSH 自己的 subagent Session** 从「引用一个对话」的候选里滤掉；
- `src/host/parts.js:180` —— 注释说「除挂载点外每个 Session（subagent 也算）都有自己的压缩后端」；
- `src/host/prompt.js:13` —— 提示词里的一句 `Chat like a teammate texting`，是修辞不是 API；
- `src/host/usage.js:323-329` —— 处理 **DSH 原生 subagent Session 的用量归属**：`item.origin !== 'subagent'` 时按普通 Session 算，否则记 `{ kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }`（注释：DSH 只能通过父的地址读子 Session）；
- `test/at-menu.test.js:42`、`test/usage.test.js:50,79,87,94,95,203-215` —— 上面两处的测试。

`index.js`、`web-search.js`、`package.json`、`cordis.patch.yml` 对这四个词**零命中**。`CHANGELOG.md:85` 的唯一命中是「Usage 页现在也统计 subagent Session 的调用」。

**结论：DS Bot 既不 import 也不挂载四件套中的任何一个包。**

### 7.3 两条路线逐项对照

| 维度 | DSH 原生 Agent Teams | DS Bot |
|---|---|---|
| 成员身份 | `TeamId === SessionId`，每个普通 runtime root **隐式**是 Team 的 Lead | Bot id 就是它第一篇 Session 的 id（`store.js:290-294`），显式建记录 |
| 成员创建 | `spawnTeammate()`：先 append + flush 一条 `provisioning` 成员记录，再让 provider 建 child | `roster.js:createBot`：先 `createSession()` 拿到 Session id，再以它为键写 `state.bots[id]`；失败回滚（删记录 + archive Session） |
| 状态存放 | DSH 的 Session 持久化（`dsh-session-persistence`），Team 事件写进 Lead Session 的日志 | `<DSH_HOME>/bot/state.json` 一个 JSON 文件，`index.js:1-3` 原话是 *without new Session event types* |
| 并发保护 | 由 DSH 的 Session 持久化层负责 | 自建单写者文件锁 `home-lock.js`（pid + host + 随机 token，持有者定时 bump mtime），第二个宿主只读 |
| 消息 | `sendMessage()`：目标存 `agent-message` source，首块 `Team message from <name>:`，**不写** `team/message/queued` / `delivered` 记录 | `delivery.js:deliver()`：目标存 `source: { kind: 'bot', form: 'relay', role, … }`，正文首行是 `[Message from X]` 这类纯文本头；只有 `request`/`reply`/`stopped` 三种进 `state.exchanges` |
| 任务 | 共享任务 DAG：`createTask` / `updateTask`（CAS，带 `expectedRevision`）/ `claim` / `complete` / `release` / `reopen`，`writeScopes` 重叠只告警 | **没有任务板**。协作靠 `post_to_group` + `group_relay` + `ask_user` 三种消息原语 |
| 上限 | 成员 16（组合包 8）、任务 256、单消息 64 KiB、清理 5 s | 群成员 12（`ROOM_MAX_MEMBERS`）、往返日志 600 条（`MAX_EXCHANGES`）、跳数 6（`MAX_HOPS`）、群回合 3 轮起（`ROOM_BOT_ROUNDS`） |
| 客户端 | 独立包做 roster + 任务板 + teammate 导航，读 Session 投影 | 自建 55 个客户端文件，走 `ctx.slots` 阴影替换 DSH 的侧栏/对话区，读自己 `POST /api/bot` 的 `state` |
| 启用方式 | 组合包默认关闭，用户在插件页开启 | 装 `ds-bot` 包即生效 |
| 与普通 subagent 的关系 | 组合包 patch 里**显式禁用**四个 `tool-subagent-*` 条目 | 不动 DSH 的 subagent，两者共存（Usage 页还会统计 subagent 的调用） |

### 7.4 结论：绕开并重造，理由写在源码里

不是「不知道有」，而是**刻意选了另一条路**，理由在 `index.js:1-3` 的头部注释里说得很直白：

```js
// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
```

四件套的做法是把团队状态**写进 Session 事件流**（`provisioning` 记录、任务快照、`agentTeam` 投影），DS Bot 的做法是把团队状态**放在 Session 事件流之外**。两条路的取舍：

- 四件套换来的：状态随 Session 持久化天然一致、客户端投影自动刷新、有任务 DAG、有 CAS 并发控制、清理有超时保证。
- DS Bot 换来的：不新增任何 Session 事件类型，所以**卸载或降级不会在 DSH 的会话存储里留下孤儿事件**；团队状态可以整个拷走（README「Move to another computer」一节）；代价是自己做文件锁与迁移。

对 dsh-bot 的意义（这条是本报告对父目标最有价值的结论之一）：**DSH 已经有一份「Agent 团队」的官方实现，但它是实验性的、默认关闭的、且模型可见的接口面（九个工具 + 任务板）与 DS Bot 的（25 个工具 + 群聊回合）完全不同。** dsh-bot 若要走 Bot 团队路线，必须先决定是复用 `ctx.agentTeams` 还是照 DS Bot 自建——不能两边都沾。

---

## 8. 测试与工程实践

### 8.1 数量与分布（实测）

| 项 | 数量 | 说明 |
|---|---|---|
| `test/` 全部文件 | **59** | 任务书说「约 50」 |
| 其中 `*.test.js` | **57** | 合计 501,521 B |
| 非测试辅助 | **2** | `test/fake-ctx.js`（1,963 B）、`test/harness-resolve.mjs`（2,284 B） |
| `test/fixtures/` | **7** | `bing.html`、`bing-zh.html`、`duckduckgo.html`（搜索 provider 的解析样本）+ `read-page/{index,frame-1,frame-2,other}.html`（浏览器读取器样本） |
| `dev/` 顶层 | **15** | 见 8.8 |
| `dev/desktop-linux/` | **15** | Linux 桌面测试台 |
| `dev/harness/` | **1** | 只有 `package.json` |

最大的五个测试文件：`memory.test.js` 63,057 B、`web-search.test.js` 32,897 B、`bot-messages.test.js` 27,034 B、`roster.test.js` 23,239 B、`capabilities.test.js` 22,527 B。

测试覆盖的粒度是**按模块一对一**：`src/host/` 31 个文件 → 约 30 个对应测试；`src/client/` 55 个文件 → 约 20 个（客户端只测纯函数与结构，不测渲染）。

### 8.2 单测策略：假 ctx，不起真服务

`npm test` = `node --import ./test/harness-resolve.mjs --test "test/*.test.js"`（`package.json` scripts.test）。

两道基础设施：

**① `test/harness-resolve.mjs`（48 行）** —— 用 `node:module` 的 `registerHooks` 把 `@deepseek-ai/*` 的解析重定向到 DSH 安装处。查找顺序：环境变量 `DSH_HARNESS` → `dev/harness/node_modules` → 向上找 `deepseek-harness/` 检出 → git worktree 的 common dir 旁 → `../deepseek-harness`。这样 `npm test` 不需要插件自带一份 DSH。

**② `test/fake-ctx.js`（62 行）** —— 一个只记录、不启服务的假插件上下文。字段：`calls`（注册顺序流水）、`registeredTools`、`listeners`、`sections`、`logger.{warn,info}`、`get(name)`；方法：`on(name, listener, options)`（支持 `prepend`）、`emit(name, payload)`（只跑单参 listener，不跑带 `next` 的中间件）、`effect(execute, label)`（返回函数则登记为 disposer）、`dispose()`（反序 `Promise.allSettled`）、`tools.register(tool)`、`systemPrompt.section({name, order})`、`connection.fetch.register({methods, path})`、`llm.listProviders`。

这个文件的形状**反推出宿主 ctx 的 API 面**——它是 DS Bot 用到的那一层的精确投影，比读 DSH 的类型定义更快。

**实测结论：57 个测试文件里，只有 2 个会真的起进程或开端口**（全量 grep `createServer|spawn(|listen(`）：

| 文件 | 做了什么 |
|---|---|
| `test/mock-llm.test.js` | `spawn` 真跑 `dev/mock-llm.mjs`，`MOCK_PORT=0` 让内核选端口、mock 打印真实端口（`mock-llm.test.js:42-53`） |
| `test/web-search.test.js` | 起两个 `node:http` server 验证重定向后的来源解析（`web-search.test.js:236-245`） |

其余全部是纯函数 / 假 ctx / 临时目录。`test/read-page.test.js` 用 jsdom（`read-page.test.js:12`，从相邻的 deepseek-harness 检出里 require），注释点明了它的局限：**「jsdom has no layout: every box is 100×20 unless marked data-zero」**（`read-page.test.js:54`）——所以读取器的几何判断只能靠 fixture 上的 `data-zero` 标记来测。

### 8.3 一个值得照搬的测试：`install.test.js`

`test/install.test.js` 把整个插件装进假 ctx 再打真实 HTTP 请求：

```js
const home = mkdtempSync(join(tmpdir(), 'ds-bot-install-'))
const ctx = fakeContext({ services })
// 包一层 connection.fetch.register 把路由抓出来
const applyResult = apply(ctx, { home, ...config })
const call = async (endpoint, payload) => {
  const response = await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}
```
（`test/install.test.js:10-32`）

第一个测试断言 `ctx.calls` 的**注册顺序是固定的**（`test/install.test.js:36-45`）：

```js
assert.deepEqual(ctx.calls, [
  'effect ds-bot: state lock',
  'on llm/adapters-updated',
  'on session/event',
  'effect ds-bot: agent tool restrict retry',
  'on agent/created',
  'effect ds-bot: identity section',
  'prompt bot-identity 640',
  'on agent/pre-step (prepend)',
  'tool list_bots',
  …
])
```

这就是 `index.js:43` 那句注释「Listeners run and tools are listed in registration order」的**可执行版本**——`usage` 必须最后跑这条隐性约束，被一个数组断言钉住了。

### 8.4 `client.js` 是生成物，测试强制它同步

`test/client-bundle.test.js` 两个测试：

1. `client.js is the build of src/client` —— `assert.equal(await bundleClient(), committed(), 'client.js is stale: run \`npm run build\` and commit it')`。**字节级比对**打包器的输出与仓库里的 `client.js`。
2. `client.js registers a factory that exports apply and inject` —— 用 `node:vm` 的 `runInNewContext` 跑产物，只注入 `{ window: { __ModuleLoader__: { load } } }`，断言：恰好注册 1 次、`id === 'ds-bot'`、无多余键；用假 require 调 `factory`，断言 `requested` 去重后恰好等于三个平台模块、导出是 `[object Module]`、键恰好 `['apply','inject']`、`inject` 精确等于七个服务名。

这条测试同时守住了三件事：产物不过期、客户端不偷偷加 DSH 依赖、插件的导出面不膨胀。**这是「生成物入仓」这一做法的必备配套**，否则 `client.js` 会慢慢与源码脱节。

### 8.5 集成测试：mock 模型 + 测试台

**`dev/mock-llm.mjs`（49,627 B，dev 目录最大）** —— 一个 Anthropic-Messages 兼容的脚本化 mock 模型，`Usage: node dev/mock-llm.mjs, then point DEEPSEEK_BASE_URL at it.`

它的设计要点（全部取自文件头注释）：

- **用中文命令词驱动**，不是靠匹配具体提示词。命令表（节选）：`建群 名: A, B`、`群发[回报] 名: 消息`、`改群 名 公告|管理员|模式|加|踢: 值`、`看群 名`、`转告 名: 消息`、`插话` / `排队` / `叫停`、`长文 N`、`长任务 N [K]`、`查记录 词`、`查锚点 part N #序号`、`上下文里有 词`、`撑爆`（伪造 400 溢出）、`报错`（伪造 401 拒钥）、`卡片 K`、`记住[@话题] 事实`、`团队记住 事实`、`忘掉 事实`、`回忆 [词]`、`查能力 [词]`。
- **群回合只读提示里的 "This round so far" 段**，所以「回合」与「更早消息」不分开计数就会错（文件头注释原话）。
- **用量按请求大小估算**：约 3 字符/token、90% 命中缓存——这样上下文表格与换篇阈值看到的是真实增长。
- **日志记录 system prompt 与 tools 的哈希**，用来确认群 Session 与私聊**共享前缀**（这是 DS Bot 缓存策略的核心假设，被 mock 侧独立验证）。
- 环境变量：`MOCK_PORT`、`MOCK_LOG`、`MOCK_DELAY_MS`、`MOCK_JITTER_MS`（随机额外延迟，用来抖出顺序假设）、`MOCK_LOG_CHARS`、`MOCK_SUMMARY_DELAY_MS`、`MOCK_NATIVE_SEARCH=off`、`MOCK_REJECT_IMAGES=1`、`MOCK_WATCH`（记录某个值是否出现在模型输入里）、`MOCK_LOG_TOOLS=1`。
- 还实现了：记忆面板的摘要/问答/复盘三种请求、交接笔记与后端压缩（各返回一份八节笔记，分别标 `handoff 提示词` / `backend 提示词`）、检查点（标 `checkpoint 提示词`）、上下文管家的 `compact`/`switch` 判定、密钥卡的回显、以及一个 Ollama 形状的 `POST /api/web_search`。

**`dev/bench.sh`** —— 测试台：mock 模型 + 一个把插件 link 到本 checkout 的 dsh web。用法 `dev/bench.sh <name> <web-port> <mock-port> [start|stop|reset|status]`。数据在 `<checkout>/.dsh-test-<name>`；进程按 pid 文件与**进程组**停，「never by name」。环境：`CONTEXT_WINDOW`、`CHECK_RATIO`、`MOCK_DELAY_MS`、`DSH_HARNESS`。

**`dev/smoke.mjs`（18,422 B）** —— API 级冒烟：走 `POST /api/bot` 驱动主流程，每步等团队安静（`QUIET_MS = 2500`、`STEP_TIMEOUT_MS = 120_000`），再查 `state.json` 与 mock 日志。**共 29 个 `await step(...)`**（实测）。`--out <file>` 写归一化转录（名字替代 id，时序相关处排序），便于重构前后 diff。

它覆盖的步骤（按源码顺序，节选并归类）：

| 类 | 步骤 |
|---|---|
| 引导 | `bootstrap: Chief waits for a model`；`user picks a model; Chief greets and asks` |
| 建 Bot | `Chief creates Writer, who replies`（经 `message_bot`）；`user creates Coder, who keeps the default model` |
| 群聊 | `Chief creates a group`；`user talks in the group`；`admin calls everyone`；`Chief posts to the group`；`Chief sets the group notice`；`Chief reads the group`；`delete the group` |
| 长对话分片 | `Writer writes long reply N`（多轮）；`Writer searches its own chat across parts`；`earlier part pages load`；`Writer keeps working N`；`Writer condensed in place, not switched`；`Writer finds a condensed message`；`Writer wraps up N` |
| 往来与改名 | `exchange log between Chief and Writer`；`update Writer`；`pin Coder`；`make Coder a Main Bot and back`；`duplicate Coder`；`set prefs`；`delete the copy` |
| 能力 | `Chief sees its attached MCP and skill`；`Chief first group turn sees its attached MCP and skill`；`Coder does not inherit Chief capabilities`；`detached capabilities disappear from Chief` |

能力那四步用一个真的 stdio MCP echo server（`dev/mcp-echo-server.mjs`，导出 `echo` 工具）作为夹具，断言的是「群 Session 与私聊共享能力挂载，而另一个 Bot 不继承」——这是 `capabilities.js` 的对账循环最容易出错的地方。

**`dev/check.sh`** —— 一条命令查两端，六个步骤 `STEPS="unit build lint smoke web desktop"`：

| 步骤 | 做什么 |
|---|---|
| `unit` | `npm test` |
| `build` | `build-client.mjs --check` |
| `lint` | `npm run lint`（warning 不算失败） |
| `smoke` | 起一个全新 smoke bench + `dev/smoke.mjs` |
| `web` | 起一个全新 Web bench + `dev/ui-shots.mjs` |
| `desktop` | 起一个全新 Desktop（`desktop-linux/desktop.sh`），同一批截图 + `browser-check.mjs` + `read-check.mjs` 跑样例页 |

`dev/check.sh [--skip step,step] [--only step,step] [--out <dir>]`。端口按 `SLOT=n`（0-9，默认 0）：Web `31n0/88n0`、smoke `31n1/88n1`。**「Every process it starts is stopped at the end, also on failure or Ctrl-C.」**（`trap cleanup EXIT` + `trap 'exit 130' INT TERM`）。里面还有一处诚实的重试注释：共享服务器上 bench 的 dsh web 曾以空日志退出，下一次启动就好了，所以 `bench_reset` 重试一次。

**`dev/ui-shots.mjs`（19,478 B）** —— 两端截同一批屏，**共 27 个 `shot(...)`**（实测）。截的是：团队现状、新 Main Bot 的模型卡与问候、带 Writer/Coder 的侧栏（Writer 被 pin 住，所以侧栏显示 pin）、私聊及其详情面板的模型选择器与设置、Bot 记忆的四处（存进去时 / 团队记忆 / 详情面板行 / 记忆对话框的摘要、条目、问答）、记忆胶囊、群聊与其设置、Bot 设置、Bots 与 Group chats 页、Usage 页四个视图。Desktop 用 CDP 截图（或 `SHOT_DISPLAY` 抓屏），Web 用 dsh 的 playwright-core 起 headless Chrome，并用 bench 的 `web.log` 里的 token URL 登录——**那个 URL 从不打印**。

### 8.6 真模型上的三个评估脚本

单测与 smoke 都跑 mock，但有三个脚本**故意要真模型**，因为它们考的是模型判断力：

| 脚本 | 考什么 | 成本（文件头自述） |
|---|---|---|
| `dev/memory-e2e.mjs`（13,188 B） | 记忆端到端：用户像平常那样说话（**大多不说 "remember"**），脚本给落到记忆里的东西打分，并看后来的群聊（没有私聊历史）有没有用上 | 约 30 次 Bot 调用 × 14-20k prompt token；开记忆复盘再加约 30 次 × 2-5k |
| `dev/steward-eval.mjs`（14,497 B） | 上下文管家的判断力：手写对话结尾 + 应有答案，走管家自己的提示与请求（`src/host/steward.js`）。`expect` 取 `compact` / `switch` / `either`（either 是判断题，只记录答案） | 每次调用约 3,000 token |
| `dev/llm-tap.mjs`（10,780 B） | 不是评估，是**观测**：OpenAI chat completions / Anthropic Messages 两种格式的日志透传代理，逐次调用写一行 JSON（调用种类、哪个 Bot、token 用量、最新输入与回答）。`tokens` 把两种格式归一成 `{ prompt(含 cached), cached, output }`。**「Headers are never logged.」** 调用种类有 `steward` / `checkpoint` / `handoff` / `main` 四种 | —— |

`memory-e2e.mjs` 的存在本身就是一条设计声明：**记忆系统的验收标准不是「remember 被调用了」，而是「用户没说记住、后来的对话却用上了」。** 这与 8.5 里 mock 的 `记住` / `回忆` 命令形成互补——mock 测管道，e2e 测效果。

### 8.7 `dev/` 其余工具的用途

| 文件 | 字节 | 用途（取自头注释） |
|---|---|---|
| `mock-llm.mjs` | 49,627 | 见 8.5 |
| `characters.mjs` | 28,069 | **角色造型的源生成器**：用有符号距离基元（球、椭球、圆台、圆环、挤出体、把最初吉祥物轮廓膨胀成的软板）搭小 3D 模型，从固定四分之三视角描成 100 单位盒里的平层。`node dev/characters.mjs` 打印给 `src/client/characters.js` 的 CHARACTERS 块；`--preview a.html` 另写预览画廊 |
| `ui-shots.mjs` | 19,478 | 见 8.5 |
| `smoke.mjs` | 18,422 | 见 8.5 |
| `steward-eval.mjs` | 14,497 | 见 8.6 |
| `memory-e2e.mjs` | 13,188 | 见 8.6 |
| `llm-tap.mjs` | 10,780 | 见 8.6 |
| `check.sh` | 7,031 | 见 8.5 |
| `bench.sh` | 5,417 | 见 8.5 |
| `mascot-outlines.mjs` | 4,436 | 最初吉祥物的源轮廓（512 单位盒，花瓣 20 单位），导出 `BLOSSOM_PETALS` / `MOON_BODY` / `SQUIRCLE_BODY` / `STAR_BODY` / `WAVE_BODY`，被 `characters.mjs` 消费 |
| `shared-home-check.mjs` | 4,414 | **Web 与 Desktop 共用一个 DSH_HOME 时会不会互相丢改动**。两端先都加载团队，再轮流各建一个 Bot 并发消息。通过条件：每端报过创建的 Bot 都还在 `state.json`、团队只有一个 Main Bot、每端要么存下了改动要么带消息拒绝了 |
| `logo.mjs` | 3,303 | README 的 logo：鲸鱼居中，最初几个角色环列四周，从插件自己的角色表画。写亮/暗两版，默认输出 `../docs/images` |
| `read-page-check.mjs` | 2,766 | 在 headless Chrome 上跑 `READ_PAGE_SCRIPT`，打印耗时、大小与文本头几行。**比桌面端快**，用于开发读取器与给真实网站计时。playwright-core 来自相邻的 deepseek-harness 检出 |
| `read-pages.mjs` | 1,969 | 读取器的样例页服务：`test/fixtures/read-page` + 一个生成的大表 `/big-table.html?rows=N`。首页第二个 iframe 从 `http://localhost:<port>/` 加载，是**跨源**用例。默认端口 8833 |
| `mcp-echo-server.mjs` | 1,240 | 极简 stdio MCP echo server，导出 `tools = [{ name: 'echo', description: 'Return the supplied text.', inputSchema: { text } }]`。被 `smoke.mjs` 当作能力夹具 |

`dev/desktop-linux/`（15 个文件）：`desktop.sh`（7,935 B，Linux 桌面测试台启动脚本）、`launch.mts`、`lib.mjs`、`onboarding.patch.yml`、`fetch-electron.mjs`、`browser-check.mjs`（8,247 B）、`read-check.mjs`（9,117 B）、`probe-webview.mjs`、`simulate-windows-caption.mjs`、`window-size.mjs`、`create-bots.mjs`、`cookie-page.mjs`、`cleanup-probe.mjs`、`shot.mjs`、`wait-app.mjs`。

`dev/harness/package.json`（唯一文件）：
```json
{ "name": "ds-bot-test-harness", "private": true,
  "description": "The DeepSeek Harness packages that the unit tests and the linter run against. Install with npm run harness in ds-bot/.",
  "dependencies": { "@deepseek-ai/dsh": "0.2.0-rc.2", "jsdom": "29.1.1", "oxlint": "1.76.0" } }
```
**注意 `@deepseek-ai/dsh` 是 `0.2.0-rc.2`，不是最新。** 测试与 lint 固定跑在一个已知良好的 DSH 版本上，CI 里再另测更新的版本（见 8.8）。

### 8.8 CI 与 lint

`.github/workflows/test.yml`：4 个矩阵组合，`fail-fast: false`：

| OS | Node | DSH |
|---|---|---|
| ubuntu-latest | 24 | 0.2.0-rc.2 |
| windows-latest | 24 | 0.2.0-rc.2 |
| ubuntu-latest | 22 | 0.2.0-rc.2 |
| ubuntu-latest | 24 | **0.2.1-alpha.1** |

最后一行是**前向兼容哨兵**：固定的 harness 版本之外，额外测一个更新的 DSH。步骤：`npm ci --no-fund --no-audit` → `npm run harness -- --no-save "@deepseek-ai/dsh@<matrix.dsh>"` → `npm test` → `node scripts/build-client.mjs --check` → `npm run lint`。`concurrency` 按 ref 分组并 `cancel-in-progress: true`。

`.oxlintrc.json`（177 B，全文）：
```json
{ "env": { "browser": true, "node": true, "es2024": true },
  "rules": { "no-undef": "error", "no-unused-vars": ["error", { "ignoreRestSiblings": true }] } }
```
只开两条规则，都是 error。刻意不引入风格规则。

`scripts/lint.mjs`（1,613 B）—— 自己找 oxlint，顺序：`DSH_HARNESS` → `dev/harness` → `../deepseek-harness` → git common dir 旁。用 `process.execPath` 跑 `node_modules/oxlint/bin/oxlint`，因为**「on Windows it cannot spawn the .cmd shim in node_modules/.bin without a shell」**。扫描目标：`index.js web-search.js src dev scripts test`。

### 8.9 工程实践的几条硬规则（`.refs/DeepSeek-Bot/AGENTS.md`）

这五条是仓库的硬规则，每条都有对应的机制在守：

| 规则 | 由什么守 |
|---|---|
| 1. **Plugin only** —— 绝不 patch DSH 或依赖 DSH 安装目录内的文件 | 实测：宿主只 import 三个 DSH 包的公开导出；动态引用也只经 `loader.import`。见 6.1/6.2 |
| 2. **No secrets** —— 绝不写入/打印/提交 API key、token、cookie 或 DSH_HOME 内容；测试用 mock 模型，不需要 key | `dev/mock-llm.mjs` 全程无 key；`dev/llm-tap.mjs` 明确不记 header；`src/host/diagnostics.js` 保存前清洗 |
| 3. **Only original material** —— 不抄其他产品或网站的代码/文字/图标/logo/图形 | `dev/logo.mjs` 与 `dev/characters.mjs` 从插件自己的角色表生成全部图形资源 |
| 4. **`client.js` 是生成物** —— 改 `src/client/`，跑 `npm run build`，两个文件一起提交，绝不手改 | `test/client-bundle.test.js` 字节级比对 + CI 里的 `--check`。见 8.4 |
| 5. **不动用户的 DSH 数据** —— 测试台数据在 `.dsh-test-<name>/`，绝不指向 `~/.dsh` | `dev/bench.sh` 把 home 固定在 `<checkout>/.dsh-test-<name>`；`home-lock.js` 保证生产环境只有一个写者 |

命令一览（`AGENTS.md`，在 `ds-bot/` 下运行）：

```sh
npm ci                                 # build tool only (esbuild)
npm run harness                        # once: the DSH packages for the tests and the linter
npm run build                          # src/client → client.js
npm test                               # unit tests; also fail if client.js is stale
node scripts/build-client.mjs --check  # client.js matches src/client
npm run lint                           # oxlint
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096
dev/bench.sh smoke 3096 8796 stop
```

`AGENTS.md` 里关于「何时算做完」的原话：**「A change is done when `npm test`, the `--check` and `npm run lint` pass; CI runs them on every pull request. Run the smoke test as well for changes to `index.js` or `src/host/`.」** —— 也就是分两档：改 `src/client/` 只需单测 + 产物同步 + lint；改宿主还要加 smoke。

---

## 与已有报告的衔接

- 本节（6/7/8）对应任务书第 6/7/8 项，`research/ds-bot-architecture.md` 目前**没有**对应章节（其章节止于 `## 5. 已知边界与疑点` 与 `附录 A`）。
- 第 2 节的素材在 `research/notes-client.md`，第 3 节（五个机制）的素材在 `research/notes-mechanisms.md`，都已被 `ds-bot-architecture.md` 的 `## 2` / `## 3` 吸收。
- 本文件是唯一覆盖 `dev/`、`smoke.mjs`、`mock-llm.mjs`、`Agent Teams 四件套` 的素材。
