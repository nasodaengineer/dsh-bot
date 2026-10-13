# dsh-bot

对标 Grok Bot 的 DSH（DeepSeek Harness）插件：Bot 团队、持久身份、例程与连接器。

本分支是 **P0（票 #5）+ P1（票 #6）**：插件地基 + Bot 名册 + 人格注入 + 单 Bot 可用（模型 / 工具 / 凭据 / 审批 / cron 例程）。

## P0 已实现

1. **插件工程**：`package.json`（`type: module` / `main: lib/index.js` / `dsh.bundle.patch` / `exports` 含 `./client` 占位）+ `cordis.patch.yml`（insert 一行）+ `tsdown.config.ts` 双目标（host esm/node；client cjs/browser，ModuleLoader 协议包裹）。
2. **host 入口**：`name = 'dsh-bot'`；`inject = ['agentPresets', 'systemPrompt', 'storage']`（静态 inject 只放 P0 真正用到的服务）；`apply(ctx)`。
3. **状态层**：`src/identity.ts` —— 基于 `ctx.storage`（KV hub）的 Bot 身份存储。KV unit `dsh-bot`（表 `bots` + `selection`，version 1）。`json` backend 或 `ctx.storage` 缺失时降级为进程内 Map 并 `warn`（降级不抛错、不破坏激活）。
4. **Bot 名册**：`src/roster.ts` —— 分层混合：持久身份存自有 KV 状态（原生 roster 扁平不可变，无重命名/删除），装配面透传原生 `ctx.agentPresets` 的 `register/list/mount/select`；preset id 统一加 `dsh-bot:` 前缀。
5. **人格注入**：`src/persona.ts` —— `ctx.systemPrompt.section({ name: 'dsh-bot:persona', order: 100 })`，把选中 Bot 的 Name/Title/Description 拼进提示词段；名册为空时输出空文本（渲染层丢弃空段）。

## P1 已实现（票 #6）

1. **模型选择**（`src/model.ts`）：目录聚合（`llm.listProviders` × `listModels`）+ `selectModel`（转发 `sessionController.selectModel`，Session 侧由宿主持久化）；Bot 侧默认选择写自有 KV `selection` 表（key `model`）。`runtime.models`。
2. **工具集**（`src/bot-tools.ts`）：`ctx.tools.register` 注册 `bot_roster_list` / `bot_schedule_create` / `bot_schedule_delete` / `bot_schedule_list`；`execute` 永不抛错（错误折叠进返回值）。MCP（`createMcpBridge`）只做接口切片：server 名文法 `1-32 位 [A-Za-z0-9_-]`、公开工具名 `mcp__<server>__<raw>`、配置登记；**真正的 dsh-mcp-client 接线是 P2 的事**（`connect()` 现在固定返回 `false`）。
3. **凭据**（`src/bot-credentials.ts`）：透传 `ctx.credentials` 的 resolve/describe/set/unset/listRecords，**不自建 secrets**；ref 文法校验（POSIX shell 标识符，至多一层 `scope/id`）；set 空值前置拒绝（提示用 unset）。
4. **审批**（`src/bot-approval.ts`）：包装 `ctx.approval.request` 的 fail-closed 语义——`ApprovalOutcome` 只有 `allowed-once` 算授权，`unavailable`（策略 `ask` 且无 answerer）一律不放行；三档权限预设走 `ctx.permissionPresets`（catalog/current/set，未知档位抛错）。
5. **例程**（`src/schedules.ts`）：`ctx.schedule.create` 六形态封装（after/at/every/daily/weekly/cron，恰给一种），**必须绑定 root Session**（宿主对子代理 Session 报 `subagent_session`，本插件要求装配方显式传 `rootSessionId`，缺省不挂载并 warn）；pause = 记住请求 + 宿主 delete，resume = 按原请求重建（新 id）。
6. **P0 接缝收口**：`selectedId` 落 KV（`selection` 表）；`onAgentCreated` 接会话启动人格注入（`agent.inject` 文本，包 try/catch，路径锚 `agent.session?.header?.cwd`）。

### inject 清单（本票的取舍）

- **静态 `inject`**（缺了插件就不起）：仍只有 P0 三件套 `agentPresets` / `systemPrompt` / `storage`。
- **运行期 `ctx.inject([...], attach)`**（到齐即挂、掉了重挂、不阻塞 fiber）：`['llm','sessionController']`、`['tools']`、`['credentials']`、`['approval']`、`['schedule']`。理由：这五个服务要么插件可无之降级运行（模型目录/工具/凭据/审批各自独立），要么是条件挂载（`schedule` 只在 Automation tasks bundle 打开时存在，ds-bot 同款先例）；放进静态 inject 会让整个插件 fiber 卡在等一个可选服务。
- `permissionPresets` 不 inject：只在审批运行时用 `ctx.permissionPresets` 访问器按需取，缺失时预设功能降级并 warn。

### 部署假设（storage backend）

本插件假定部署里存在名为 **`json`** 的 storage backend（`@deepseek-ai/dsh-storage-json` 注册，标准 DSH Web 档自带）。backend 缺失时身份/选择降级为进程内存储并 warn，重启即丢——不自带 backend、不声明 peer 依赖（P3 再评估）。

## 命令

```sh
npm install        # 仅 devDependencies：tsdown / typescript / @types/node
npm run build      # tsdown 双目标 → lib/index.js + lib/client.js（+ 各模块单文件产物）
npm run typecheck  # npx tsc --noEmit
npm test           # node --test，全离线（fake ctx，不需要 DSH 运行、不需要 API key）
```

`lib/` 是发布产物，随源码一起提交（不手改）。

## 工程纪律

1. **Plugin only**：不 patch DSH，不 import DSH 安装目录内的文件；所有 `@deepseek-ai/*` 服务契约以本地 interface 切片手写（`src/types.ts`），规避 pre-stable API 版本耦合。
2. **测试数据**只放 `.dsh-test-*/`，绝不指向 `~/.dsh`。
3. 一切路径锚 `agent.session?.header?.cwd`，不用 `process.cwd()`。
4. `agent/created` 注入必须包 try/catch，失败只 `warn`（钩子封装 `onAgentCreated` 已按此实现）。
5. `dsh.client.inject` / slot 名写错会静默不出现——client 侧是可编译最小占位，面板是 P2 的事。

## 留给后续阶段的接缝

- **P2**：dsh-mcp-client 真接线（`src/bot-tools.ts` 的 `McpBridge.connect` 是接口位；server 配置形状已冻结）；client 面板（名册 UI、Bot 详情页）；`ctx.agentTeams` 的 spawn/消息/任务板。
- **P3**：记忆（换 `ctx.storage` KV）、模板分发、自建 HTTP 端点、自带 storage backend 或显式 peer 依赖。
