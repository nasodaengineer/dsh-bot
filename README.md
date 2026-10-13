# dsh-bot

对标 Grok Bot 的 DSH（DeepSeek Harness）插件：Bot 团队、持久身份、例程与连接器。

本分支是 **P0（票 #5）**：插件工程地基 + Bot 名册 + 人格注入。

## P0 已实现

1. **插件工程**：`package.json`（`type: module` / `main: lib/index.js` / `dsh.bundle.patch` / `exports` 含 `./client` 占位）+ `cordis.patch.yml`（insert 一行）+ `tsdown.config.ts` 双目标（host esm/node；client cjs/browser，ModuleLoader 协议包裹）。
2. **host 入口**：`name = 'dsh-bot'`；`inject = ['agentPresets', 'systemPrompt', 'storage']`（只 inject 本票真正用到的服务）；`apply(ctx)`。
3. **状态层**：`src/identity.ts` —— 基于 `ctx.storage`（KV hub）的 Bot 身份存储。KV unit `dsh-bot`（表 `bots`，version 1）。`json` backend 或 `ctx.storage` 缺失时降级为进程内 Map 并 `warn`（降级不抛错、不破坏激活）。
4. **Bot 名册**：`src/roster.ts` —— 分层混合：持久身份存自有 KV 状态（原生 roster 扁平不可变，无重命名/删除），装配面透传原生 `ctx.agentPresets` 的 `register/list/mount/select`；preset id 统一加 `dsh-bot:` 前缀。
5. **人格注入**：`src/persona.ts` —— `ctx.systemPrompt.section({ name: 'dsh-bot:persona', order: 100 })`，把选中 Bot 的 Name/Title/Description 拼进提示词段；名册为空时输出空文本（渲染层丢弃空段）。

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
3. 一切路径锚 `agent.session?.header?.cwd`，不用 `process.cwd()`（P1 接会话启动注入时生效）。
4. `agent/created` 注入必须包 try/catch，失败只 `warn`（钩子封装 `onAgentCreated` 已按此实现）。
5. `dsh.client.inject` / slot 名写错会静默不出现——本票 client 侧是可编译最小占位，面板是 P2 的事。

## 留给后续阶段的接缝

- **P1**：`selectedId` 目前是进程内选择器 → 持久化到 KV；`onAgentCreated` 钩子接会话启动人格注入；自带 storage backend 或明确依赖 `dsh-storage-json`。
- **P2**：client 面板（名册 UI、Bot 详情页）；`ctx.agentTeams` 的 spawn/消息/任务板。
- **P3**：记忆（换 `ctx.storage` KV）、模板分发、自建 HTTP 端点。
