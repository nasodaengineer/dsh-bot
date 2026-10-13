# DSH 插件骨架与原生基座（Lead 亲勘）

> 调研时间：2026-10-13
> 方法：直接读 `E:\data\my-work\dsh\DSH-X\data\versions\0.2.1-alpha.2\node_modules\@deepseek-ai\`（299 个包）与同盘同级的一个**已落地的原生 DSH 插件** `dsh-mmaping`。
> 本文与 `dsh-plugin-boundaries.md`（子代理产）互补：那一份按包逐个读 README，这一份是**从可运行的同构插件倒推出来的实操骨架**。

---

## 0. 结论摘要

1. **DSH 本体内置了 Bot 团队的原生基座**：`dsh-experimental-agent-team` 四件套（domain / tool / profile bundle / Web UI）。它的核心事实是 **`TeamId === SessionId`** —— 每个 root Session 天然是一支团队的 Lead。
2. **`dsh-bot` 不需要从零造团队机制**，它要做的是在这层基座之上补 Grok Bot 独有的东西：命名人格、云计算机、例程、连接器、模板分发。
3. **`dsh-mmaping` 是同构骨架**：一个 host + 一个 browser bundle + 一个 `cordis.patch.yml`，用 tsdown 打包成两个文件。dsh-bot 可以照这个形状起手，不必重新发明工程结构。
4. **客户端插件的真实机制是 `window.__ModuleLoader__.load({id, factory})`**，不是普通的 npm import。打包时要手写 banner/footer 把 bundle 包成 lazy-CJS 模块。
5. **客户端插件的类型必须自己写**：`dsh-mmaping/src/client/types.ts` 头注释明说「bundle 从不 import `@deepseek-ai/*` 客户端包，运行时由 loader 的 module table 提供，所有 interface 是那些包文档化的精确切片」——这是**规避 pre-stable API 版本耦合**的既定做法，dsh-bot 应当照做。

---

## 1. Agent Teams 原生基座（DSH 自带）

### 1.1 四个包与依赖

| 包 | 角色 | 关键 peerDeps | dsh 字段 |
|---|---|---|---|
| `dsh-experimental-agent-team` | domain 服务 `ctx.agentTeams` | cordis, dsh-agent, dsh-llm, dsh-session, dsh-session-persistence, dsh-session-projection, dsh-subagent | 无 |
| `dsh-experimental-tool-agent-team` | 九个模型工具 | dsh-agent, dsh-session, dsh-system-prompt, dsh-experimental-agent-team, dsh-tools, cordis | 无 |
| `dsh-experimental-agent-team-profile` | profile 组合包（运行时内容就是 `cordis.patch.yml`） | cordis | `{"bundle":{"patch":"./cordis.patch.yml"}}` |
| `dsh-experimental-client-ui-agent-team` | Web 端 roster 与任务板 | dsh-api-session-controller, dsh-client-locale, dsh-client-ui-conversation, dsh-client-ui-primitives, dsh-client-ui-renderer, dsh-client-ui-session, dsh-client-ui-slots, dsh-client-ui-workspace, dsh-experimental-agent-team, dsh-session, cordis | `{"client":{"inject":[...5 项...],"platform":"web"}}` |

### 1.2 核心事实（`dsh-experimental-agent-team/README.zh.md`）

- **身份**：`每个普通运行时 root 都是一个隐式 Team 的 Lead，其 TeamId 等于 SessionId；不存在创建事件，持久 Team 状态从第一条成员或任务记录开始。`（README.zh.md:126）
- **持久化**：`roster 与任务变更将 team/member 和 team/task 追加到精确的 live Lead 会话，并在报告成功或唤醒等待者之前 flush。`（:144）
- **最小配置**（:40-45）：
  ```yaml
  - name: '@deepseek-ai/dsh-session-persistence-jsonl'
  - name: '@deepseek-ai/dsh-experimental-agent-team'
  - name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  ```
- **限制参数**（:49-54）：`maxMembers` 16 · `maxTasks` 256 · `maxMessageBytes` 65536 · `disposalTimeoutMs` 5000。
- **teammate 状态**：`running` / `inactive` / `provisioning` / `failed`（:62）。
- **只有 Lead 能创建与中断 teammate**（:64）。
- **消息**：`sendMessage()` 检查调用方成员身份、拒绝自发消息、限制大小；`首个内容块为 Team message from <name>:`（:130）。投递给 Lead 走 `Agent.steer()`，投递给 teammate 走 continuation owner 的 host-only Steer 路径（:132）。
- **任务板**：`每次变更都携带 expectedRevision，陈旧调用方会收到 TEAM_TASK_STALE_REVISION`（:136）；`writeScopes 是规范化后的 workspace 相对前缀；视图会对与 in-progress 任务的重叠发出警告，但绝不阻止 claim 或授予写权限`（:136）。
- **已知限制**（:201-207）：完整视图广播 · 实验原型无稳定性承诺 · **单进程、共享 checkout**（不提供 worktree、远端成员、merge 或文件锁）· **write scope 仅作提示**（Bash/formatter/代码生成器可绕过）· 扁平且不可变的 roster（不支持嵌套 Team、重命名、删除或名字复用）· **不会自动释放 owner** · 无发送重试保证。

### 1.3 服务 API（`lib/types/index.d.ts`，113 行）

```ts
export declare class TeamService extends Service {
  static inject: string[]
  static Config: z<Config>
  membership(agent: Agent): TeamMembership
  listMembers(agent: Agent): TeamMemberView[]
  spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult>
  sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult>
  createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView>
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView
  listTasks(caller: Agent): TeamTaskView[]
  updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView>
  waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult>
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' }
  tryMembership(agent: Agent): TeamMembership | undefined
}
```
挂载方式（:12-16）：
```ts
declare module '@deepseek-ai/cordis' {
  interface Context { agentTeams: TeamService }
}
```
**每个方法都要求传入确切的 live 调用方 `Agent` 作为权限凭据**（"exact live Agent used as the authority credential"）。这是 dsh-bot 若要走这条服务时必须遵守的契约。

### 1.4 九个模型工具（`dsh-experimental-tool-agent-team`）

分四类（README.zh.md:57-62）：
- 创建：`spawn_teammate`（仅 Lead）
- 发消息：`send_message`
- 查看与等待：`list_agents`、`wait_agent`、`interrupt_agent`（仅 Lead）
- 任务板：`team_task_create`、`team_task_list`、`team_task_get`、`team_task_update`

配置（:46-49）：`freshProvider` 默认 `spawn`，`forkProvider` 默认 `fork`。
**注册是按作用域的**：`每个注册都位于成员 Agent（智能体）自己的 ctx 上`（:84），`maybeInstall 对每个 live Agent 运行，并订阅 agent/created；它跳过没有 Team 成员关系的 Agent`（:102）。

### 1.5 profile 组合包实际做的事

`dsh-experimental-agent-team-profile/cordis.patch.yml` 在 `dsh-base` 之后应用时**禁用四行**：`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`，并插入 Team 服务、工具与 UI 行（README.zh.md:61）。
→ **启示**：dsh-bot 若要接替这些行，方式是一样的——写自己的 `cordis.patch.yml` 做 insert + disabled。

---

## 2. dsh-mmaping —— 可照抄的插件骨架

### 2.1 工程形状

```
dsh-mmaping/
├── package.json          # main / exports / files / dsh 字段
├── cordis.patch.yml      # profile 补丁层（就一个 insert）
├── tsdown.config.ts      # 双目标打包：host(node,esm) + client(browser,cjs)
├── tsconfig.json
├── src/
│   ├── index.ts          # host 入口：apply(ctx)
│   ├── policy.ts         # 会话启动注入的策略文本
│   ├── tools/            # define.ts / schema.ts / args.ts / runtime.ts
│   └── client/
│       ├── index.tsx     # client 入口：apply(ctx)，注册 slot
│       ├── types.ts      # 本地重写的服务切片类型（关键！）
│       ├── locales.ts    # zh/en 词典
│       ├── layout.ts / styles.ts / MapCanvas.tsx / MapView.tsx / OpenMapCard.tsx
│       └── map-loader.ts
├── lib/                  # 构建产物：index.js 61KB + client.js 52KB
└── smoke/smoke-test.mjs
```

### 2.2 `package.json` 的关键字段

```json
{
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
  "files": ["lib/index.js", "lib/client.js", "cordis.patch.yml", "README.md", "README.en.md"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "inject": [
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-api-gateway",
        "@deepseek-ai/dsh-api-workspace-files"
      ],
      "platform": "web"
    }
  },
  "dependencies": { "mellos-mapping": "file:../mellos-mapping" },
  "devDependencies": { "@types/node", "@types/react", "react", "tsdown", "typescript" }
}
```
注意：**`react` 只在 devDependencies 里**，因为运行时由 loader 的 module table 提供。

### 2.3 `cordis.patch.yml`（全文结构）

```yaml
- insert:
    - id: dsh-mmaping
      name: 'dsh-mmaping'
```
就这么简单。文件里其余全是注释。**profile patch 的 insert 只认 `id` + `name`**，`config` 是可选的第三项。

### 2.4 host 入口契约（`src/index.ts`，73 行，全文已读）

```ts
export const name = 'dsh-mmaping'
export const inject = ['tools']

interface HostContext {
  on(event: 'agent/created', handler: (payload: { agent?: CreatedAgent }) => Promise<void> | void): unknown
  readonly tools: { register(definition: ToolDefinition): () => void }
  readonly logger?: { warn(message: string): unknown }
}

export function apply(ctx: HostContext): void {
  for (const tool of mellosTools()) ctx.tools.register(tool)
  ctx.on('agent/created', async ({ agent }) => {
    if (agent === undefined) return
    try {
      const policy = resolveMappingPolicy(agent.session?.header?.cwd)
      agent.inject({
        id: randomUUID(), role: 'user',
        content: [{ type: 'text', text: sessionStartParagraph(policy) }],
        source: { kind: MESSAGE_SOURCE },
      })
    } catch (error) {
      ctx.logger?.warn(`dsh-mmaping: SessionStart injection failed: ${String(error)}`)
    }
  })
}
```

**三条可直接搬走的模式：**
1. **工具注册**：`ctx.tools.register(def)` 返回 disposer，注册生命周期由注册表管。
2. **会话启动注入**：`ctx.on('agent/created', ...)` + `agent.inject({id, role:'user', content:[{type:'text',text}], source:{kind}})` —— 这就是「告诉模型有哪些工具、当前策略是什么」的通道。**必须包在 try/catch 里，任何失败都只是 warning，不能破坏会话启动。**
3. **工作区锚定**：`agent.session?.header?.cwd` 是会话自己的工作目录。**dsh 进程可能从任何目录启动（DSH-X 从 `~/.dsh` 启动），所以一切路径都要锚在会话 cwd 上，不能用 `process.cwd()`。**

### 2.5 `ToolDefinition` 契约（`src/tools/define.ts:69`）

```ts
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Schema
  readonly output: {
    readonly schema: Schema
    readonly render: (args: unknown, value: unknown) => readonly ToolTextBlock[]
    readonly presentationMeta?: (args: unknown, value: unknown) => unknown
  }
  readonly execute: (args: unknown, exec: ToolExec) => Promise<unknown>
}
export interface ToolTextBlock { readonly type: 'text'; readonly text: string }
```
`presentationMeta` 是给客户端卡片用的——`mmap_open` 的内联地图卡就是从这里拿到持久化 meta 的。

### 2.6 client 入口契约（`src/client/index.tsx`，全文已读）

```ts
export const inject = ['slots', 'locale', 'sessions', 'remote', 'remote.workspaceFiles']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mmaping: dictionaries')
  const t = ctx.locale.bind(NS)
  const row: ConversationViewRow = {
    name: 'conversation.view',
    id: 'dsh-mmaping-map',
    order: 20,                 // Chat 是 0，Trajectory 是 10
    locale: NS,
    label: () => t('view.map'),
    inject: (sessionId: string) => ({ loader: createMapLoader(ctx, sessionId), t, watch: (...) }),
  }
  const cardRow: ToolViewRow = { name: 'tool.call.toolview', key: 'mmap_open', locale: NS }
  ctx.slots.inject('conversation.view', () => ctx.slots.register(row, MapView))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(cardRow, OpenMapCard))
}
```

**两个 slot 名**：
- `'conversation.view'` —— 对话视图环（Chat order 0 / Trajectory order 10），`inject(sessionId)` 返回给组件的 props。
- `'tool.call.toolview'` —— 按**工具线名** `key` 分派的工具调用卡片。

**事件驱动刷新模式**（值得抄）：
```ts
watch: (onActivity: () => void): (() => void) => {
  const binding = ctx.sessions.binding(sessionId)
  if (binding === undefined) return () => {}
  return binding.eventSource.subscribe((window) => {
    // 扫 window.entries，把 tool/call 的 name 按 callId 记下，
    // tool/result 时若 name 以 'mmap_' 开头就 onActivity()
  })
}
```
`ctx.sessions.binding(sessionId).eventSource` 提供 `getSnapshot()` 与 `subscribe(listener)`，window 形如 `{entries: [{type:'event', event:{type,data}}, {type:'transient',...}], hasMore}`。

### 2.7 client 的类型策略（**这条最重要**）

`src/client/types.ts` 头注释原文：
> `The bundle never imports @deepseek-ai/* client packages: the loader's module table provides the services at runtime, and every interface here is the exact slice those packages document. Keeping the types local avoids a peer-version coupling on a moving pre-stable API while the runtime contract stays the shipped one.`

即：**客户端插件不声明对 `@deepseek-ai/*` 客户端包的依赖，而是把用到的服务切片手写成本地 interface。** 这样做的好处是 peer 版本变动不会把插件卡死。dsh-bot 必须照做。

### 2.8 打包机制（`tsdown.config.ts`，全文已读）

两个构建目标：
- **host**：`entry src/index.ts` → `lib/index.js`，`format: 'esm'`，`platform: 'node'`
- **client**：`entry src/client/index.tsx` → `lib/client.js`，`format: 'cjs'`，`platform: 'browser'`，`minify: true`

client 目标的关键配置：
```ts
const EXTERNALS = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis']
deps: { neverBundle: [...EXTERNALS], alwaysBundle: (id) => !EXTERNALS.includes(id) },
outputOptions: {
  entryFileNames: 'client.js',
  codeSplitting: false,
  banner: `window.__ModuleLoader__.load({ id: "dsh-mmaping", factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
}
```
→ **浏览器 bundle 的协议是**：外层用 `window.__ModuleLoader__.load({id, factory})` 包住，factory 收到 `require`，内部是 CJS 语义（手动注入 `module`/`exports`）。`react`、`react/jsx-runtime`、`@deepseek-ai/cordis` 从 loader 的 module table 里 require，其余全部内联进单文件。

---

## 3. 注入服务 → 包 对照表（Lead 亲验）

用 `Select-String` 扫 `@deepseek-ai/*/lib/types/*.d.ts` 里 `\b<service>\s*:` 得到：

| 服务名 | 声明它的包 |
|---|---|
| `llm` | `dsh-llm`（另见 dsh-acp、dsh-tool-subagent 的引用） |
| `tools` | `dsh-tools` |
| `systemPrompt` | `dsh-system-prompt` |
| `sessionController` | `dsh-api-session-controller` |
| `sessionTitle` | `dsh-session-title` |
| `workspaceRegistry` | `dsh-workspace` |
| `connection` | `dsh-client-connection`（另见 dsh-llm-deepseek、dsh-mcp-client） |
| `agentTeams` | `dsh-experimental-agent-team` |

**DS Bot 的 `inject` 与上表的对应**（`index.js` 声明的 8 个）：
`llm` · `tools` · `systemPrompt` · `sessionController` · `sessions` · `sessionTitle` · `workspaceRegistry` · `connection`
→ 其中 `sessions` 在类型定义里没搜到（DS Bot 用的可能是另一条路径，或该服务名来自 host 侧的另一套），这一条**留给子代理的边界报告确认**。

---

## 4. 对 dsh-bot 的直接启示

1. **基座已有，别重造**：roster、peer 消息、共享任务板、Web UI 四件都在 `@deepseek-ai/dsh-experimental-agent-team*` 里。dsh-bot 的价值在它上面加东西。
2. **要接替 subagent 控件就照 profile bundle 的做法**：写自己的 `cordis.patch.yml`，`disabled: true` 掉 `tool-subagent*` 那几行，再 insert 自己的行。
3. **工程骨架照 `dsh-mmaping` 起**：`src/index.ts` + `src/client/index.tsx` + `src/client/types.ts` + `tsdown.config.ts` + `cordis.patch.yml`。这套已经跑通、已在用。
4. **一切路径锚 `agent.session.header.cwd`**，不用 `process.cwd()`。
5. **客户端类型自己写**，不 import `@deepseek-ai/*` 客户端包。
6. **会话启动注入是「让模型知道插件存在」的唯一通道**，且必须容错。

---

## 5. 尚未确认的（留给边界报告）

- `sessions` 这个 inject 名对应的包（类型扫描未命中）。
- `dsh-experimental-agent-team` 的 `Config` 完整字段（只从 README 读到 4 个限制项）。
- 客户端插件除了 `conversation.view` 与 `tool.call.toolview` 还有哪些 slot 名。
- `dsh-api-gateway` 暴露的 remote 命名空间全集（已知有 `workspaceFiles`）。
- 插件如何注册 **HTTP 路由**（Grok Bot 的多端同步需要，DSH 是否有对应 API 未确认）。
