# DS Bot 参考实现架构拆解（模块级）

> 对象：`.refs/DeepSeek-Bot/ds-bot/`（DS Bot v0.1.4，Apache-2.0）
> 性质：一个挂在 DeepSeek Harness（DSH）上的**插件**，不修改 DSH 本体。
> 本文所有引用给 `文件路径:行号`，路径相对 `.refs/DeepSeek-Bot/ds-bot/`。
> 明确未读：`client.js`（812,835 B，esbuild 生成物）、`web-search.js`（41,985 B，独立的搜索 provider）。

---

## 0. 结论摘要

1. **形态：纯插件，不改 DSH 本体。** 每个 Bot 就是一个 DSH 的 root Session；名册、房间、Bot 互发消息的日志全部落进 DSH_HOME 下的**一个 JSON 文件**，从而「不新增 Session 事件类型」（`./index.js:1-3`）。代价是自建单写者文件锁（`src/host/home-lock.js`），收益是卸载/升级都不会在 DSH 的会话存储里留下孤儿事件。

2. **装配：31 个模块共用一个 `rt` 对象。** 每个模块的 `install(rt)` 把自己的函数挂到 `rt` 上，运行时通过 `rt.xxx()` 互调，模块之间几乎没有直接 import。`MODULES` 数组的顺序即装载顺序，且与 import 顺序**不同**——`usage` 被排到最后，因为它必须计量所有被别的模块改写过的模型请求（`./index.js:39-43`）。

3. **状态：一个文件，一个写者。** `state.json` 的形状是 `{version, mainBotIds, bots, rooms, agents, capabilities, exchanges, exchangeTurns, questions, prefs, revision}`（`src/host/store.js:14-15`）；写入是 temp → 两次 `ensureLock()` → `rename`（`src/host/store.js:246-268`），丢锁抛 `ELOCKLOST`；另一个 dsh 持有锁时整个插件退化为只读（`src/host/store.js:52-57`）。

4. **Session 映射：三张表 + 一条不变量。** `chatOwners` / `groupOwners` / `pastOwners` 三张 Map 把 Session id 映回 Bot；`selfOf` 依次查三张（历史篇也答得出来），`isBotSession` 只认前两张（`src/host/store.js:295-321`）。锚点是「**Bot 的 id 就是它第一篇 Session 的 id，永不变**」（`src/host/store.js:290-294`），这是建 Bot 时先 `createSession` 再以该 id 为键写记录的结果（`src/host/roster.js:67-69`）。

5. **投递：一条消息，两条通道。** `deliver` 是唯一入口，同时给出「给模型读的纯文本来源头」和「给程序读的结构化 `source`」；role 共 10 种，只有 `request` / `reply` / `stopped` 三种进团队往来记录（`src/host/delivery.js:15-28`、`31`、`48-64`）。

6. **群聊：回合是一张可插队的槽位表。** `@` 呼叫不是排队等下一轮而是插到当前发言者之后；已经被叫过的人被「提上来」而不是重复入队；只有管理员的 `@all` 能叫所有人；回合上限随 `@` 数量动态增长（`src/host/groups.js:26`、`252`、`309`、`373`）。回合本身是「等」出来的——发一条投递后挂一个会被任何事件续命的 waiter（`src/host/groups.js:207`）。

7. **长对话：包住宿主的压缩引擎，改由小模型决策。** DS Bot 替换引擎对象上的三个压缩方法并全部拒绝（`src/host/parts.js:176-200`），改用「三条线（check/hard/usable）+ 一次小模型判断」决定「换新篇」还是「原地压」；换篇交给「模型自写的交接说明 + 最近消息原文」，不是摘要（`src/host/steward.js:20`、`src/host/parts.js:329`）。判不出来时保守换篇（`src/host/parts.js:505`）。

8. **密钥：出站替换，Bot 永远拿不到值。** `secrets.json` 强制 600（`src/host/secrets.js:143`），以 `$DSH_SECRET_<NAME>` 按需注入 shell 环境变量（`src/host/secrets.js:12`、`474`），工具结果与模型请求**两个出口**都过 `redactDeep`（`src/host/secrets.js:440`、`459`）。Bot 只能查到「有这个名字、我能不能用」（`src/host/secrets.js:383`）。

---

## 1. 宿主模块清单

| # | 文件 | 字节 | 职责 | 关键导出 |
|---|------|------|------|----------|
| 1 | `src/host/constants.js` | 4141 | 全模块共享的固定值：颜色表、OCR 参数、客户端路由、消息/群聊/读聊上限 | `COLORS` `EXTRA_COLORS` `LEGACY_COLORS` `LEGACY_THEMES` `OCR_PROMPT` `ROUTE` `MAX_HOPS` `MAX_EXCHANGES` `ROOM_MODES` `TEAM_TOOLS` `SOURCE_KIND` `REPLY_KIND` `REFERENCE_KIND` |
| 2 | `src/host/store.js` | 15724 | 唯一的团队状态文件 `state.json`：加载/迁移/原子写、锁与只读判定，以及 Session→Bot/群聊 的三张索引表 | `install`；`rt`: `state` `load` `save` `refresh` `readOnly` `botOf` `roomOf` `isMain` `chatOf` `selfOf` `isBotSession` `chatOwners` `groupOwners` `pastOwners` `groupSessionsOf` `dropGroupSession` `findBot` `findRooms` `isAdminOf` |
| 3 | `src/host/home-lock.js` | 3361 | 「一个 home 一个写者」的文件锁：token + pid + host + mtime 心跳，另一个 dsh 只能读 | `pidAlive` `homeLock` |
| 4 | `src/host/permissions.js` | 1870 | 把 Bot 自己的 permission preset 施加到它的每一个 Session（私聊与各群 Session） | `install`；`rt`: `permissionCatalog` `applyPermission` `setPermission` |
| 5 | `src/host/diagnostics.js` | 11436 | 抓 `ctx.logger` 的告警到内存 + `logs/diagnostics.jsonl`，脱敏（密钥/凭证/home 路径）后生成可公开提交的 issue 报告 | `KEEP` `REPORT_ENTRIES` `ISSUES_URL` `cleanText` `entryLine` `reportMarkdown`；`rt`: `warn` `noteFailure` `diagnostics` |
| 6 | `src/host/turns.js` | 24253 | 每个 Bot Session「此刻在做什么」的活状态：Bot 触发的回合、群回合的 waiter/inbox、回合结束后的回复路由 | `turnFailure` `failureLine` `attachReference` `writesToolCall` `stripWrittenCalls`；`rt`: `live` `liveOf` `roomWaiters` `roomProgress` `roomInbox` `activityView` `workView` `roomWorkView` `callDetail` `stopRoomTurn` |
| 7 | `src/host/delivery.js` | 4609 | 唯一的投递入口：把一条消息以 `agent.steer` / `agent.followup` 送进某个 Bot Session，并给消息加上来源头 | `install`；`rt`: `resolveAgent` `deliver` |
| 8 | `src/host/resume.js` | 12355 | 崩溃/重启后的续跑：把在跑的回合与未取走的投递记进 `inflight.json`，下次启动各恢复一次 | `resumeText` `install` |
| 9 | `src/host/chat-index.js` | 14138 | Bot 自己聊天记录的读取层：Session 事件倒序分页 + SQLite FTS5（trigram）索引 + search/latest/around 三种读法 | `termQuery` `install`；`rt`: `eventsBackwards` `searchOwnChat` `latestOwnChat` `aroundOwnChat` `partIndex` `ownChatBrief` |
| 10 | `src/host/text.js` | 2359 | 纯文本工具：颜色归一、model ref 拆分、取文本块、去引号、正则转义、摘录、token 估算、时钟格式 | `currentColor` `isColor` `splitRef` `textOf` `normalize` `unquote` `escapeRegExp` `excerpt` `estimateTokens` `clip` `createClock` |
| 11 | `src/host/time-context.js` | 2198 | 按需给 Bot 注入「当前时间」快照（默认 10 分钟一次），且不与 DSH 自带的 timeContext 投影重复 | `install` |
| 12 | `src/host/roster.js` | 22260 | Bot 与群聊的增删改：建 Bot（含 kickoff 欢迎语与失败回收 Session）、复制 Bot、改设置、建/改/删群、Main Bot 角色、新团队的第一个 Main Bot | `install`；`rt`: `ensureWorkspace` `createSession` `createBot` `duplicateBot` `updateBot` `setFlags` `roomBusy` `autoRoomName` `retitleRoom` `createRoom` `updateRoom` `deleteRoom` `setMain` `deleteBot` `bootstrap` `dropKickoff` |
| 13 | `src/host/agents.js` | 7809 | 团队里的一个「普通 dsh 入口」：它的 Session 是 DS Bot 工作区里的普通根 Session，因此拿到完整 dsh 对话面但没有团队工具 | `install`；`rt`: `indexAgents` `agentOf` `addAgent` `createAgentSession` `adoptAgentSession` `archiveAgentSession` `renameAgentSession` `removeAgent` |
| 14 | `src/host/groups.js` | 39868 | 群聊全部机制：房间日志与序号、成员的群 Session、轮流发言与 @ 呼叫、迟到回复、回合报告、以及三个群工具；另在 `llm/stream` 上合成 `group_relay` | `stripOwnName` `isPass` `mentionsIn` `referenceNote` `install`（无 `Object.assign(rt, …)`，全部能力走工具与 ctx 事件） |
| 15 | `src/host/prompt.js` | 8741 | 系统提示里的 `bot-identity` 小节：文本只取决于渲染 Session 自己的 Bot 记录，前缀跨回合与名册变化保持逐字节稳定 | `install`（注册 `ctx.systemPrompt.section({name:'bot-identity', order:640, interpolate:false})`） |
| 16 | `src/host/steward.js` | 10619 | 上下文管家：对话越过检查线后，用一次小模型调用判定「换新篇」还是「原地压缩」，并生成交接包/检查点文本 | `DEFAULT_WINDOW` `DEFAULT_CHECK_RATIO` `linesFor` `STEWARD_SYSTEM` `checkpointTailNote` `checkpointText` `install` |
| 17 | `src/host/tools.js` | 30286 | 团队工具面：名册、Bot 间消息、群设置与发言、提问卡（群回合与读聊在 groups.js） | `output` `GROUP_REF` `install`；`rt`: `pickRoom` |
| 18 | `src/host/capabilities.js` | 22547 | 共享能力（MCP server / skill / pack）：名字校验、pack 展开、按 Bot 挂载到 Session、与 DSH 的 capability 目录对账 | `validateCapabilityName` `expandCapabilityNames` `install`；`rt`: `capabilitySave` `capabilityDelete` `capabilityEndpoint` `capabilityLibraryView` `capabilityStatusesView` `reconcileCapabilities` `scheduleCapabilitiesReconcile` `ensureCapabilities` `expandCapabilities` `changeCapabilityAttachment` |
| 19 | `src/host/connectors.js` | 6853 | 外部服务连接器，首个是 GitHub：工具经 DSH 自己的 MCP 客户端挂到插件上下文，token 只在内存里进请求头 | `GITHUB` `GITHUB_SECRET` `signIn` `install`；`rt`: `connectorsView` `connectorEndpoint` `secretsChanged` |
| 20 | `src/host/secrets.js` | 23807 | 用户输入给 Bot 的密钥：只存 `secrets.json`（mode 600），以 `$DSH_SECRET_<NAME>` 进 shell，工具结果与模型请求出站前都被替换成 `[secret:<NAME>]` | `SECRET_NAME` `ENV_PREFIX` `MIN_VALUE` `WHOLE_VALUE` `MAX_VALUE` `envName` `canUse` `normalizeName` `redactor` `redactDeep` `install`；`rt`: `secretsView` `secretValue` `canUseSecret` `secretEndpoint` `forgetBotSecrets` `loadSecrets` `redactSecrets` |
| 21 | `src/host/models.js` | 10304 | 每个 Bot 一个固定模型：目录缓存与 TTL、思考档位解析、默认模型、把选择写进 Session 并等 provider 就绪 | `install`；`rt`: `catalog` `cachedCatalog` `cachedDefault` `defaultRef` `defaultModel` `resolveModel` `desiredModel` `reasoningOf` `resolveEffort` `desiredEffort` `selectSessionModel` `applyModel` `waitForModel` `syncModels` |
| 22 | `src/host/schedules.js` | 7393 | 定时任务：为设置页列出/增删团队任务，Bot 对话换新篇时把任务一并搬过去，群任务挂在群自己的 Session 上 | `reminderText` `install`；`rt`: `scheduleEndpoint` `moveSchedules` |
| 23 | `src/host/browser.js` | 12908 | Bot 浏览器（仅桌面端）：每个 Bot 一个 Electron webview 面板，本模块经长轮询通道 `browser-wait`/`browser-result` 读页面 | `install`；`rt`: `browserEnabled` `browserChannel` `browserOpen` |
| 24 | `src/host/approvals.js` | 3176 | 审批代理：群 Session 是隐藏的，DSH 的审批卡不会显示，因此由本模块替它作答；私聊仍用 DSH 自己的卡，只记「谁在等」 | `install`；`rt`: `approvalsView` `waitsForApproval` `answerApproval` `cancelApprovals` |
| 25 | `src/host/memory.js` | 79091 | Bot 跨会话记忆：Agent Memory Repo 格式的 Markdown，`journal.jsonl` 记每次改动的前后行，`snapshots/` 冻结每个 Session 看到的那一版 | `install`；`rt`: `memoryEnabled` `renewMemory` `archiveBotMemory` `memoryEndpoint` `memoryNews` `memoryReviews` |
| 26 | `src/host/parts.js` | 55945 | 长对话的分片：原地检查点、换新 Session、交接包与交接笔记、聊天视图的更早分页；上下文越线的判定与执行都在这里 | `install`；`rt`: `clock` `partsOf` `historyEntry` `partLines` `noteText` `earlierPage` `switchJobs` |
| 27 | `src/host/images.js` | 9269 | 给纯文本模型看的图片：请求到达读不了图的模型前，每张图先用视觉模型转成文字，转换结果按附件缓存以免破坏提示缓存 | `offloadTargets` `install`；`rt`: `imagesForGroup` |
| 28 | `src/host/usage.js` | 27017 | 用量账本：Session 日志里已记录的调用直接读日志，日志外的调用（检查点、交接笔记、管家、读图、DSH 标题与压缩）在流式时计量，落 `usage.sqlite` | `install`；`rt`: `usageView` `tagUsage` `carryUsageTag` |
| 29 | `src/host/update.js` | 11571 | DS Bot 自身更新：对比包版本与安装来源（npm registry 或 GitHub tag）上的最新版，用户确认后经 DSH 的插件管理器重装；本地/link 安装永不提示 | `OFFICIAL_REGISTRY` `MIRROR_REGISTRY` `CHECK_TTL_MS` `FETCH_TIMEOUT_MS` `install`；`rt`: `updateCheck` `updateStart` `updateView` `repoStars` |
| 30 | `src/host/dsh-update.js` | 8137 | DSH 本体更新：已发布的 DS Bot 可以声明它验证过的 DSH 版本（`dsBot.verifiedDsh`），只提供这一版，未验证的不碰 | `install`；`rt`: `dshUpdateCheck` `dshUpdateStart` `dshUpdateView` |
| 31 | `src/host/channel.js` | 17070 | 浏览器通道：`POST /api/bot` 单端点分发，`errorCode` 区分「内部故障（带栈记日志）」与「给用户看的拒绝」 | `errorCode` `install`；`rt`: `uiLanguage` |

---

## 1b. 组 A / 组 B 细读笔记

### A. `store.js` —— 团队状态唯一真相

**状态形状**（`src/host/store.js:14-15`）：

```js
/** @type {{version:1, workspaceId?:string, mainBotIds:string[], bots:Record<string,any>, rooms:Record<string,any>, agents:Record<string,any>, capabilities:{items:Record<string,any>}, exchanges:any[], exchangeTurns:Record<string,number[]>, revision:number}} */
const state = { version: 1, mainBotIds: [], bots: {}, rooms: {}, agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 }
```

十个顶层键就是整个 Bot 团队：`bots`（Bot 名册）、`rooms`（群聊）、`agents`（DSH Agent 条目）、`capabilities`（能力库）、`exchanges`（Bot 互发消息日志）、`exchangeTurns`（哪些回合由另一个 Bot 触发）、`questions`、`prefs`。

**三张 Session 索引表**（`src/host/store.js:295-321`）——这是全插件把「一个 Session」认回「哪个 Bot、哪个群」的唯一办法：

```js
/** @type {Map<string, string>} */
const chatOwners = new Map()
/** @type {Map<string, {botId:string, roomId:string}>} */
const groupOwners = new Map()
/** @type {Map<string, {botId:string, roomId?:string}>} */
const pastOwners = new Map()
const chatOf = botId => botOf(botId)?.sessionId ?? botId
```

```js
const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
const isBotSession = id => chatOwners.has(id) || groupOwners.has(id)
```

`selfOf` 是「这个 Session 替谁说话」：先查私聊索引，再查群 Session 索引，最后查归档分段。`isBotSession` 只在「现在正在用的」Session 上为真，归档分段不算。

**分段（segment）与 id 稳定性**（`src/host/store.js:290-294` 注释）：

```
// Segments. A long conversation moves to a fresh Session at a context line (see
// parts.js). A Bot's id is the Session id of its first own-chat segment and
// never changes; `bot.sessionId` is the current one.
```

**迁移是就地改 `state` 并立即回写**（`src/host/store.js:99-168`、`170-186`）：`adopt()` 把老团队就地升级（缺 `capabilities` 补、`lab` 字段删除并把 `appliedModel` 提升为 `model`、单个 `mainBotId` 变数组、老主题 id 改名、群聊补 `admin`/`mode`/`notice`），然后 `load()` 在拿到写锁时立即 `save()`。注释（`src/host/store.js:176-177`）点明一个坑：「一次失败的写不能毒化 `loaded`」。

**原子写 + 锁再校验**（`src/host/store.js:246-268`）：写临时文件 → `rename`，中间两次 `ensureLock()`，丢锁抛 `ELOCKLOST`。

### B. `turns.js` / `delivery.js` / `resume.js` —— 回合与投递

**投递只有一个入口**（`src/host/delivery.js:41`、`74-81`）：

```js
const message = createUserMessage({
  content: [{ type: 'text', text: `${headerFor(role, fromName, room?.name, audience, note, deferred, { resumed, retried })}\n${text}` }],
  source,
})
if (steer) agent.steer(message)
else agent.followup(message)
await ctx.sessions.flush(agent.session)
```

即：Bot 之间、用户、插件自己给 Bot 发消息，全都走 `createUserMessage` + `agent.steer`（插进正在跑的回合）或 `agent.followup`（排队下一个回合）。`source` 上带 `kind: 'bot'`、`role`、`exchangeId`、`hop`、`senderName`、`roomId`、`audience` 等（`src/host/delivery.js:48-64`），接收方靠这些字段知道该不该回话、回到哪。

**来源头是给人看的自然语言**（`src/host/delivery.js:15-28`），例如：

```js
if (role === 'reply') return `[Reply from ${fromName}]`
if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
if (role === 'report') return `[Group chat "${roomName}" · replies to your post]`
if (deferred) return `[Message from ${fromName} · you read it during your last task; answer it now]`
if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
```

**hop 计数防环**（`src/host/constants.js:23` `MAX_HOPS = 6`，`src/host/delivery.js:41` 的 `hop = 0` 参数）：Bot 互相转发消息时逐跳加一，超过 6 跳停止。

**回合触发登记**（`src/host/turns.js:148-158`）：`claimTrigger` 决定哪些回合要记进 `state.exchangeTurns`（私聊里等回话的请求和 `stopped` 通知要记，群 Session 因为是隐藏的不用记）。

**活状态不落盘**（`src/host/turns.js:106-107` 注释）：

```js
// What each running Bot is doing right now, for its mascot. Process-local: it is
// rebuilt from live events and never saved.
```

**重启续跑**（`src/host/resume.js:1-6` 头注释）：

```
// Resume: Bot work that DeepSeek Harness dropped when it closed or restarted. DSH closes
// a turn it never finished as interrupted when the Session next opens, and a clean
// shutdown also cancels the messages still waiting in a Session's inbox; nothing would
// ever run either again, and whoever waited for them was not told.
```

实现是 `rt.deliver` 的包装（`src/host/resume.js:100-113`）：投递前先记进 `queued`，回合取走时（`session/event` 的 `user/message`，`src/host/resume.js:131-134`）删掉；启动时读回 `inflight.json`，还在的重新投递一次。防重启死循环的守卫在 `src/host/resume.js:173-179`：

```js
// A turn already picked up once and cut off again stays stopped: a restart loop
// must not run it forever.
if (record.resumed) return
```

**写在原地而非 rename**（`src/host/resume.js:70-71` 注释）：

```
// Written in place: a rename over the file fails on Windows while anything reads
// it, and a torn write only loses what one restart would pick up.
```

这与 `store.js` 用 rename 的做法相反，因为两者对「写坏」的容忍度不同：`state.json` 写坏就丢了整个团队，`inflight.json` 写坏只丢一次重启补偿。

### C. `chat-index.js` / `text.js` / `time-context.js`

**SQLite FTS5 索引**（`src/host/chat-index.js:4-9` 头注释）：

```
// Chat index. read_own_chat searches a SQLite FTS5 table of every part of a Bot's own
// chat, ranked by BM25. The trigram tokenizer matches any run of three or more
// characters, so Chinese needs no word splitting; shorter words fall back to LIKE.
// The index is derived from the Session logs: a part catches up when it is read, an
// ended part is sealed once it is complete, and deleting the file only costs a
// rebuild. Without SQLite, read_own_chat scans the logs as before.
```

`termQuery`（`src/host/chat-index.js:25-43`）按长度分流：≥3 字符的词走 FTS5 短语匹配 + `rank` 排序，<3 字符的词退化成 `LIKE ... ESCAPE` 过滤。trigram 分词器让中文不需要分词——这一点对中文用户是刚需。

**token 估算**（`src/host/text.js:33-38`）：

```js
// An upper bound: a CJK character is about one token, other text about a third.
export const estimateTokens = (text) => {
  let tokens = 0
  for (const char of text) tokens += char.codePointAt(0) > 0x2e7f ? 1 : 0.34
  return Math.ceil(tokens)
}
```

**时间注入不与 DSH 重复**（`src/host/time-context.js:18-26`、`37-44`）：监听 `agent/pre-step`，先检查 DSH 自己的 `sessionProjections` 有没有 `timeContext` 投影，再检查本步消息里有没有本插件注入的时钟消息，都没有才追加：

```js
const text = `Current time: ${formatter.format(now)} (${zone}).`
```

默认间隔 `config.timeRefreshIntervalMs ?? 600_000`（`src/host/time-context.js:8`），即 10 分钟。

---

## 1c. 组 C / 组 D 细读笔记

### C1. Bot、群聊、以及两者与 Session 的对应关系

一个 Bot 就是一个 DSH 根 Session，`roster.js` 建 Bot 时先建 Session 再写状态（`src/host/roster.js:67`、`src/host/roster.js:69-82`），失败时**归档那个已经建好的 Session**，不留孤儿（`src/host/roster.js:109-119`）：

```js
    } catch (error) {
      // The Bot's Session was already made: archive it instead of leaving an orphan.
      delete state.bots[id]
      state.mainBotIds = state.mainBotIds.filter(other => other !== id)
      rt.chatOwners.delete(id)
```

模型的固定时机也在这一步（`src/host/roster.js:64-65`）：

```js
    // The model is fixed at creation, so a later change of the DSH default leaves it alone.
    const modelRef = model ? await rt.resolveModel(model) : pickModel ? undefined : await rt.defaultModel()
```

**Bot 与群聊不是两层包含关系，而是「一个 Bot 在多个群里各有一段独立会话」**。`groups.js` 为每个成员在每个群里单独建一个 Session，命名带上双方（`src/host/groups.js:120-130`）：

```js
  async function groupSessionFor(room, member) {
    room.sessions ??= {}
    const known = room.sessions[member.id]
    if (known !== undefined) {
      await rt.ensureCapabilities(known)
      return { id: known, brief: undefined }
    }
    const id = await rt.createSession(`${member.name} · ${room.name}`)
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
```

这条 `rt.groupOwners` 就是 `store.js` 里三张索引表之一；`rt.selfOf(sessionId)` 因此能把任意 Session 还原成「哪个 Bot 在哪个群」。`src/host/prompt.js:42-52` 正是靠它做身份注入——群 Session 渲染的就是它自己 Bot 的文本，所以两者共享同一份缓存前缀：

```js
  // A group Session renders exactly its Bot's text, so both share one cached prefix.
  const promptFor = (id) => {
    const self = rt.selfOf(id)
    const bot = rt.botOf(self)
```

而群聊自己的那个 Session 不渲染任何 Bot 身份，只渲染中转指令（`src/host/prompt.js:55-61`）：

```js
    const room = rt.roomOf(id)
    if (room !== undefined) {
      return [
        '# Group chat relay',
        'This conversation is a group chat between the user and several Bots. You are only the relay, not a participant.',
```

### C2. `agents.js` —— 团队里的「非 Bot」入口

DSH Agent 是与 Bot 并列但**不是 Bot**的一个普通 dsh 入口（`src/host/agents.js:1-3`）。它必须被摘掉团队工具，否则它就能操纵整个名册。做法是 `agent.ctx.tools.restrict({ deny })`，且**只 deny 这个 profile 确实提供的名字**（`src/host/agents.js:51-53`）：

```js
    // Unknown names make restrict() throw, so only deny what this profile serves.
    const known = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
    const deny = TEAM_TOOLS.filter(name => known.has(name))
```

失败要重试，因为「空列表」和「还没有 restrict 钩子」是两种不同的未就绪（`src/host/agents.js:54-58`）：

```js
    // An empty list can mean the schemas are not up yet, and a missing restrict
    // hook means the Agent is still being put together; both retry.
    if (deny.length === 0 || typeof agent.ctx?.tools?.restrict !== 'function') {
      scheduleRetry(agent)
      return
    }
```

重试是 5 秒一次的 `setInterval`，且 `retryTimer.unref?.()`（`src/host/agents.js:27-33`、`src/host/agents.js:38-43`）——**不让一个后台定时器拖住进程退出**，这是 DSH 插件里反复出现的写法。

### C3. `groups.js` —— 群聊的四个不变量

1. **房间日志有界且有序号**（`src/host/groups.js:44-47`），只保留最近 `ROOM_LOG_MAX = 60` 条（`src/host/groups.js:26`）：

```js
const appendRoom = (room, line) => {
  room.seq += 1
  room.log = [...room.log, { ...line, seq: room.seq }].slice(-ROOM_LOG_MAX)
}
```

2. **每个成员只看到自己没看过的**，且自己的发言不再回灌（`src/host/groups.js:49-54`）：

```js
// A member's own lines are already in its Session, so only the others' are news.
const unseenLines = (room, memberId) => {
  const since = room.seen[memberId]
  if (since === undefined) return room.log.slice(-ROOM_FIRST_LOOK)
  return room.log.filter(line => line.seq > since && line.botId !== memberId).slice(-ROOM_DELTA_MAX)
}
```

3. **模型爱模仿转写格式**，所以剥掉自己名字的前缀，并把 `[PASS]` 当作弃权（`src/host/groups.js:65-67`）：

```js
// Models often echo the transcript format ("Name: …") despite the instruction.
export const stripOwnName = (name, text) => text.replace(new RegExp(`^\\s*\\**${escapeRegExp(name)}\\**\\s*[:：]\\s*`), '').trim()
export const isPass = text => text === '' || /^\s*[[【(（]\s*pass\s*[\]】)）]|^\s*pass\s*[.。!！]?\s*$/i.test(text)
```

4. **群 Session 的模型调用被整体接管**，不由模型自己决定调哪个工具（`src/host/groups.js:652-655`）：

```js
  // A group chat's own Session never consults the model: models drift from "only call
  // group_relay" (they message one member directly when the user names it), so the
  // relay step is synthesized here. Auxiliary calls such as titles still reach the model.
  ctx.on('llm/stream', (options, next) => {
```

它直接在流上吐出一次伪造的 `group_relay` 工具调用（`groups.js` 末尾 `yield { type: 'tool-call-delta', index: 0, id, name: 'group_relay', argumentsDelta: '{}' }`），并把 `finish` 原因设成 `tool-calls`。**这是整份实现里最激进的一处：把「模型的一次决策」换成了确定性的代码路径。**

### C4. `capabilities.js` —— 共享能力的模型

能力库里有三种 kind：`mcp`、`skill`、`pack`。**pack 不是一种新能力，只是若干 mcp/skill 的集合**，挂载前先展开（`src/host/capabilities.js:21-26`）：

```js
    if (item.kind === 'pack') {
      for (const childName of item.items ?? []) {
        const child = library[childName]
        if (!child || !['mcp', 'skill'].includes(child.kind)) throw new Error(`Pack ${name} refers to an unavailable capability ${childName}.`)
        expanded.add(childName)
      }
```

名字规则很窄，且 `github` 被保留（`src/host/capabilities.js:8-14`）：

```js
export function validateCapabilityName(value) {
  const name = String(value ?? '').trim()
  if (name.length > 32 || !NAME.test(name) || name === 'github') {
    throw new Error('Use a capability name with lowercase letters, digits, and single hyphens; "github" is reserved.')
  }
```

`src/host/capabilities.js:5` 的 `SECRET_REFERENCE = /\$DSH_SECRET_([A-Z][A-Z0-9_]*)/g` 把能力配置和密钥系统接上：能力声明里写 `$DSH_SECRET_NAME`，挂载时替换成真值。**能力库是共享的，挂载是按 Bot 的**——`changeCapabilityAttachment` / `ensureCapabilities` 这组 `rt` 函数就是这条边界。

### C5. `secrets.js` —— 密钥的注入路径与泄露面

文件头一句话说清了全部三处出口（`src/host/secrets.js:1-3`）：

```js
// Secrets: keys the user types into a card for a Bot. A value lives only in
// secrets.json (mode 600) and in this process; Bots use it as $DSH_SECRET_<NAME> in
// their shell, tool results lose it before they are saved, and every model request
// has it replaced by [secret:<NAME>] before it leaves.
```

**短值只做整词替换**，否则一个 4 位 PIN 会在正文里到处误伤（`src/host/secrets.js:13-17`）：

```js
// A short value (a PIN, a short password) would also hit ordinary words if it were
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where it
// stands alone: no letter or digit right before or after it.
export const MIN_VALUE = 4
export const WHOLE_VALUE = 8
```

与 `connectors.js` 的分工是刻意的：GitHub token 经 MCP 请求头出站，**不进任何 Bot 的 shell**（`src/host/connectors.js:5-9`）：

```js
// The token is the GITHUB_TOKEN secret (secrets.js keeps it, redacts it, and offers it to
// the shell). It reaches GitHub only in the MCP request headers, built here in memory,
// never written to the DSH profile. A new token is shared with no Bot's shell: the tools
// do not need it there, and a Bot that reads a planted instruction in an issue could
// send it anywhere.
```

这是整个项目里**唯一一处明确以「提示注入」为理由做的权限收缩**，值得单独记住。

### D. 其余六个模块的一句话定位

| 模块 | 定位（含出处） |
|------|----------------|
| `tools.js` | 团队工具注册表；`list_bots` 一次返回 Bot 与可见群聊两段（`src/host/tools.js:54-60`），群可见性是「Main Bot 看全部，其余看自己在的」（`src/host/tools.js:35-36`） |
| `steward.js` | 检查线是**声明窗口的一个比例**而非绝对值：`check = min(floor(usable × ratio), hard)`，`HARD_SHARE = 0.95`（`src/host/steward.js:16-26`），默认窗口 500k、默认比例 0.8 |
| `models.js` | 目录缓存 10 秒 TTL（`src/host/models.js:6`）、思考档位单独缓存并在 `llm/adapters-updated` 时一并清空（`src/host/models.js:14-16`） |
| `schedules.js` | 服务是可选的：DSH 0.2.0 只在 Automation tasks bundle 打开时挂载它，所以每个端点都要报告它在不在（`src/host/schedules.js:5-6`） |
| `browser.js` | 仅桌面端；页面在应用窗口里而不在本进程，所以用长轮询通道（`browser-wait`/`browser-result`）通信（`src/host/browser.js:1-5`）；非桌面端把 `browserEnabled` 置 false 后直接返回（`browser.js` 的 `Object.assign(rt, { browserEnabled: false, ... }); return`） |
| `connectors.js` | 首个连接器是 GitHub；登录判定只问 `/user`（`src/host/connectors.js:23-24`），任何 GitHub 认的 token 都算通过 |

---

## 1d. 组 E 细读笔记

### E1. `approvals.js` —— 隐藏 Session 的审批由谁作答

问题本身写在文件头（`src/host/approvals.js:1-4`）：

```js
// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card; its requests are only noted, so
// the team view can say who is waiting.
```

拦截点带 `{ prepend: true }`，**必须排在 DSH 自己的应答者之前**（`src/host/approvals.js:14-15`）：

```js
  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  ctx.on('approval/request', (request, next) => {
```

私聊与群聊在这里分道（`src/host/approvals.js:35-41`）——私聊 `next()` 交回 DSH，群聊则返回一个悬挂的 Promise，等群界面上的用户点选：

```js
    if (owner === undefined) return Promise.resolve(next()).finally(settled)
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!pending.has(id)) return
        settled()
        resolve(outcome)
      }
```

中止信号也要接（`src/host/approvals.js:42-43`），否则用户取消后这条审批永远挂着：

```js
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
```

结果映射只有两个（`src/host/approvals.js:7`）：`{ allow: 'allowed-once', reject: 'rejected' }`。

### E2. `memory.js` —— 记忆的目录布局与「可回溯」设计

`memory.js` 是全项目第二大的宿主模块（79,091 B / 1,362 行），也是唯一一个**不改会话、只改文件**的模块。它管的是「一个 Bot 跨所有对话记住什么」。

目录布局本身就是设计说明（`src/host/memory.js:6-12`）：

```js
//   <home>/memory/bots/<botId>/   a Bot's own MEMORY.md and topics
//   <home>/memory/team/           what every Bot reads
//   <home>/memory/journal.jsonl   every change, with the line before and after
//   <home>/memory/snapshots/      the memory section each Session froze
//   <home>/memory/summaries/      the memory panel's summary per Bot
//   <home>/memory/archive/        the memory of deleted Bots
//   <home>/memory/reviewed.json   how far the memory review has read each conversation
```

**格式借用了一个外部规范**（`src/host/memory.js:1-4`）：

```js
// Memory: what a Bot keeps across all its conversations, as Markdown in the Agent
// Memory Repo format (github.com/AgentMemoryRepo/agentmemoryrepo): one entry per
// bullet line ending in `[key: value; …]` metadata, and a MEMORY.md entry point whose
// `## Index` links topic files as [[topic]].
```

**两个 MEMORY.md 会随每个请求上行，所以大小有硬上限**（`src/host/memory.js:32-34`、`:35`）：

```js
// Fixed sizes, in characters. Both MEMORY.md files ride in every request of every
// part, so together they stay near 8,000 characters, a few thousand tokens. A topic is
// read whole in one recall. An entry holds one fact.
export const MEMORY_LIMITS = { entry: 300, main: 4_000, topic: 16_000, topics: 40 }
```

四个数各自对应一种失败：条目太长就不是「一条事实」；两个 4,000 字是提示预算；16,000 字是「一次 recall 读得完」；40 个 topic 是目录爆炸线。超限时报错文本直接教用户怎么办（`src/host/memory.js:512`）：

```js
    if (text.length > MEMORY_LIMITS.entry) return `An entry holds at most ${MEMORY_LIMITS.entry} characters; this one has ${text.length}. Keep one fact per entry, or save the details as several entries in a topic.`
```

**为什么用 journal 而不是版本控制**（`src/host/memory.js:14`）：

```js
// Files change in place and the journal keeps what each change replaced, so history
```

每次改动都 append 一条 JSON 行，**记下改前与改后的整行**（`src/host/memory.js:461-463`）：

```js
  async function journal(record) {
    await appendFile(journalPath, `${JSON.stringify({ time: new Date().toISOString(), ...record })}\n`, 'utf8')
```

四种操作各有自己的记录形状：`add` 只记 `after`、`replace` 记 `before` + `after`、`remove` 记 `before`（`src/host/memory.js:568`、`:599`、`:621`）、`archive` 记归档去向（`src/host/memory.js:641`）。**这就是「可回溯」的全部机制**——没有 diff 算法，只有「这一行原来是什么」。

**提示词逐字节稳定靠 snapshot 冻结。**这是本模块最关键的一条，也是它和 `parts.js` 的接口（`src/host/memory.js:19-22`）：

```js
// at a time, in the process that holds the team (store.js). Each Session freezes its
// memory section the first time it renders, so its prompt stays byte-stable and the
// provider's prefix cache holds; a fresh part, or a checkpoint (which breaks the cache
// anyway), freezes it anew.
```

实现是「每个 Session 一个快照文件 + 一张内存 Map」（`src/host/memory.js:676-703`）：

```js
  const frozen = new Map()
  const snapshotPath = sessionId => join(root, 'snapshots', `${safeId(sessionId)}.md`)
  function sectionFor(sessionId) {
    if (sessionId === undefined) return ''
    const bot = rt.botOf(rt.selfOf(sessionId))
    if (bot === undefined) return ''
    // A section frozen under another role (made a Main Bot or a group admin since, or no
    // longer one) is frozen again, so the rule it states matches what the tools allow.
    const rule = teamRule(rt.isMain(bot.id), writesTeam(bot.id))
    const kept = frozen.get(sessionId)
    if (kept !== undefined && kept.includes(rule)) return kept
    const path = snapshotPath(sessionId)
    let text = existsSync(path) ? readText(path) : ''
    if (text === '' || !text.includes(rule)) {
      text = memorySection(bot)
      if (rt.readOnly() === undefined) {
        try {
          mkdirSync(dirname(path), { recursive: true })
          writeFileSync(`${path}.tmp`, text, 'utf8')
          renameSync(`${path}.tmp`, path)
        } catch (error) {
          rt.warn('ds-bot: memory snapshot for %s not saved: %s', bot.name, error)
        }
      }
    }
    frozen.set(sessionId, text)
    return text
  }
```

注意 `kept.includes(rule)` 这个判据：**冻结的是文本，但失效的判据是「角色规则还在不在里面」**。一个 Bot 从普通成员升成 Main Bot 后，旧快照里那句「团队记忆由 Main Bot 写」就不适用了，于是重新冻结——**但只在角色真变了时才重冻**，其余情况一律复用，缓存才守得住。

**写入权限在写的那一刻才检查，不在排队时。**`src/host/memory.js:471-482`：

```js
  // Checked when the write runs: a Bot deleted after the write was queued has its
  // memory archived already, and writing would bring the folder back; nor does a
  // deleted Bot write the team memory, or one no longer Main Bot or group admin.
  const writable = (scope, actor) => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(`Memory cannot change now: ${readOnly}`)
    const botActor = actor?.id === 'user' ? undefined : actor?.id
    const gone = [scope.kind === 'bot' ? scope.botId : undefined, botActor].some(id => id !== undefined && rt.botOf(id) === undefined)
    if (gone) throw Object.assign(new Error('That Bot has been deleted'), { code: GONE })
    const denied = botActor === undefined ? undefined : writeDenied(scope, botActor)
    if (denied !== undefined) throw Object.assign(new Error(denied), { code: DENIED })
  }
```

规则本身写在注释里（`src/host/memory.js:485-487`）：

```js
  // Who may do what. A Bot reads and writes its own memory and reads the team's;
  // Main Bots and the admins of a group also write the team's; Main Bots read and
  // write every Bot's. The user may do everything from the memory panel.
```

越权时给出的不是「禁止」，而是一条**可执行的替代路径**（`src/host/memory.js:502`）：

```js
    if (scope.kind === 'team') return writesTeam(botId) ? undefined : 'Only Main Bots and group admins write the team memory. Tell a Main Bot with message_bot what the team should know.'
```

**记忆不依赖 Bot 主动去记。**这是本模块的第三个关键决定（`src/host/memory.js:17-18`）：

```js
// turn, and the memory panel for the user, go through the same path. The review is
// what keeps memory from depending on a Bot deciding to call remember.
```

三个工具走同一条写路径（`src/host/memory.js:773` `remember`、`:805` `forget`、`:838` `recall`），用户从记忆面板改一条也走同一条。**「review」是回合结束后的自动审阅**，它有一组自己的预算常量（`src/host/memory.js:54-71`）：`REVIEW_FIRST_LINES = 6`、`REVIEW_CONTEXT_LINES = 4`、`REVIEW_CHANGES_MAX = 8`、`REVIEW_PASSES_MAX = 4`、`REVIEW_GROUP_LAG = 30`。它读的是对话的前几行 + 上下文，一次最多改 8 条、最多跑 4 轮，群聊里滞后 30 条才追——**全是「别让自动审阅吃掉上下文」的上限**。

**关掉记忆是一个显式的降级路径**，而不是崩溃（`src/host/memory.js:405-412`）：`memoryEnabled: false`、`renewMemory: () => {}`、`memoryEndpoint` 直接抛 `'Memory is turned off on this host'`。`memoryReview` 也可单独关（`src/host/memory.js:415`：`const reviewOn = config.memoryReview !== false`）。

**密钥过滤有两层正则。**`looksLikeKey` 与 `looksLikeSecret` 在写入前拦下密码、身份证号、token 一类内容（`src/host/memory.js:193`、`:214`），配套的 `PASSWORD_GIVEN` / `PASSWORD_AFTER` / `ID_GIVEN` 三条正则（`src/host/memory.js:202`、`:205`、`:208`）带否定前瞻，专门排除「密码管理器」「密码策略」这类误报。

### E3. `parts.js` —— 分片是「一次小模型决策 + 两种执行」

文件头把整条链路说完了（`src/host/parts.js:1-15`）：回合结束时上下文越过检查线 → `steward.js` 读最新消息判定 → 未完工则原地压缩成检查点（保留发给 Bot 的原文），到停点则换新 Session 并整篇归档旧的。**交接笔记在空闲时写，且用与 Bot 自身请求相同的前缀，以便命中 provider 缓存**：

```js
// and the old one is archived whole. For that the Bot writes a handoff note while
// idle, from the same prefix as its own requests, so the provider serves it from
// cache and nobody waits.
```

交接笔记的提示词明确要求「不要回答上面的消息」（`src/host/parts.js:329-330`）：

```js
const HANDOFF_PROMPT = [
  'You are now writing a handoff note to yourself. This request comes from DS Bot, not from the user: do not answer or continue the messages above. Your conversation is long, so it moves on to a fresh conversation now. ...
```

并处理了「笔记的笔记」这种递归退化（`src/host/parts.js:339`）：

```js
  '- If the conversation starts with a "[Handoff · part N]" message, it holds your previous note, and a "[Checkpoint N]" summary holds a condensed stretch of this part. Merge them: keep what is still true, drop what is stale, and add what is new. Nothing in them survives unless this note keeps it.',
```

包体以 `[Handoff · part N]` + `## Handoff note` 开头（`src/host/parts.js:572-578`），新篇用 `fresh.followup(...)` 投递（`src/host/parts.js:776`）。**硬线与检查线分开**（`src/host/parts.js:863`：`const hard = tokens >= lines.hard`），越过硬线时即便笔记失败也带着上一份笔记继续走（`src/host/parts.js:734`）。

### E4. `images.js` —— 为缓存而做的读图

`src/host/images.js:1-4` 一句话说明了取舍：

```js
// Images for text-only models. Every model may take images; before a Session request
// reaches a model that cannot read them, each image becomes text from a vision model.
// Texts are kept per attachment, so later requests repeat the same words and the
// prompt cache still hits.
```

缓存是**按附件**存盘并在超限时 FIFO 淘汰（`src/host/images.js:69-79`）：

```js
ocrCache = new Map(Object.entries(JSON.parse(await readFile(ocrPath, 'utf8'))))
...
while (ocrCache.size > OCR_CACHE_MAX) ocrCache.delete(ocrCache.keys().next().value)
```

参数集中在 `src/host/constants.js:13-20`：`OCR_PROMPT`、`OCR_TIMEOUT_MS = 120_000`、`OCR_RETRY_MS = 120_000`、`OCR_CACHE_MAX = 500`。读图这一次调用本身也被计量并打标（`src/host/images.js:98`）：

```js
    messages: rt.tagUsage([{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: OCR_PROMPT }] }], { sessionId, kind: 'image' }),
```

### E5. `usage.js` —— 两条计量来源，一个归属规则

`src/host/usage.js:3-8` 说明了为什么要两条：

```js
// A call that a Session logs (one assistant settlement per attempt) is read from that
// log, so calls made before this ledger existed count too. A call outside every log (a
// checkpoint, a handoff note, the steward, an image reading, DSH titles and compaction)
// is metered while it streams, from the time DS Bot runs. Rows go to usage.sqlite; like
// the chat index it is derived from the logs, and deleting it loses only the metered
// calls and the names of deleted Bots.
```

归属只有三类（`src/host/usage.js:10-12`）：某个 Bot（含其群 Session、更早的分片、以及在其下 fork/spawn 的 Session）、群聊自己的 Session、其余归 `"other"`。库落在 `join(home, 'usage.sqlite')`（`src/host/usage.js:230`），对外只暴露 `usageView` / `tagUsage` / `carryUsageTag`（`src/host/usage.js:593`）——**打标是显式传递的，靠猜 Session 归属会错**。

### E6. 两条更新链：`update.js` 与 `dsh-update.js`

`update.js` 管自己（`src/host/update.js:1-4`）：对比包版本与安装来源上的最新版，用户确认后经 DSH 的插件管理器重装，**本地/link 安装永不提示**。两个 registry 常量（`src/host/update.js:9-10`）与 10 分钟 TTL（`src/host/update.js:12`）：

```js
export const OFFICIAL_REGISTRY = 'https://registry.npmjs.org/'
export const MIRROR_REGISTRY = 'https://registry.npmmirror.com/'
// Every window that opens asks; within this long the last answer stands.
export const CHECK_TTL_MS = 10 * 60_000
```

镜像的判定很保守（`src/host/update.js:80`）：只有 `first === OFFICIAL_REGISTRY` 或在 fallbacks 里才算公开源。

`dsh-update.js` 管 DSH 本体，规则更严（`src/host/dsh-update.js:1-6`）：**已发布的 DS Bot 声明它验证过的 DSH 版本，只提供那一版**：

```js
// DSH updates: a released DS Bot may name the DSH release it was verified
// against (`dsBot.verifiedDsh` in package.json); a release that names none
// offers nothing. The newest released bot wins: offering that version and
// nothing newer keeps the update path away from DSH releases we have not
// checked.
```

打包应用与 npm 安装的差别也在这里：npm 装的用 `npm i -g` 换，打包应用的运行时在它自己的 bundle 里，只能由它自己的更新器搬（`src/host/dsh-update.js:5-7`）。**「最新发布的 Bot 胜出」这条是刻意的——不是取最新的 DSH，而是取最新的、被验证过的那一版。**

### E7. `channel.js` —— 一个端点、一种错误分类

浏览器侧只有一条固定路由（`constants.js`：`export const ROUTE = '/api/bot'`），注册在共享 `/api` 通道上，用 Session cookie 认证（`src/host/channel.js:327-335`）：

```js
  // An exact Fetch route on the shared /api channel; the browser authenticates with its session cookie.
  ctx.effect(() => ctx.connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
```

错误分类是这里唯一值得单独记住的规则（`src/host/channel.js:11-14`）：

```js
// Programming and file system errors are DS Bot's own faults, logged with their stack;
// any other error is a refusal whose message is meant for the user.
const isInternal = error => error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  || error instanceof SyntaxError || (typeof error?.code === 'string' && /^E[A-Z_]+$/.test(error.code))
```

即：`TypeError`/`ReferenceError`/`RangeError`/`SyntaxError` 或 `E*` 系统码 → 内部故障，记日志带栈；其余 → 拒绝，消息直接给用户看。界面语言也在这里读（`src/host/channel.js:24`：`rt.uiLanguage = () => ...`），`LANGUAGES` 只映射 `zh` 与 `en`（`src/host/channel.js:7`）。

---

## 2. 客户端模块清单

`src/client/` 共 **55 个文件**，合计 816,199 B，无子目录。分类依据是**它在界面上负责哪一块**，而不是它导出什么函数——同一个类里的文件改一处时通常一起改。依据来源是每个文件的头注释（`Get-Content -TotalCount 14`）、导出名、以及被谁 import。

| 类 | 名字 | 文件数 | 合计字节 | 一句话 |
|----|------|--------|----------|--------|
| A | 装配与基础设施 | 10 | 122,459 | 不画任何东西：插件怎么挂上壳、状态从哪来、错误往哪记、文案怎么翻 |
| B | 视觉系统 | 7 | 172,776 | 角色造型、配色、主题、动效与全部 CSS——改观感只动这一类 |
| C | 外壳注入 | 4 | 71,310 | 把 DS Bot 自己的侧栏/头部/输入框画进 DSH 的壳里 |
| D | 对话区渲染 | 8 | 100,546 | 对话流里的每一样东西：气泡、工具格、问题卡、运行态 |
| E | 浮层、面板与菜单 | 13 | 214,909 | 盖在对话上的东西：命令面板、设置抽屉、Bot 面板、浏览器、语音 |
| F | 设置页与计量 | 13 | 134,199 | 设置对话框里的每一页，以及用量页的取数与汇总 |

**A. 装配与基础设施（10）** —— 不渲染界面，或只提供最底层的原语；删掉任何一个整个插件起不来。

| 文件 | 字节 | 职责 |
|------|------|------|
| `index.js` | 52243 | 插件入口：装配所有替换（replacements）、注册主题与角色、把各模块的 CSS 装进壳 |
| `surface.js` | 818 | surface 模式 `bot`/`agent`/`plain`：决定哪些替换生效——整块团队界面还是 DSH 原生界面 |
| `storage.js` | 3001 | 浏览器存储键名表 `STORAGE`，含旧键 `dsh-bot-team` / `dsh-bot` 的一次性迁移 |
| `sources.js` | 2566 | `createSource`：给 inject `hooks` 舱用的极简可观察源（`getSnapshot`/`subscribe`/`set`） |
| `api.js` | 1926 | 唯一的前端→宿主调用口：`POST api/bot`，把 `bot/refused` 等拒绝翻译成给人看的话 |
| `diagnostics.js` | 3734 | 浏览器侧错误环形缓冲（最多 30 条，5 分钟内重复只计数），供反馈页组报告 |
| `flat-transcript.js` | 1102 | 把 `ui-chat` 的视图模式钉在 `verbose`（对话流不做可折叠步骤组） |
| `text.js` | 11318 | 文本工具：`@` 提及切分（`linkMentions`）、时间/用量/摘要的解析与格式化 |
| `i18n.js` | 45794 | 界面文案与 `zh` 对照表；键就是英文原文，渲染时查表，切换语言靠重渲染 |
| `dsh-offer.js` | 777 | 更新卡片要不要显示 DSH 那一行：npm 装 vs 打包应用两套判据 |

**B. 视觉系统（7）** —— DS Bot 自己的设计系统，与业务无关，换一套皮肤只动这一类。

| 文件 | 字节 | 职责 |
|------|------|------|
| `styles.js` | 107268 | 全部 CSS 字符串：`SHELL_CSS`（壳层）与 `CONVERSATION_CSS`（对话层）两套 |
| `themes.js` | 6523 | 主题注册表：每个主题给明暗各八色，派生全部 `--bt-*` 变量与壳 token |
| `inks.js` | 2289 | 墨色表 `INKS`（明/暗两值）+ 渐变 + 亮度计算 |
| `characters.js` | 29191 | 55 个角色造型表：100 单位方盒里的分层 SVG 路径、眼睛挖孔、遮罩缓存 |
| `mark.js` | 9613 | 把角色/头像渲染成头像标，并按 Bot 的运行态选动作（`idle`/`thinking`/…） |
| `motion.js` | 10545 | 阻尼弹簧采样成 CSS `linear()` 缓动；`useGlide`/`useMorph`/`useLinger` 等钩子 |
| `icons.js` | 8876 | 内联 SVG 图标集，每个都是无依赖的 `h('svg', …)` |

**C. 外壳注入（4）** —— 替换 DSH 壳自己的那几块 DOM，都通过 inject 的替换点接进去，彼此不 import 对方。

| 文件 | 字节 | 职责 |
|------|------|------|
| `sidebar.js` | 40723 | 团队侧栏：Bot/群聊列表、未读、置顶、搜索入口、账号与设置入口、更新按钮 |
| `header.js` | 11814 | 对话头部的胶囊：头像、标题、运行态、记忆变更提示、详情抽屉的开关 |
| `composer.js` | 8200 | 输入框的两个附加件：听写麦克风与语音对话按钮（草稿为空时替掉发送键） |
| `at-menu.js` | 5587 | 输入框里敲 `@` 弹出的菜单：Bot 组与「引用一个对话」，含「所有人」的多种写法 |

**D. 对话区渲染（8）** —— 对话流内部的渲染单元，大多从宿主推来的事件流里读数据。

| 文件 | 字节 | 职责 |
|------|------|------|
| `cells.js` | 39725 | 对话流的基本单元库：气泡、工具格、系统行、提醒、Markdown 文本 |
| `activity-row.js` | 8523 | 对话尾部的运行态行：Bot 的头像 + 一句闪动的短语，回复开始流式时让位 |
| `member-status.js` | 14376 | 群成员在做什么：群输入框上方的成员行、Bot 输入框上方的群行、待批的审批 |
| `questions.js` | 10310 | 问题卡：`ask_user` 卡（不阻塞）与阻塞式 `ask_user_question`（接管输入框） |
| `user-message.js` | 7651 | 用户自己的消息：先切出 `@Bot` 再交给 DSH 画，避免「@新 Bot」被切成文件引用 |
| `turn-reasoning.js` | 934 | 一个 Turn 里已定格的推理，只在第一个有推理的步骤上显示一次 |
| `exchange.js` | 3041 | 「Bot 之间的往来」弹层：成对的收发气泡 |
| `approval-notices.js` | 1622 | 窗口在后台时，为新出现的审批发系统通知（不主动申请权限） |

**E. 浮层、面板与菜单（13）** —— 盖在对话之上，多数走 `createPortal` 挂到 body，退出动画靠自己维持一小段时间。

| 文件 | 字节 | 职责 |
|------|------|------|
| `overlays.js` | 3463 | 浮层的总装：命令面板、新对话、往来、语音、设置、右键菜单、Bot 面板、记忆 |
| `overlay-hooks.js` | 1265 | `useEscape`：Escape 只关最新一层浮层，抽屉上的对话框不会把抽屉一起关掉 |
| `palette.js` | 8502 | 搜索即命令面板：560px 对话框，按名字/角色匹配 Bot 与群，按文本匹配历史消息 |
| `new-chat.js` | 10310 | 新对话：先选管理员再选成员；或直接开一个与单个 Bot 的对话 |
| `create-bot.js` | 6680 | 建 Bot 表单：随机造型、名字去重、起始模型 |
| `context-menu.js` | 5599 | 列表项的右键菜单：置顶、未读、改名、复制、隐藏、删除 |
| `details-drawer.js` | 16832 | 详情抽屉：一个 Bot 或一个群的设置摘要、模型、记忆、日程、成员状态 |
| `model-menu.js` | 18450 | 模型选择器（详情面板与设置页共用），以及没有模型时聊天开场的那条提示 |
| `browser-pane.js` | 35956 | 右侧 Bot 面板：详情页与浏览器页的标签条、工具栏、webview 的矩形上报 |
| `bot-browsers.js` | 23244 | Bot 的浏览器：每个 Bot 一个 Electron webview 分区，页面统一挂在 body 层 |
| `read-page.js` | 4191 | `read_browser` 的页面读取脚本；要被 `Function.toString` 序列化进 webview，只能用自身局部名 |
| `voice.js` | 11246 | 语音对话：听 → 发送 → 朗读回答 → 再听 |
| `speech.js` | 5343 | 语音识别适配层：DSH 的本地 SenseVoice 插件优先，浏览器自带识别兜底 |

**F. 设置页与计量（13）** —— 设置对话框里的每一页，以及用量页的取数与汇总。

| 文件 | 字节 | 职责 |
|------|------|------|
| `settings.js` | 15638 | 设置对话框的骨架与路由：外观、Bot、群、能力、连接器、密钥、用量、反馈、关于 |
| `bot-settings.js` | 19801 | 单个 Bot 的设置页：造型、颜色、名字、角色、指令、模型、能力、日程、记忆 |
| `group-settings.js` | 11954 | 群的设置页：名字、发言模式（admin/everyone）、成员、管理员 |
| `capability-settings.js` | 10066 | 共享能力（MCP server / skill / pack）的编辑表单与状态显示 |
| `connectors.js` | 4679 | 外部服务连接器（首个是 GitHub）的卡片与 token 输入 |
| `secret-card.js` | 24824 | 密钥卡与密钥页：用户输入、Bot 永不可读、已存密钥的清单与授权范围 |
| `memory-panel.js` | 16193 | 记忆对话框：模型写的摘要、条目列表、以及「问一句或改一条」 |
| `schedules.js` | 17996 | 定时任务：设置页、Bot 设置卡、详情面板三处共用一个视图，30 秒轮询一次 |
| `about.js` | 9643 | 设置 → 关于：版本、DS Bot 与 DSH 的更新、仓库链接 |
| `feedback.js` | 11640 | 设置 → 反馈：把诊断信息填进 GitHub issue、看最近错误、下载日志 |
| `usage-page.js` | 52401 | 用量页：按小时/日/周/月汇总，按 Bot 或按模型堆叠排名，可下钻到单个归属 |
| `usage-data.js` | 7199 | 用量页的取数与纯计算：时段定义、时区键、汇总、紧凑数字格式化 |
| `bot-draft.js` | 1043 | 建 Bot 表单的纯函数（名字去重、起始模型），特意不引 React 以便单测 |

**计数核对**：10 + 7 + 4 + 8 + 13 + 13 = **55**，与 `src/client/` 下文件总数一致；分类数 6，落在 5–8 之间。

---

## 3. 五个关键机制

> 第 1 节是横向的（谁负责什么），这一节是纵向的：一件事从入口走到出口，经过哪些模块。每处引用都附代码原文，原文逐字取自源文件。

### 3.1 Bot 与 root Session 的对应关系怎么建立与持久化

**问题**：一个 Bot 有私聊 Session，在每个群里还各有一个隐藏 Session，长对话还会换篇（新 Session）。系统要在任意时刻回答「这个 Session 是谁在说话」，而且历史篇也要答得出来。

**入口**只有三个取用器（`src/host/store.js:281`）：

```js
  const botOf = id => (id === undefined ? undefined : state.bots[id])
  const roomOf = id => (id === undefined ? undefined : state.rooms[id])
  const isMain = id => id !== undefined && state.mainBotIds.includes(id)
```

**不靠遍历，靠三张内存索引表**，每次状态变化后重建（`src/host/store.js:295`）：

```js
  /** @type {Map<string, string>} */
  const chatOwners = new Map()
  /** @type {Map<string, {botId:string, roomId:string}>} */
  const groupOwners = new Map()
  /** @type {Map<string, {botId:string, roomId?:string}>} */
  const pastOwners = new Map()
  const chatOf = botId => botOf(botId)?.sessionId ?? botId
  const indexSessions = () => {
    chatOwners.clear()
    groupOwners.clear()
    pastOwners.clear()
    for (const bot of Object.values(state.bots)) {
      for (const segment of bot.segments ?? []) pastOwners.set(segment.sessionId, { botId: bot.id })
      chatOwners.set(chatOf(bot.id), bot.id)
    }
```

**为什么三张表而不是一张**：区分「现在」和「过去」。`src/host/store.js:321` 把三者按优先级串起来：

```js
  const selfOf = id => chatOwners.get(id) ?? groupOwners.get(id)?.botId ?? pastOwners.get(id)?.botId
  // A Session where the Bot speaks now, as opposed to an archived segment.
  const isBotSession = id => chatOwners.has(id) || groupOwners.has(id)
```

**锚点是「Bot 的 id 就是它第一篇 Session 的 id」**（`src/host/store.js:290-294`）：

```js
  // Segments. A long conversation moves to a fresh Session at a context line (see
  // parts.js). A Bot's id is the Session id of its first own-chat segment and
  // never changes; `bot.sessionId` is the current one. Earlier segments, of the own
  // chat (`bot.segments`) and of each group Session (`room.segments[botId]`), are
  // archived and stay readable.
```

建立这个不变量的地方是建 Bot——先拿 Session id，再以它为键写记录（`src/host/roster.js:67-69`）：

```js
    const id = await createSession(cleanName)
    try {
      state.bots[id] = {
        id,
```

于是 `chatOf(botId)` 在 `bot.sessionId` 缺失时回退到 `botId` 本身（`src/host/store.js:301`），正是这条不变量的兜底。**群 Session 按需创建**，创建时就写进 `groupOwners`，不等下次重建索引（`src/host/groups.js:127`）：

```js
    const id = await rt.createSession(`${member.name} · ${room.name}`)
    room.sessions[member.id] = id
    rt.groupOwners.set(id, { botId: member.id, roomId: room.id })
```

**持久化**：整个映射的唯一真相是 `state.json`（`src/host/store.js:14-15`）：

```js
const STATE_VERSION = 1
const EMPTY = () => ({ version: STATE_VERSION, mainBotIds: [], bots: {}, rooms: {}, agents: {}, capabilities: { items: {} }, exchanges: [], exchangeTurns: {}, questions: {}, prefs: {}, revision: 0 })
```

写盘是原子替换（`src/host/store.js:246-268`）：写 temp → 两次 `ensureLock()` → `rename`，丢锁抛 `code = 'ELOCKLOST'`。三张 Map 是**派生视图，不持久化**，进程启动时从 `state` 重建。

### 3.2 群聊与 Bot 互发消息（roster / groups / delivery / mentions 的关系）

**问题**：一条消息可能来自用户、另一个 Bot、或 DS Bot 自己（重启续跑、handoff 包、定时任务）。接收方看到的是同一串文本，必须能从文本本身分辨来源和语义。

**唯一入口**是 `deliver`（`src/host/delivery.js:41`），所有投递都经过它，没有第二条路。

**来源头是拼在正文前面的纯文本，不是结构化字段**（`src/host/delivery.js:15-28`）：

```js
  const headerFor = (role, fromName, roomName, audience, note = 'new message', deferred = false, { resumed = false, retried = false } = {}) => {
    if (deferred) return `[Message from ${fromName} · you read it during your last task; answer it now]`
    if (retried && role !== 'room') return '[Your last reply wrote a tool call as text, so nothing ran]'
    if (resumed && role === 'resume') return '[DeepSeek Harness restarted while you were working]'
    if (resumed && role !== 'room') return `[Message from ${fromName} · DeepSeek Harness restarted while you were working on it]`
    if (role === 'reply') return `[Reply from ${fromName}]`
    if (role === 'stopped') return `[Stopped by ${fromName}]`
    if (role === 'room') return `[Group chat "${roomName}" · ${note}]`
    if (role === 'report') return `[Group chat "${roomName}" · replies to your post]`
    if (role === 'kickoff') return '[Bot team setup]'
    if (role === 'secret') return '[Secret card]'
    if (audience === 'user') return `[Message from ${fromName} · the user sees your reply here]`
    return `[Message from ${fromName}]`
  }
```

顺序即优先级：`deferred` > `retried` > `resumed` > 按 role 分派。role 共 10 种：`request` / `reply` / `stopped` / `room` / `report` / `kickoff` / `secret` / `resume` / `retry` / `post`。

**同一个来源同时进两条通道**——结构化 `source` 给程序读，纯文本头给模型读（`src/host/delivery.js:48`）：

```js
    const source = {
      kind: SOURCE_KIND,
      form: 'relay',
      role,
      exchangeId,
      senderName: fromName,
      hop,
      ...(fromId ? { senderSessionId: fromId } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(roomId ? { roomId } : {}),
      ...(audience === 'user' ? { audience } : {}),
      ...(deferred ? { deferred: true } : {}),
      ...(resumed ? { resumed: true } : {}),
      ...(retried ? { retried: true } : {}),
      ...(askedBy ? { askedBy } : {}),
      ...(fromRoomId ? { senderRoomId: fromRoomId } : {}),
    }
```

`src/host/delivery.js:47` 交代了这种展开写法的原因：

```js
    // Session events reject `undefined` members, so optional fields are omitted instead.
```

**只有一部分 role 进「团队往来」记录**（`src/host/delivery.js:31`）：

```js
  // Roles recorded as team exchanges.
  const EXCHANGE_ROLES = new Set(['request', 'reply', 'stopped'])
```

且带 `deferred`/`resumed`/`retried`/`resent` 的投递不重复记——它们的往来在第一次到达时已经记过（`src/host/delivery.js:65`）：

```js
    if (EXCHANGE_ROLES.has(role) && !deferred && !resumed && !retried && !resent) {
```

**steer 与 followup 的分工**（`src/host/delivery.js:72`）：

```js
    // A steered message cuts into a running turn at its next step; a follow-up
    // queues for the next turn (see turns.js for how each is routed).
```

**出口侧的对称逻辑**在 `src/host/turns.js:395`：一个回合结束时判断「谁在等这条回复」，然后回调同样的 `deliver`：

```js
        const answer = (source, reply) => {
          if (!expectsReply(source) || answersUser(source)) return
          const name = rt.botOf(rt.selfOf(id))?.name ?? 'The other Bot'
          // A sender that wrote from a group gets the reply in its Session there, while
          // it is still a member.
          const back = rt.roomOf(source.senderRoomId)?.sessions?.[source.senderSessionId]
```

`back` 这一句是「同一个 Bot 在群里和私聊是两个上下文」这条设计在投递层的落点：**回复要送回发送者当时所在的群 Session，而不是它的私聊**。

**失败也必须回一条**，否则发送方永远等下去（`src/host/turns.js:402`）：

```js
            // The sender was told a reply comes later; without this it would wait forever.
```

**@ 提及的判定在 `src/shared/mentions.js`**（65 行，被宿主与客户端共用）。三个正则解决三类误判：

```js
const ALL_WORDS = ['all', 'everyone', '所有人', '全体']
// A name followed by a letter, digit, `_`, `-` or `/` is part of a longer word; a name
// followed by `/`, `\` or a dot starts a path, which DSH writes as a file reference.
const NAME_GOES_ON = /^(?:[a-z0-9_\-\/\\]|\.[a-z0-9_-])/i
// An `@` after an email or URL character is part of that address, not a mention.
const ADDRESS_BEFORE = /[a-z0-9_./]/i
```

`referenceSpans` 处理一个特殊情况：**DSH 会把被引用的会话以 `@label` 写进消息一次，那次是引用不是呼叫**。`mentionSpans` 则保证最长名字优先、名字可含空格。

**roster / groups / delivery / mentions 四者的关系**：`src/host/roster.js` 建 Bot 与群（`createBot` / `createRoom`，`src/host/roster.js:58`、`src/host/roster.js:263`）；`src/host/groups.js` 在群 Session 上跑回合，用 `src/shared/mentions.js` 解析 `@`，用 `src/host/delivery.js` 投递；`src/host/delivery.js` 是唯一出口，把结果写进 `state.exchanges`；`src/host/turns.js` 在回合结束时把回复路由回去。

### 3.3 群聊回合：并发状态机

**问题**：多个 Bot 在一个群里轮流发言，还要能互相 `@` 呼叫、用户在回合进行中插话、成员在中途卡住或等待审批。这本质是一台并发状态机，但宿主接口是「一次回合一次回复」。

**设计一：槽位表而不是队列。**回合是一个数组，每个槽位有 `waiting`/`speaking`/`posted`/`passed`/`missed`/`failed`/`working`/`waiting-approval`/`left` 九种状态。`@` 呼叫不是「排队等下一轮」而是**插队**（`src/host/groups.js:252`）：

```js
  function callMembers(round, turns, index, callees, note, cap, by) {
    let next = index + 1
    for (const peer of callees) {
      if ((turns.get(peer.id) ?? 0) >= cap) continue
      const waiting = round.slots.findIndex((other, at) => at > index && other.id === peer.id && other.status === 'waiting')
      const called = waiting === -1 ? { id: peer.id, name: peer.name, status: 'waiting' } : round.slots.splice(waiting, 1)[0]
      called.note = note
      if (by === undefined) delete called.by
      else called.by = by
      round.slots.splice(next, 0, called)
      next += 1
    }
  }
```

已经在等的人被「提上来」而不是再加一次（`waiting === -1` 分支），所以同一个成员在一个回合里不会被叫两次排队。

**设计二：回合上限动态增长**，防止无限接力（`src/host/groups.js:309`）：

```js
    let limit = round.slots.length + ROOM_EXTRA_TURNS + (room.admin ? ROOM_ADMIN_EXTRA_TURNS : 0)
```

配合一组常量（`src/host/groups.js:26`）：

```js
const ROOM_LOG_MAX = 60
const ROOM_FIRST_LOOK = 12
const ROOM_DELTA_MAX = 24
const ROOM_EARLIER_MAX = 8
const ROOM_EXTRA_TURNS = 4
const ROOM_ADMIN_EXTRA_TURNS = 4
const ROOM_TURNS_EACH = 2
const ROOM_ADMIN_TURNS_EACH = 4
```

**只有管理员 `@all` 能叫所有人**（`src/host/groups.js:373`）：

```js
      // Only the admin's "@all" calls everyone, so a member cannot set off a storm.
      const leads = rt.isAdminOf(room, member.id)
      const everyone = room.members.map(rt.botOf).filter(Boolean)
      const others = everyone.filter(other => other.id !== member.id)
      const { all, found: named } = mentionsIn(reply, everyone)
      const found = named.filter(other => other.id !== member.id)
      const callees = leads && all ? [...found, ...others.filter(other => !found.includes(other))] : found
      callMembers(round, turns, index, callees, `${member.name} mentioned you`, leads ? ROOM_ADMIN_TURNS_EACH : ROOM_TURNS_EACH, member.id)
```

**设计三：回合是「等」出来的，不是「调」出来的。**`roomTurn` 发一条投递，然后挂一个 waiter 等宿主把回合跑完；等待期间收到任何事件都续命，所以「在干活的成员不会被判超时」（`src/host/groups.js:207`）：

```js
      const touch = () => {
        clearTimeout(timer)
        timer = setTimeout(() => finish({ missed: true }), ROOM_REPLY_TIMEOUT_MS)
      }
      const work = () => { grace ??= setTimeout(() => finish({ working: true }), ROOM_WORK_GRACE_MS) }
      touch()
      rt.roomWaiters.set(exchangeId, { sessionId, botId: member.id, roomId: room.id, resolve: finish, fail: failure => finish({ failure }), touch, work, approval: () => finish({ approval: true }) })
```

三种提前收场：`approval`（等用户批）、`working`（还在干活，本回合放它走）、`missed`（太久没动静）。**这三分支决定了回合是继续还是把位置让出去。**

**设计四：用户插话不打断回合，而是排进回合里**——把用户队列里的消息取出来插到下一个发言者之前，并相应放宽回合上限（`src/host/groups.js:287`、`src/host/groups.js:315`）。

**设计五：回合结束后才到的回复有专门的去处**，不会丢也不会重复（`src/host/turns.js:427`）：

```js
        if (!retry && info?.role === 'room') {
          const waiter = roomWaiters.get(info.exchangeId)
          roomWaiters.delete(info.exchangeId)
          const stopped = stoppedRoomTurns.delete(info.exchangeId)
          if (waiter !== undefined) {
            if (failure !== undefined) waiter.fail(failure)
            else waiter.resolve(reason?.kind === 'aborted' ? null : replyText())
          } else if (!stopped && reason?.kind !== 'aborted') {
            // The round moved on without this member; how its turn ends still reaches the group.
            if (failure !== undefined) void rt.lateRoomFailure?.(id, info, failure)
            else void rt.lateRoomReply?.(id, info, replyText())
          }
        }
```

**设计六：群 Session 的提示词每次现拼**，且明确告诉成员「你是第几个」（`src/host/groups.js:171`）：

```js
      `You are number ${index + 1} of ${round.slots.length}. ${before === 0 ? 'Nobody spoke before you' : `${before} went before you`}${after === 0 ? ', and you are the last.' : `; ${after} after you will see your message.`}`,
```

### 3.4 能力库（capabilities.js：MCP servers / skills / packs 怎么共享）

**问题**：共享能力要挂到具体 Bot 的 Session 上，挂载会连到外部服务，可能慢、可能失败。

**配置里只存名字**，实际展开成一组挂载项要经过 pack 展开（`src/host/capabilities.js:317`）：

```js
      const desired = bot ? expandCapabilityNames(bot.capabilities, library()) : new Set()
      const agentMounts = mounts.get(agent) ?? new Map()
```

**挂载项的缓存键是配置的哈希**，配置一变就重新挂，没变就跳过（`src/host/capabilities.js:289`）：

```js
    const key = `${name}:${createHash('sha256').update(JSON.stringify(config)).digest('hex')}`
    if (agentMounts.get(name)?.key === key) return
```

**stdio 型 MCP 未经批准不挂**，而是记一个状态给界面显示（`src/host/capabilities.js:276`）：

```js
    if (item.kind === 'mcp' && item.transport === 'stdio' && item.approved !== true) {
      await drop()
      statusSet(bot.id, name, sessionId, { state: 'needs-approval' })
      return
    }
```

**对账是每个 Agent 一条链**，一个慢的 MCP server 只拖住它自己（`src/host/capabilities.js:54-55`）：

```js
// Mounted fibers live in each Agent's own context, so they outlive this plugin unless
// One reconcile chain per Agent: a slow MCP server holds up only its own Agent.
```

**错误信息在写进状态前先过脱敏**（`src/host/capabilities.js:286`）：

```js
      statusSet(bot.id, name, sessionId, { state: 'error', error: rt.redactSecrets(error.message).slice(0, 300) })
```

`slice(0, 300)` 是防御外部服务返回超长错误串。

### 3.5 审批与权限（approvals.js + permissions.js + secrets.js）

**问题一：群 Session 是隐藏的，DSH 的审批卡不会显示。**`approvals.js` 因此替它作答；私聊仍用 DSH 自己的卡，只记「谁在等」（`src/host/approvals.js:68` 挂载 `approvalsView` / `waitsForApproval` / `answerApproval` / `cancelApprovals`）。

**问题二：DSH 的 Auto review 只对当前 Session 有效。**`permissions.js` 的头注释点明，所以 **Bot 永远不保留 `auto`**，且施加范围是「这个 Bot 的每一个 Session」：

```js
const SESSION_ONLY = 'auto'
```

`permissionCatalog()` 从 `ctx.get('permissionPresets').catalog()` 过滤掉 `auto`；`applyPermission(bot, sessionId)` 用 `rt.resolveAgent(sessionId)` 再 `service.set(agent.session, bot.permission)`；`setPermission` 会把它施加到 `rt.groupSessionsOf(bot.id)` 的每个群 Session（`src/host/permissions.js:41`）。

**问题三：密钥要能让 Bot 用上，又绝不能让 Bot 读到。**三段式：存、注入、脱敏。

**存储**——创建与改名都强制 600（`src/host/secrets.js:143`）：

```js
    await writeFile(temp, snapshot, { encoding: 'utf8', mode: 0o600 })
    await chmod(temp, 0o600)
```

以只读方式加载时也顺手修权限（`src/host/secrets.js:126`）：

```js
    if (!loadedReadOnly) await chmod(path, 0o600).catch(() => {})
```

**注入**——密钥不进模型的上下文，只进 shell 环境变量（`src/host/secrets.js:474`）：

```js
    for (const secret of secrets.values()) {
      if (!canUse(secret, botId)) continue
      values[envName(secret.name)] = secret.value
      if (command.includes(envName(secret.name))) {
        secret.lastUsedAt = Date.now()
        used = true
      }
    }
```

变量名带固定前缀（`src/host/secrets.js:12`）：

```js
export const ENV_PREFIX = 'DSH_SECRET_'
```

**注入是按需解析的**：`resolveEnv(execution)` 在每次 shell 调用时算一遍，只给「这个 Bot 有权用」的密钥（`src/host/secrets.js:469`）：

```js
    const botId = rt.selfOf(execution?.agent?.session?.header?.id ?? execution?.agent?.id)
    if (rt.botOf(botId) === undefined) return {}
```

不是 Bot 的 Session 直接返回空——**普通 DSH 会话拿不到任何密钥**。

**脱敏——两个出口都过 `redactDeep`**：工具结果（`src/host/secrets.js:440`）：

```js
    const content = redactDeep(result.content, redact)
    const meta = redactDeep(result.meta, redact)
    const error = redactDeep(result.error, redact)
```

模型请求（`src/host/secrets.js:459`）：

```js
    const messages = redactDeep(options.messages, redact)
    const system = redactDeep(options.system, redact)
```

**短值有特殊规则**：太短的值只在整体匹配时替换，否则会误伤正文（`src/host/secrets.js:12`、`src/host/secrets.js:17`、`src/host/secrets.js:37`）：

```js
// replaced wherever it appears, so below WHOLE_VALUE it is replaced only where
export const WHOLE_VALUE = 8
const short = value.length < WHOLE_VALUE
```

**Bot 只知道「有这个名字、我能不能用」**，看不到值（`src/host/secrets.js:383`）：

```js
    if (canUse(secret, bot.id)) return `${name} is already saved and you may use it: ${usage(name)}. You cannot see the value; never print it.`
```

**给用户看的用法提示区分两种 shell**（`src/host/secrets.js:186`）：

```js
  const usage = name => `$${envName(name)} in bash, or $env:${envName(name)} in PowerShell`
```

---

## 4. 用了哪些 DSH 原生包

### 4.1 宿主侧静态 import（全表）

| 包 | 引入的文件:行 | 引了什么 | 用途 |
|---|---|---|---|
| `@deepseek-ai/dsh-tools` | `src/host/browser.js:6`、`groups.js:19`、`memory.js:28`、`secrets.js:8`、`tools.js:4` | `defineTool` | 注册模型可见工具的**唯一**途径，25 个工具全部经它声明 |
| `@deepseek-ai/dsh-llm` | `src/host/channel.js:3`、`delivery.js:3`、`groups.js:18`、`parts.js:18`、`time-context.js:1` | `createUserMessage` | 构造要投递进 Session 的 user message。投递、群回合、时间上下文、检查点都走它 |
| `@deepseek-ai/dsh-llm` | `src/host/images.js:7`、`memory.js:27`、`parts.js:18` | `BlockAssembler` | 把流式响应块拼回完整答复。记忆复盘、摘要、读图、检查点这些**插件自己发起的**模型调用都用它 |
| `@deepseek-ai/dsh-web` | `web-search.js:11` | `WebError` | 只在 `auto` 搜索 provider 里用，与 Bot 团队代码无关 |

**宿主侧只有这三个包是静态 import，没有第四个。**

### 4.2 动态引用：以字符串存在的 DSH 包

这几处不写 `import`，而是运行时经 `ctx.get('loader').import(...)` 或 `import.meta.resolve` 取：

| 包 | 位置 | 为什么是动态的 |
|---|---|---|
| `@deepseek-ai/dsh-mcp-client` | `src/host/capabilities.js:3`（常量）、`:243`（`loader.import(MCP_CLIENT)`）；`src/host/connectors.js:14`、`:84` | MCP 是可选能力。DSH 若没装这个包，能力库与连接器降级，而不是整个插件起不来。loader 不可用时抛 `This DSH cannot load MCP servers.` |
| `@deepseek-ai/dsh-app-boot` | `src/host/dsh-update.js:19`（常量 `APP_BOOT`）、`:42-49` | 用来问「正在跑我们的 DSH 是哪个版本」。拿不到就退化成从 `process.argv[1]` 往上找最近的 `@deepseek-ai/*` 包目录读 `package.json`（`dsh-update.js:50-60`） |
| `@deepseek-ai/dsh` | `src/host/dsh-update.js:20`（常量 `DSH_PACKAGE`） | DSH 本体更新时比对的包名 |
| `@deepseek-ai/dsh-llm` | `src/host/diagnostics.js:103`、`:107` | 用 `import.meta.resolve('@deepseek-ai/dsh-llm')` 定位 DSH 安装目录，再往上找同名 `package.json` 取版本号。注释原文：「DSH packages share one version; the LLM package is always beside the plugin.」 |

`capabilities.js:241-244` 是这条模式的完整形状：

```js
const loader = ctx.get?.('loader')
if (typeof loader?.import !== 'function') throw new Error('This DSH cannot load MCP servers.')
const exports = await loader.import(MCP_CLIENT)
return loader.unwrapExports?.(exports) ?? exports?.default ?? exports
```

三级回退解包（`unwrapExports` → `default` → 模块本身）。**凡可选能力都应走这条形状，而不是写进 `inject`** —— 这条对 dsh-bot 有直接借鉴价值。

### 4.3 客户端侧：只允许三个平台模块

| 形态 | 位置 | 引了什么 |
|---|---|---|
| 静态 import | `src/client/cells.js:3` | `MarkdownText` |
| 静态 import | `src/client/new-chat.js:2`、`palette.js:2`、`sidebar.js:3` | `FishLogo` |
| 命名空间 import | `src/client/user-message.js:2` | `import * as ui`，用到 `ui.projectUserText`、`ui.fileExtension`、`ui.fileSizeText`、`ui.FileTypeIcon`、`ui.JsonBlock`（`:15,55,65,67,95`），全部带 `?.` 或 `typeof === 'function'` 兜底 |
| 纯字符串常量 | `src/client/speech.js:4` | `export const VOICE_BUNDLE = '@deepseek-ai/dsh-experimental-voice-input-bundle'` —— 只用于探测 DSH 的语音输入插件装没装 |

**整个客户端只 require 三个平台模块**：`react`、`react-dom`、`@deepseek-ai/dsh-client-ui-primitives`。这不是约定，是被测试钉死的：

- 打包器把它们列为 external（`scripts/build-client.mjs`，`PLATFORM_MODULES = ['react','react-dom','@deepseek-ai/dsh-client-ui-primitives']`）；
- `test/client-bundle.test.js:26-33` 用一个**只认这三个键**的假 require 跑打包产物，断言 `requested` 去重排序后恰好等于这三个。任何新增的客户端 DSH 依赖都会让这个测试红。

产物里实测到的 `require(...)` 只有这三种（`client.js` 内去重）。

### 4.4 peerDependencies 与一处刻意的缺席

```json
"peerDependencies": {
  "@deepseek-ai/cordis": "*",
  "@deepseek-ai/dsh-llm": "*",
  "@deepseek-ai/dsh-tools": "*",
  "@deepseek-ai/dsh-web": "*"
}
```

版本全是 `*` —— 不锁 DSH 版本，靠运行时的服务契约而非版本号兼容。

**但 `@deepseek-ai/cordis` 在整个仓库里一次都没有被 import**（对 `index.js`、`web-search.js`、`src/**`、`test/*`、`dev/*.mjs`、`scripts/*.mjs` 全量 grep `cordis` 结果为空）。它只作为 peer 存在，因为 `apply(ctx)` 形态、`export const inject`、`ctx.on/ctx.effect/ctx.tools.register` 这套 API 是 Cordis 提供的——**类型上的依赖，不是 import 上的依赖**。

### 4.5 没用的原生能力

| DSH 原生能力 | DS Bot 是否用 | 说明 |
|---|---|---|
| `ctx.agentTeams`（Agent Teams 四件套） | **否，零引用** | 详见 §5 |
| `ctx.subagents` / subagent 工具 | 否 | 团队完全自建，两者共存 |
| `ctx.memory` | — | **DSH 无此服务**（129 个服务名中确认不存在），必须自建 |
| `ctx.computerUse` | 否 | 浏览器走自己的 Electron webview 通道（`browser.js`） |
| `ctx.schedule` | 是（`schedules.js`） | 定时任务 |
| `ctx.approval` | 间接 | 群 Session 的审批由 `approvals.js` 代理作答（见 §8 边界 3） |
| `ctx.sandbox` / `ctx.permissions` | 是（`permissions.js`） | 把 Bot 自己的 preset 施加到它的每个 Session |

**结论**：DS Bot 站在 DSH 的**底层契约**（tools / llm / sessionController / connection）上自建上层语义，**没有站在 DSH 的任何高层协作基座上**。对 DSH 的依赖面窄得反常——宿主三个包、客户端一个包，换来的是只依赖 DSH 最稳定的那层。这是它与 dsh-bot 最本质的分岔点。

---

## 5. 与 DSH 原生 Agent Teams 的关系

> 本节是本次拆解最重要的发现：**DS Bot 与 DSH 原生 Agent Teams 是完全平行的两套团队机制，零复用、零引用。**

### 5.1 证据：零引用

对 `.refs/DeepSeek-Bot/ds-bot/` 全量 grep `agentTeams|agent-team|teammate|subagent`，排除 `client.js`（812,835 B 生成物），命中只有五处，**没有一处是使用 Agent Teams**：

| 位置 | 内容 | 性质 |
|---|---|---|
| `src/client/at-menu.js:56` | `row.origin !== 'subagent'` | 把 **DSH 自己的 subagent Session** 从「引用一个对话」的候选里滤掉 |
| `src/host/parts.js:180` | 注释：「除挂载点外每个 Session（subagent 也算）都有自己的压缩后端」 | 说明性注释 |
| `src/host/prompt.js:13` | 提示词里的一句 `Chat like a teammate texting` | 修辞，不是 API |
| `src/host/usage.js:323-329` | `item.origin !== 'subagent'` 时按普通 Session 算，否则记 `{ kind: 'subagent', parentSessionId, childSessionId, mode: 'unknown' }` | 统计 **DSH 原生 subagent** 的用量归属 |
| `test/at-menu.test.js:42`、`test/usage.test.js:50,79,87,94,95,203-215` | 上面两处的测试 | — |

`index.js`、`web-search.js`、`package.json`、`cordis.patch.yml` 对这四个词**零命中**。`CHANGELOG.md:85` 的唯一命中是「Usage 页现在也统计 subagent Session 的调用」。**结论：DS Bot 既不 import 也不挂载四件套中的任何一个包。**

### 5.2 DSH 原生 Agent Teams 是什么（本机实测）

四件套位于 DSH 安装目录 `node_modules/@deepseek-ai/`，版本统一 `0.2.1-alpha.2`：

| 包 | 描述 | 关键内容 |
|---|---|---|
| `dsh-experimental-agent-team` | *Implicit-root Agent Teams roster, direct peer messaging, and shared task DAG* | 暴露 `ctx.agentTeams`（`TeamService`）：`membership` / `listMembers` / `tryMembership` / `spawnTeammate` / `sendMessage` / `createTask` / `getTask` / `listTasks` / `updateTask` / `waitForChange` / `interrupt`。peer 依赖 `dsh-agent`、`dsh-llm`、`dsh-session`、`dsh-session-persistence`、`dsh-session-projection`、`dsh-subagent` |
| `dsh-experimental-tool-agent-team` | *Scoped model-facing Agent Teams tools over ctx.agentTeams* | 九个模型可见工具（建 teammate / 发消息 / 看状态 / 等进展 / 中断 / 任务板四件）。README 明确它**取代**同名的旧版 subagent 控件 |
| `dsh-experimental-client-ui-agent-team` | *Web Agent Teams roster, task board, and teammate navigation* | 纯浏览器投影：从共享 Session store 读 Lead Session 的 `agentTeam` 投影。`platform: web` |
| `dsh-experimental-agent-team-profile` | *Agent Teams collaboration, tools, and Web UI in one experimental bundle* | 组合包。patch 内容：`disabled: true` 掉 `tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork` 四条，再 insert `agent-team` / `tool-agent-team` / `ui-agent-team` 三条 |

**核心事实（`agent-team/README.zh.md` 原文）**：「每个普通运行时 root 都是一个隐式 Team 的 Lead，其 `TeamId` 等于 `SessionId`；不存在创建事件，持久 Team 状态从第一条成员或任务记录开始。」

配置项与默认值：

| 配置 | 默认 | 含义 |
|---|---|---|
| `maxMembers` | `16` | 一支团队最多创建的 teammate 数，包括失败的 |
| `maxTasks` | `256` | 任务板上最多的活动任务数 |
| `maxMessageBytes` | `65,536` | 单条发送消息的最大尺寸 |
| `disposalTimeoutMs` | `5,000` | 关闭清理允许的时间 |

组合包的 patch 里 `agent-team` 实际给的是 `maxMembers: 8`（比默认更小），`freshProvider: spawn`、`forkProvider: fork`。

组合包 README 原话：**「本包随 dsh 安装提供，默认关闭，可在插件页开启或添加到已初始化的 profile。」** —— opt-in。（`dsh-plugin-boundaries.md` 记的是「本机 Web profile 里已启用」，两处口径不同，以实际 profile 的 `cordis.patch.yml` 为准。）

### 5.3 两条路线逐项对照

| 维度 | DSH 原生 Agent Teams | DS Bot |
|---|---|---|
| 成员身份 | `TeamId === SessionId`，每个普通 runtime root **隐式**是 Team 的 Lead | Bot id 就是它第一篇 Session 的 id（`store.js:290-294`），显式建记录 |
| 成员创建 | `spawnTeammate()`：先 append + flush 一条 `provisioning` 成员记录，再让 provider 建 child | `roster.js:createBot`：先 `createSession()` 拿 Session id，再以它为键写 `state.bots[id]`；失败回滚（删记录 + archive Session） |
| 名册增删改 | **扁平不可变**：只有 Lead 可创建直接 teammate；无嵌套 Team、无重命名、无删除、名字永不复用 | 建 / 复制 / 改名 / 改设置 / 删除，全部支持（`roster.js` 22KB） |
| 状态存放 | DSH 的 Session 持久化，Team 事件写进 Lead Session 日志 | `<DSH_HOME>/bot/state.json` **一个 JSON 文件**，`index.js:1-3` 原话 *without new Session event types* |
| 并发保护 | 由 DSH 的 Session 持久化层负责 | 自建单写者文件锁 `home-lock.js`（pid + host + 随机 token，持有者定时 bump mtime），第二个宿主只读 |
| 点对点消息 | `sendMessage()`：目标存 `agent-message` source，首块 `Team message from <name>:` | `delivery.js:deliver()`：目标存 `source: { kind: 'bot', form: 'relay', role, … }`，正文首行是 `[Message from X]` 这类**纯文本头**；10 种来源，只有 `request`/`reply`/`stopped` 三种进 `state.exchanges` |
| 群聊 | **无** | **完整**：房间日志、序号、轮流发言、@ 插队、迟到回复、回合报告、三个群工具（`groups.js` 40KB） |
| 共享任务板 | **有**：DAG 依赖、CAS revision（`expectedRevision`）、`claim`/`complete`/`release`/`reopen`、`writeScopes` 重叠告警、tombstone | **没有**。协作靠 `post_to_group` + `group_relay` + `ask_user` 三种消息原语 |
| 跨会话记忆 | 无 | **有**：Agent Memory Repo 格式 Markdown + `journal.jsonl` + `snapshots/`（`memory.js` 79KB） |
| 上下文管理 | 用宿主默认压缩 | 自研分片：包住宿主压缩引擎改由小模型决策（`parts.js` 56KB + `steward.js`） |
| 密钥 / 能力库 / 浏览器 | 无 | 各有（`secrets.js` 24KB / `capabilities.js` 23KB / `browser.js` 13KB） |
| 上限 | 成员 16（组合包 8）、任务 256、单消息 64 KiB、清理 5 s | 群成员 12（`ROOM_MAX_MEMBERS`）、往返日志 600 条（`MAX_EXCHANGES`）、跳数 6（`MAX_HOPS`）、群回合 3 轮起（`ROOM_BOT_ROUNDS`） |
| 客户端 | 独立包做 roster + 任务板 + teammate 导航，读 Session 投影 | 自建 55 个客户端文件（816KB），走 `ctx.slots` 阴影替换 DSH 的侧栏/对话区，读自己 `POST /api/bot` 的 `state` |
| 启用方式 | 组合包默认关闭，用户在插件页开启 | 装 `ds-bot` 包即生效 |
| 与普通 subagent 的关系 | 组合包 patch 里**显式禁用**四个 `tool-subagent-*` 条目 | 不动 DSH 的 subagent，两者共存（Usage 页还统计 subagent 的调用） |
| 卸载后残留 | 团队事件留在 Session 日志里 | 无（不动 Session 存储） |
| 跨进程 | README 明确**单进程、共享 checkout** | 明确单写者；另一 dsh 持锁时整体只读 |

**计数**：DS Bot 独有 11 项，Agent Teams 独有 1 项（共享任务板），平 5 项。

### 5.4 为什么不用：不是不知道，是状态模型互斥

理由在 `index.js:1-3` 的头部注释里说得很直白：

```js
// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
```

四件套的做法是把团队状态**写进 Session 事件流**（`team/member`、`team/task` 记录、`agentTeam` 投影），DS Bot 的做法是把团队状态**放在 Session 事件流之外**。这是两种互斥的状态模型，不是可以叠加的两层。

| 可能原因 | 证据 | 确定度 |
|---|---|---|
| **状态归属相反**（结构性冲突） | 上面两段原文；DS Bot 的全部设计（单写者文件锁、Session→Bot 三张索引表、卸载不留孤儿数据）都立足于此。放弃它等于重写 | **高**（源码明文） |
| **能力不匹配** | DS Bot 的四件核心能力 Agent Teams 都没有：① 可增删改的名册 ② **群聊**（多 Bot 轮流发言 + @ 插队）③ 跨会话记忆 ④ Bot 浏览器 | **高** |
| **时序** | DS Bot 要求 DSH `0.2.1-alpha.1`，Agent Teams 是 `experimental` 子树，可能尚未定型 | **中**（未从源码取证） |
| **规模** | Agent Teams `maxMembers` 默认 16；DS Bot 无硬上限 | **低**（不构成主因） |

**两条路的取舍**：四件套换来的是状态随 Session 持久化天然一致、客户端投影自动刷新、有任务 DAG 与 CAS 并发控制、清理有超时保证；DS Bot 换来的是**不新增任何 Session 事件类型**，所以卸载或降级不会在 DSH 的会话存储里留下孤儿事件，团队状态可以整个拷走（README「Move to another computer」一节），代价是自己做文件锁与迁移。

### 5.5 dsh-bot 应当站在原生基座上，还是照 DS Bot 自研

**结论：分层混合 —— 站在原生基座上，但把 DS Bot 的四块自研搬过来。** 理由是两者覆盖的是**不同层**，而不是同一个东西的两个实现：

```
┌─ 协作层（谁和谁一起干活）──────────────────────────────┐
│  DS Bot 独有：群聊、可增删名册、Main Bot 层级            │ ← 自研，原生没有
│  原生独有：共享任务板（DAG + CAS）                       │ ← 直接用，自研没有
│  ────────────────────────────────────────────────────  │
│  重叠：点对点消息、roster 展示 → 必须二选一，别两套并存   │
├─ Bot 个体层（一个 Bot 是什么）─────────────────────────┤
│  DS Bot 独有：记忆、密钥、能力库、上下文分片、浏览器      │ ← 自研，原生完全没有
│  两者一致：Bot = 一个 root Session                       │ ← 地基相同，无冲突
├─ 表现层 ──────────────────────────────────────────────┤
│  原生：Agent Teams 面板（roster + 只读任务板）           │ ← 起步用
│  DS Bot：55 个客户端文件的全套 Bot 界面                  │ ← 长期目标
└───────────────────────────────────────────────────────┘
```

具体建议：

1. **「Bot = root Session」这条地基照抄 DS Bot**。两边在这一点上完全一致（`TeamId === SessionId` vs `Bot id = Session id`），没有冲突，且是 DS Bot 全部设计成立的支点。
2. **共享任务板直接用 `ctx.agentTeams` 的 `createTask`/`updateTask`/`listTasks`**，不自建。这是原生唯一比 DS Bot 强的地方，而且做得对（CAS revision、DAG 校验、tombstone）。DS Bot 缺它。
3. **群聊、可增删名册、记忆、密钥、能力库、浏览器 —— 照 DS Bot 自研**。原生要么没有，要么形态不匹配（roster 不可变、无群聊概念）。
4. **点对点消息必须二选一，不能并存**。这是唯一真正的冲突区：原生的 `sendMessage` 把消息追加进目标历史并带 `Team message from <name>:` 前缀；DS Bot 的 `deliver` 有 10 种来源分类和纯文本来源头。两套并存会让同一个 Bot 收到两种格式的跨 Bot 消息。**建议以 DS Bot 的 `deliver` 为准**（来源分类更细，且与群聊/回复路由是一体的），把原生 `sendMessage` 只留给「与原生 teammate 通信」这一个窄场景。
5. **状态归属要显式选边并写进设计文档**。原生的 roster/task 写进 Lead Session 日志，DS Bot 写自己的 JSON。若两者并用，会出现「roster 在两处、可能不一致」。**建议：Bot 名册走 DS Bot 的 JSON（因为它要可增删改，原生做不到），任务板走原生（它需要 CAS 与 DAG，自建不值当）** —— 不写明这条分工，后来者一定会把两者混起来。
6. **起步先验证装配链路，不要立刻碰原生**。`dsh-plugin-boundaries.md` §6 的三条起手路线里「② 宿主 + 复用原生 Web UI」最快，但只适合验证装配；一旦要加群聊和记忆，就必须面对上面第 4、5 条的冲突。

---

## 6. 测试与工程实践

### 6.1 规模

| 部分 | 文件数 | 字节 |
|---|---|---|
| `src/host/` | 31 | 511,115 |
| `src/client/` | 55 | 816,199 |
| `src/shared/` | 1 | 3,537 |
| `test/*.test.js` | **57** | **501,521** |
| `test/` 非测试辅助 | 2 | `fake-ctx.js` 1,963 + `harness-resolve.mjs` 2,284 |
| `test/fixtures/` | 7 | 三个搜索解析样本 + 四个读取器样本 |
| `dev/` 顶层 | 15 | 约 200,000 |
| `dev/desktop-linux/` | 15 | Linux 桌面测试台 |
| `scripts/` | 2 | 4,385 |

**测试代码量与宿主源码量几乎相当**（501KB vs 511KB）。最大的五个测试：`memory.test.js` 63,057 B、`web-search.test.js` 32,897 B、`bot-messages.test.js` 27,034 B、`roster.test.js` 23,239 B、`capabilities.test.js` 22,527 B —— 与最大的宿主模块（`memory.js` 79KB、`parts.js` 56KB、`groups.js` 40KB）基本对应。粒度是**按模块一对一**：`src/host/` 31 个文件 → 约 30 个对应测试；`src/client/` 55 个文件 → 约 20 个（客户端只测纯函数与结构，不测渲染）。

### 6.2 两道测试基础设施

**① `test/harness-resolve.mjs`（48 行）** —— 用 `node:module` 的 `registerHooks` 把 `@deepseek-ai/*` 的解析重定向到 DSH 安装处，查找顺序：

1. `$DSH_HARNESS` 环境变量
2. `npm run harness` 装到 `dev/harness/node_modules` 的那份
3. 向上逐级找 `deepseek-harness/` checkout
4. 从主 worktree 的位置再找一次（注释点明原因：「a git worktree has no checkout of its own」）
5. `../deepseek-harness`

**这样 `npm test` 不需要插件自带一份 DSH。这条对 dsh-bot 直接可用。**

**② `test/fake-ctx.js`（62 行）** —— 一个只记录、不启服务的假插件上下文：

```js
export function fakeContext({ services = {} } = {}) {
  const calls = [], disposers = [], registeredTools = new Map()
  const listeners = new Map(), sections = new Map()
  // ctx.on(name, listener, options)   支持 prepend；listeners 按注册序存
  // ctx.emit(name, payload)           只跑单参 listener，不跑带 next 的中间件
  // ctx.effect(execute, label)        返回函数则登记为 disposer
  // ctx.dispose()                     反序 Promise.allSettled
  // ctx.tools.register / ctx.systemPrompt.section / ctx.connection.fetch.register
  // ctx.get(name) / ctx.llm.listProviders / ctx.logger
}
```

`calls` 数组让测试能断言**注册顺序本身**。这个文件的形状**反推出宿主 ctx 的 API 面** —— 它是 DS Bot 用到的那一层的精确投影，比读 DSH 的类型定义更快。**这是 dsh-bot 应当直接抄的第一个文件。**

### 6.3 一个值得照搬的测试：`install.test.js`

把整个插件装进假 ctx 再打真实 HTTP 请求（`test/install.test.js:10-32`）：

```js
const home = mkdtempSync(join(tmpdir(), 'ds-bot-install-'))
const ctx = fakeContext({ services })
const applyResult = apply(ctx, { home, ...config })
const call = async (endpoint, payload) => {
  const response = await route.fetch(new Request('http://localhost/api/bot', {
    method: 'POST', body: JSON.stringify({ endpoint, payload }) }))
  return response.json()
}
```

第一个测试断言 `ctx.calls` 的注册顺序是固定的（`:36-45`）：

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

这就是 `index.js:43` 那句注释「Listeners run and tools are listed in registration order」的**可执行版本** —— `usage` 必须最后跑这条隐性约束，被一个数组断言钉住了。

**实测结论：57 个测试文件里只有 2 个会真的起进程或开端口**（全量 grep `createServer|spawn(|listen(`）：

| 文件 | 做了什么 |
|---|---|
| `test/mock-llm.test.js` | `spawn` 真跑 `dev/mock-llm.mjs`，`MOCK_PORT=0` 让内核选端口、mock 打印真实端口（`:42-53`） |
| `test/web-search.test.js` | 起两个 `node:http` server 验证重定向后的来源解析（`:236-245`） |

其余全部是纯函数 / 假 ctx / 临时目录。`test/read-page.test.js` 用 jsdom（`:12`，从相邻的 deepseek-harness 检出里 require），注释点明了它的局限：**「jsdom has no layout: every box is 100×20 unless marked data-zero」**（`:54`）—— 读取器的几何判断只能靠 fixture 上的 `data-zero` 标记来测。

### 6.4 `client.js` 是生成物，测试强制它同步

`test/client-bundle.test.js` 两个测试：

1. **`client.js is the build of src/client`** —— `assert.equal(await bundleClient(), committed(), 'client.js is stale: run \`npm run build\` and commit it')`。**字节级比对**打包器输出与仓库里的 `client.js`。
2. **`client.js registers a factory that exports apply and inject`** —— 用 `node:vm` 的 `runInNewContext` 跑产物，只注入 `{ window: { __ModuleLoader__: { load } } }`，断言：恰好注册 1 次、`id === 'ds-bot'`、无多余键；用假 require 调 `factory`，断言 `requested` 去重后恰好等于三个平台模块、导出是 `[object Module]`、键恰好 `['apply','inject']`、`inject` 精确等于七个服务名。

这一条测试同时守住三件事：**产物不过期、客户端不偷偷加 DSH 依赖、插件的导出面不膨胀**。这是「生成物入仓」做法的必备配套，否则 `client.js` 会慢慢与源码脱节。

### 6.5 集成测试：mock 模型 + 测试台

**`dev/mock-llm.mjs`（49,627 B，dev 目录最大）** —— 一个 Anthropic-Messages 兼容的脚本化 mock 模型，`Usage: node dev/mock-llm.mjs, then point DEEPSEEK_BASE_URL at it.`

设计要点（取自文件头注释）：
- **用中文命令词驱动**，不是靠匹配具体提示词。命令表（节选）：`建群 名: A, B`、`群发[回报] 名: 消息`、`改群 名 公告|管理员|模式|加|踢: 值`、`看群 名`、`转告 名: 消息`、`插话`/`排队`/`叫停`、`长文 N`、`长任务 N [K]`、`查记录 词`、`查锚点 part N #序号`、`上下文里有 词`、`撑爆`（伪造 400 溢出）、`报错`（伪造 401 拒钥）、`卡片 K`、`记住[@话题] 事实`、`团队记住 事实`、`忘掉 事实`、`回忆 [词]`、`查能力 [词]`。
- **群回合只读提示里的 "This round so far" 段**，所以「回合」与「更早消息」不分开计数就会错。
- **用量按请求大小估算**：约 3 字符/token、90% 命中缓存 —— 这样上下文表格与换篇阈值看到的是真实增长。
- **日志记录 system prompt 与 tools 的哈希**，用来确认群 Session 与私聊**共享前缀**（DS Bot 缓存策略的核心假设，被 mock 侧独立验证）。
- 环境变量：`MOCK_PORT`、`MOCK_LOG`、`MOCK_DELAY_MS`、`MOCK_JITTER_MS`（随机额外延迟，抖出顺序假设）、`MOCK_LOG_CHARS`、`MOCK_SUMMARY_DELAY_MS`、`MOCK_NATIVE_SEARCH=off`、`MOCK_REJECT_IMAGES=1`、`MOCK_WATCH`、`MOCK_LOG_TOOLS=1`。
- 还实现了：记忆面板的摘要/问答/复盘三种请求、交接笔记与后端压缩（各返回一份八节笔记，分别标 `handoff 提示词` / `backend 提示词`）、检查点、上下文管家的 `compact`/`switch` 判定、密钥卡回显，以及一个 Ollama 形状的 `POST /api/web_search`。

**`dev/bench.sh`（5,417 B）** —— 测试台：mock 模型 + 一个把插件 link 到本 checkout 的 dsh web。`dev/bench.sh <name> <web-port> <mock-port> [start|stop|reset|status]`。数据在 `<checkout>/.dsh-test-<name>`；进程按 pid 文件与**进程组**停，「never by name」。环境：`CONTEXT_WINDOW`、`CHECK_RATIO`、`MOCK_DELAY_MS`、`DSH_HARNESS`。

**`dev/smoke.mjs`（18,422 B）** —— API 级冒烟：走 `POST /api/bot` 驱动主流程，每步等团队安静（`QUIET_MS = 2500`、`STEP_TIMEOUT_MS = 120_000`），再查 `state.json` 与 mock 日志。**共 29 个 `await step(...)`**。`--out <file>` 写归一化转录（名字替代 id，时序相关处排序），便于重构前后 diff。覆盖：

| 类 | 步骤 |
|---|---|
| 引导 | `bootstrap: Chief waits for a model`；`user picks a model; Chief greets and asks` |
| 建 Bot | `Chief creates Writer, who replies`；`user creates Coder, who keeps the default model` |
| 群聊 | 建群、群里说话、admin 叫所有人、Chief 发言、设公告、读群、删群 |
| 长对话分片 | 写长回复多轮、跨篇搜自己的记录、更早的分页加载、原地压缩而非换篇、找到被压缩的消息、收尾 |
| 往来与改名 | 交换日志、改 Writer、pin Coder、设为/取消 Main Bot、复制 Coder、改 prefs、删副本 |
| 能力 | Chief 看到挂载的 MCP 与 skill（私聊与**首次群回合各一次**）、Coder 不继承、解绑后消失 |

能力那四步用一个真的 stdio MCP echo server（`dev/mcp-echo-server.mjs`，导出 `echo` 工具）作夹具，断言「群 Session 与私聊共享能力挂载，而另一个 Bot 不继承」—— 这是 `capabilities.js` 对账循环最容易出错的地方。

**`dev/ui-shots.mjs`（19,478 B）** —— 两端截同一批屏，**共 27 个 `shot(...)`**：团队现状、新 Main Bot 的模型卡与问候、侧栏（含 pin 状态）、私聊及其详情面板的模型选择器与设置、Bot 记忆四处、记忆胶囊、群聊与其设置、Bot 设置、Bots 与 Group chats 页、Usage 页四个视图。Desktop 用 CDP 截图（或 `SHOT_DISPLAY` 抓屏），Web 用 dsh 的 playwright-core 起 headless Chrome，用 bench 的 `web.log` 里的 token URL 登录 —— **那个 URL 从不打印**。

**`dev/check.sh`（7,031 B）** —— 一条命令查两端，六步 `STEPS="unit build lint smoke web desktop"`：

| 步骤 | 做什么 |
|---|---|
| `unit` | `npm test` |
| `build` | `build-client.mjs --check` |
| `lint` | `npm run lint`（warning 不算失败） |
| `smoke` | 起一个全新 smoke bench + `dev/smoke.mjs` |
| `web` | 起一个全新 Web bench + `dev/ui-shots.mjs` |
| `desktop` | 起一个全新 Desktop（`desktop-linux/desktop.sh`），同一批截图 + `browser-check.mjs` + `read-check.mjs` 跑样例页 |

`dev/check.sh [--skip step,step] [--only step,step] [--out <dir>]`。端口按 `SLOT=n`（0-9，默认 0）：Web `31n0/88n0`、smoke `31n1/88n1`，允许十套并行。工程细节：
- **`trap cleanup EXIT` + `trap 'exit 130' INT TERM`** —— 「Every process it starts is stopped at the end, also on failure or Ctrl-C.」
- **一处诚实的重试注释**：共享服务器上 bench 的 dsh web 曾以空日志退出，下一次启动就好了，所以 `bench_reset` 重试一次。
- **日志脱敏**：`grep -v 'token=' "$log.raw"` —— 登录 token URL 不进日志。
- **测试台数据隔离**：`.dsh-test-check-web`、`.dsh-test-check-smoke`、`.dsh-test-desktop-check`，**绝不指向 `~/.dsh`**。

### 6.6 真模型上的三个评估脚本

单测与 smoke 都跑 mock，但有三个脚本**故意要真模型**，因为它们考的是模型判断力：

| 脚本 | 考什么 | 成本（文件头自述） |
|---|---|---|
| `dev/memory-e2e.mjs`（13,188 B） | 记忆端到端：用户像平常那样说话（**大多不说 "remember"**），脚本给落到记忆里的东西打分，并看后来的群聊（没有私聊历史）有没有用上 | 约 30 次 Bot 调用 × 14-20k prompt token；开记忆复盘再加约 30 次 × 2-5k |
| `dev/steward-eval.mjs`（14,497 B） | 上下文管家的判断力：手写对话结尾 + 应有答案，走管家自己的提示与请求（`src/host/steward.js`）。`expect` 取 `compact`/`switch`/`either`（either 是判断题，只记录答案） | 每次调用约 3,000 token |
| `dev/llm-tap.mjs`（10,780 B） | 不是评估，是**观测**：OpenAI chat completions / Anthropic Messages 两种格式的日志透传代理，逐次调用写一行 JSON（调用种类、哪个 Bot、token 用量、最新输入与回答）。`tokens` 把两种格式归一成 `{ prompt(含 cached), cached, output }`。**「Headers are never logged.」** 调用种类有 `steward`/`checkpoint`/`handoff`/`main` 四种 | — |

`memory-e2e.mjs` 的存在本身就是一条设计声明：**记忆系统的验收标准不是「remember 被调用了」，而是「用户没说记住、后来的对话却用上了」。** 这与 mock 的 `记住`/`回忆` 命令形成互补 —— mock 测管道，e2e 测效果。

### 6.7 `dev/` 其余工具

| 文件 | 字节 | 用途（取自头注释） |
|---|---|---|
| `characters.mjs` | 28,069 | **角色造型的源生成器**：用有符号距离基元（球、椭球、圆台、圆环、挤出体、把最初吉祥物轮廓膨胀成的软板）搭小 3D 模型，从固定四分之三视角描成 100 单位盒里的平层。`node dev/characters.mjs` 打印给 `src/client/characters.js` 的 CHARACTERS 块；`--preview a.html` 另写预览画廊 |
| `shared-home-check.mjs` | 4,414 | **Web 与 Desktop 共用一个 DSH_HOME 时会不会互相丢改动**。两端先都加载团队，再轮流各建一个 Bot 并发消息。通过条件：每端报过创建的 Bot 都还在 `state.json`、团队只有一个 Main Bot、每端要么存下了改动要么带消息拒绝了 |
| `mascot-outlines.mjs` | 4,436 | 最初吉祥物的源轮廓（512 单位盒，花瓣 20 单位），导出 `BLOSSOM_PETALS`/`MOON_BODY`/`SQUIRCLE_BODY`/`STAR_BODY`/`WAVE_BODY`，被 `characters.mjs` 消费 |
| `logo.mjs` | 3,303 | README 的 logo：鲸鱼居中，最初几个角色环列四周，从插件自己的角色表画。写亮/暗两版，默认输出 `../docs/images` |
| `read-page-check.mjs` | 2,766 | 在 headless Chrome 上跑 `READ_PAGE_SCRIPT`，打印耗时、大小与文本头几行。**比桌面端快**，用于开发读取器与给真实网站计时 |
| `read-pages.mjs` | 1,969 | 读取器的样例页服务：`test/fixtures/read-page` + 一个生成的大表 `/big-table.html?rows=N`。首页第二个 iframe 从 `http://localhost:<port>/` 加载，是**跨源**用例。默认端口 8833 |
| `mcp-echo-server.mjs` | 1,240 | 极简 stdio MCP echo server，导出 `tools = [{ name: 'echo', description: 'Return the supplied text.', inputSchema: { text } }]`。被 `smoke.mjs` 当作能力夹具 |

`dev/desktop-linux/`（15 个文件）：`desktop.sh`（7,935 B）、`launch.mts`、`lib.mjs`、`onboarding.patch.yml`、`fetch-electron.mjs`、`browser-check.mjs`（8,247 B）、`read-check.mjs`（9,117 B）、`probe-webview.mjs`、`simulate-windows-caption.mjs`、`window-size.mjs`、`create-bots.mjs`、`cookie-page.mjs`、`cleanup-probe.mjs`、`shot.mjs`、`wait-app.mjs`。

`dev/harness/package.json`（唯一文件）：

```json
{ "name": "ds-bot-test-harness", "private": true,
  "description": "The DeepSeek Harness packages that the unit tests and the linter run against. Install with npm run harness in ds-bot/.",
  "dependencies": { "@deepseek-ai/dsh": "0.2.0-rc.2", "jsdom": "29.1.1", "oxlint": "1.76.0" } }
```

**注意 `@deepseek-ai/dsh` 固定为 `0.2.0-rc.2`，不是最新。** 测试与 lint 跑在一个已知良好的 DSH 版本上，CI 里再另测更新的版本。

### 6.8 CI 与 lint

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

只开两条规则，都是 error，**刻意不引入风格规则**。

`scripts/lint.mjs`（1,613 B）—— 自己找 oxlint，顺序：`DSH_HARNESS` → `dev/harness` → `../deepseek-harness` → git common dir 旁。用 `process.execPath` 跑 `node_modules/oxlint/bin/oxlint`，因为**「on Windows it cannot spawn the .cmd shim in node_modules/.bin without a shell」**。扫描目标：`index.js web-search.js src dev scripts test`。

### 6.9 工程实践的五条硬规则（`.refs/DeepSeek-Bot/AGENTS.md`）

| 规则 | 由什么守 |
|---|---|
| 1. **Plugin only** —— 绝不 patch DSH 或依赖 DSH 安装目录内的文件 | 实测：宿主只 import 三个 DSH 包的公开导出；动态引用也只经 `loader.import`。见 §4.1/§4.2 |
| 2. **No secrets** —— 绝不写入/打印/提交 API key、token、cookie 或 DSH_HOME 内容；测试用 mock 模型，不需要 key | `dev/mock-llm.mjs` 全程无 key；`dev/llm-tap.mjs` 明确不记 header；`src/host/diagnostics.js` 保存前清洗 |
| 3. **Only original material** —— 不抄其他产品或网站的代码/文字/图标/logo/图形 | `dev/logo.mjs` 与 `dev/characters.mjs` 从插件自己的角色表生成全部图形资源 |
| 4. **`client.js` 是生成物** —— 改 `src/client/`，跑 `npm run build`，两个文件一起提交，绝不手改 | `test/client-bundle.test.js` 字节级比对 + CI 里的 `--check`。见 §6.4 |
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

`AGENTS.md` 里关于「何时算做完」的原话：**「A change is done when `npm test`, the `--check` and `npm run lint` pass; CI runs them on every pull request. Run the smoke test as well for changes to `index.js` or `src/host/`.」** —— 分两档：改 `src/client/` 只需单测 + 产物同步 + lint；改宿主还要加 smoke。

---

## 7. 值得 dsh-bot 借鉴的设计

| # | 做法 | 为什么好 | 能不能照搬 |
|---|------|----------|-----------|
| 1 | **每个 Bot = 一个 DSH root Session，团队状态放插件自己的 JSON**（`./index.js:1-3`） | 不新增 Session 事件类型，卸载/升级不留孤儿数据；Bot 天然获得完整的 DSH 对话面（工具、审批、压缩、标题），插件只需要补团队语义 | **能**。这是 dsh-bot 的地基，应当直接采用 |
| 2 | **31 个模块共用一个 `rt` 总线，`install(rt)` 挂函数、运行时互调；`MODULES` 顺序与 import 顺序刻意不同且用注释锁住理由**（`./index.js:39-43`、`596-600`、`620`） | 模块间没有 import 环；可以只装一部分模块做测试；装载顺序成为一个显式的、可注释的设计决定，后来的改动者不会顺手重排 | **能**。但必须学它把顺序理由写在数组上方（`usage` 必须最后跑），否则顺序会退化成隐性依赖 |
| 3 | **三张 Session 索引表 + 「Bot id 永不变」的不变量**（`src/host/store.js:290-321`） | 把「谁在哪个 Session 说话」从遍历变成 O(1) 查表；历史篇（archived segment）也答得出来 | **能**。不变量本身比三张表更重要——`chatOf` 的回退分支就是它的兜底 |
| 4 | **投递只有一条路：`deliver` + 纯文本来源头 + 结构化 `source`**（`src/host/delivery.js:15-48`） | 10 种来源走同一管道；模型读得懂来源，程序也拿得到字段；`headerFor` 的 if 顺序即优先级，读代码就知道谁压谁 | **能**。但要注意头是纯文本，改文案就会改行为，需要测试兜住 |
| 5 | **只记 `request`/`reply`/`stopped` 三种往来到 `state.exchanges`**（`src/host/delivery.js:31`） | 团队往来日志不被「问候语」「系统提示」淹没；`deferred`/`resumed`/`retried` 不重复记，避免重启后同一条记两遍 | **能** |
| 6 | **回复送回发送者当时所在的群 Session**（`src/host/turns.js:400`） | 「群里」和「私聊」是两个上下文，回复必须回到发起处，否则群里的对话会被拉走私聊 | **能**，且这是多人协作里最容易做错的一条 |
| 7 | **失败/被停的回合也必须回一条**（`src/host/turns.js:402`、`:415-424`） | 发送方被告知「稍后回复」后，若对方崩了就会永远等；兜底消息把死等变成一条可读的说明 | **能** |
| 8 | **群回合是槽位表 + 可插队 + 动态上限**（`src/host/groups.js:252`、`src/host/groups.js:309`、`src/host/groups.js:373`） | 一个数组同时表达了「谁在说、谁在等、谁被叫了、谁错过了」；上限随 `@` 增长使接力可以继续但不失控 | **能**，但这是全项目最复杂的一块，值得单独设计并配测试 |
| 9 | **回合用 waiter「等」出来，且任何事件都续命**（`src/host/groups.js:207`） | 「还在干活」不会误判成超时；三种提前收场（审批/干活/错过）把并发状态收进一个 resolve 回调 | **能**，前提是宿主会推事件——需先核实 dsh-bot 可用的宿主接口 |
| 10 | **包住宿主的压缩引擎并全部拒绝，改由自己决策**（`src/host/parts.js:176-200`） | 不修改宿主实现，只在引擎对象上打 Symbol 标记替换三个方法；Bot 的长对话因此有了「换篇」这一宿主没有的选项 | **要谨慎**。它依赖宿主把引擎对象暴露给插件；照搬前必须确认 dsh-bot 面向的 DSH 版本有同样的暴露面 |
| 11 | **判不出来就保守换篇，且退避重试**（`src/host/parts.js:505`、`src/host/parts.js:134`） | 小模型失败是常态；默认动作选「换篇」（安全）而非「压缩」（可能丢信息）；`NOTE_COOLDOWN_MS` 数组让连续失败不会每回合重试 | **能**。这条是通用工程经验，与领域无关 |
| 12 | **密钥只进 shell 环境变量，出站两个口全量替换；能力挂载用配置哈希做缓存键、对账每 Agent 一条链**（`src/host/secrets.js:440`、`459`、`474`；`src/host/capabilities.js:289`、`:54-55`） | Bot 能用密钥但读不到值，泄露口只有工具结果与模型请求两个，各堵一次；能力配置没变就不重复挂载，一个慢的 MCP server 只拖住自己的 Agent | **能**。`WHOLE_VALUE=8` 这条短值规则要一起抄，否则短密钥会误伤正文 |

---

## 8. 已知边界与疑点

**边界（已确认，来自源码）**

1. **明确未读两个文件**：`client.js`（812,835 B，esbuild 生成物）与 `web-search.js`（41,985 B，独立的搜索 provider）。本报告对浏览器半边的结论来自 `src/client/` 的 55 个源文件，不是打包产物。
2. **Bot 浏览器仅桌面端**（`src/host/browser.js:1` 区域注释与 `./package.json` 的 `dsh.client.platform: 'web'` 并存）：`browser.js` 走 Electron webview 的长轮询通道 `browser-wait`/`browser-result`，非 Electron 宿主下这条能力不可用。
3. **审批在群 Session 里由 `approvals.js` 代理作答**，不是 DSH 原生行为——这意味着群里的审批语义与私聊不完全一致（私聊用 DSH 的卡，群用代理）。
4. **DSH 的 Auto review 无法为 Bot 保留**（`permissions.js` 头注释）：`SESSION_ONLY = 'auto'` 被显式过滤掉，Bot 只能用非 auto 的 preset。
5. **单写者模型**：另一个 dsh 持有 `state.json` 的锁时，整个插件退化为只读（`src/host/store.js:52-57`），此时建 Bot 会抛错（`src/host/roster.js:27-28`）。

**疑点（未解决，供 dsh-bot 决策前核实）**

1. **`rt` 总线的耦合深度未量化**：本报告确认了 31 个模块都往 `rt` 上挂函数，但没有统计「谁调用了谁的 `rt.xxx`」的完整依赖图。若要照搬这个模式，需要先做一次 `rt.` 引用的全量 grep，才能知道真正的耦合面有多大。
2. **`MODULES` 顺序的隐性约束只找到一处注释**：`usage` 必须最后跑这一条有注释（`./index.js:596-600`），但 `secrets`/`connectors`/`capabilities` 挪到 `images` 之后、`browser` 挪到 `schedules` 之后**没有给出理由**。这是照搬时最容易踩的坑。
3. **`parts.js` 对宿主压缩引擎的替换依赖未版本化**：`adoptEngine` 只检查 `typeof engine.compactIfNeeded !== 'function'`（`src/host/parts.js:200`），没有版本判定。DSH 若改名或改签名，这段会静默失效而不是报错。
4. **群回合的超时数值**（原列为疑点，已补）：`src/host/constants.js` 中 **`ROOM_REPLY_TIMEOUT_MS = 240_000`**、**`ROOM_WORK_GRACE_MS = 15_000`**（另 `ROOM_BOT_ROUNDS = 3`、`ROOM_LATE_ROUNDS = 10`、`ROOM_MAX_MEMBERS = 12`、`MAX_HOPS = 6`、`MAX_EXCHANGES = 600`）。即：一个被点名的成员 4 分钟内没出声判 missed；但只要有事件在推，宽限再续 15 秒。
5. **`memory.js`（79,091 B）只做了目录布局与回溯设计的归纳**，其内部的分区策略、条目淘汰与检索算法未逐段读完——本报告对记忆系统的结论限于「它怎么保证可回溯」，不是「它怎么决定记什么」。
6. **客户端 55 个文件的分类是按「界面上负责哪一块」做的**，`usage-page.js`（52,401 B）与 `styles.js`（107,268 B）体量远超同类，若按代码量而非职责聚类会得到不同结果。分类本身是判断，不是事实。

---


## 附录 A：入口与装载顺序

**A.1 一句话定位**（`./index.js:1-3`）

```js
// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
```

这句话是整个实现的核心取舍：**不为 Bot 团队新增任何 DSH Session 事件类型**，所有团队状态（名册、群聊房间、Bot 互发消息的交换日志）都塞进 DSH_HOME 下的**一个 JSON 文件**。代价是必须自己做并发写保护（见 `home-lock.js`），收益是插件不侵入 DSH 的会话存储格式，卸载/升级都不会留下孤儿事件。

**A.2 插件声明与依赖注入**（`./index.js:36-37`）

```js
export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']
```

只依赖 DSH 的公开服务，没有一处 `import` 指向 DSH 安装目录里的文件——与 `.refs/DeepSeek-Bot/AGENTS.md` 的硬规则 1（"Plugin only"）一致。

**A.3 模块装载：单一 `rt` 对象 + 顺序敏感的 install**（`./index.js:39-43`）

```js
// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
const MODULES = [diagnostics, store, models, permissions, turns, delivery, roster, agents, prompt, timeContext, tools, chatIndex, groups, approvals, resume, memory, parts, images, secrets, connectors, capabilities, schedules, browser, usage, update, dshUpdate, channel]
```

注意 `./index.js:43` 的 `MODULES` 与 `./index.js:6-32` 的 import 顺序**不同**：`secrets`/`connectors`/`capabilities` 被挪到 `images` 之后，`browser` 被挪到 `schedules` 之后。这是刻意的：`usage` 必须最后计量模型请求，所以它排在所有会改写请求的模块之后。

**A.4 运行时的构造**（`./index.js:49-63`）

```js
export function createRuntime(ctx, config = {}) {
  const home = config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bot')
  const rt = {
    ctx, config, home,
    statePath: join(home, 'state.json'),
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of MODULES) module.install(rt)
  return rt
}
```

`rt` 是唯一的模块间总线：每个模块的 `install(rt)` 往里挂函数（如 `Object.assign(rt, { permissionCatalog, applyPermission, setPermission })`，见 `src/host/permissions.js:41`），别的模块运行时通过 `rt.xxx()` 调用。这避免了模块间的直接 import 环，也让测试可以只装一部分模块。

**A.5 包清单**（`./package.json:55-62`）

```json
"dsh": {
  "client": { "platform": "web" },
  "bundle": { "patch": "./cordis.patch.yml" }
}
```

浏览器半边通过包的 `dsh.client` 清单 + `./client` 导出被发现，不写进 patch 文件。

**A.6 补丁挂载**（`./cordis.patch.yml:3-17`）

```yaml
- insert:
    - id: bot
      name: ds-bot
    - id: web-search-auto
      name: ds-bot/web-search
- id: web
  config:
    searchProvider: auto
    fetchProvider: http
```

两个条目：Bot 团队宿主，以及一个把 DSH 的 `web` 服务搜索 provider 改成 `auto` 的**配置覆写**。注释（`./cordis.patch.yml:11-13`）点明了一个坑：配置覆写会**整体替换**该条目的 config，所以 `fetchProvider` 必须重述一遍。

---
