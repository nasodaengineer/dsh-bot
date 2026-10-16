# GLOSSARY

术语以本文件为准；实现细节不进这里。

## Bot
dsh-bot 管理的一个持久身份：名字、颜色、人格、记忆路径存自有 KV；装配（spawn/生命周期）用原生 `agentPresets` / `agentTeams`。一个 Bot ≠ 一个服务对象，是「身份（我们管）+ 实例（宿主管）」的组合。

## 群聊（Group）
一个隐藏 root Session + 宿主侧投递构成的「多 Bot 同一会话」。群不是 Session 的属性，是我们数据模型里的实体，Session 只是它的执行载体。

## 投递（Delivery）
宿主把一条群消息转成对群 Session 的输入的过程。投递决策（谁说话、要不要说话）由 Jev 决策模型做类型化判定，不由自由小模型生成。

## 审批代答（Approval Proxy）
隐藏 Session 发起的 `approval.request` 永远等不到人——宿主拦截它，在群聊里渲染待批卡，人应答后由宿主代答。语义：没有代答机制的群聊审批等于永久挂起。

## 身份事实源（Identity Source of Truth）
Bot 的持久身份以自有 KV（'dsh_bot' unit）为准；`agentPresets` 的 preset 是它的投影（`dsh-bot:<id>` 前缀），两者冲突时以 KV 为准。

## 群载体（Group Carrier）
一个群绑定一个真实存在的隐藏 root Session（群记录里的 `sessionId`）。建群时动态创建（`sessions.create()`），载体不可用则群聊拒绝服务（fail-visible），不假装在工作。群载体也是审批拦截的过滤器：只有发源于群载体 Session 的审批才转待批卡。

## 审批拦截（Approval Interception）
全局 `approval/request` 瀑布监听 + 群载体 Session 过滤：非群会话立即 `next()` 下传（零行为变化）；群会话的请求由 dsh-bot 认领转待批卡，人工应答（`bot_group_answer`）后把 outcome 回灌给宿主。fail-closed：超时/不可用返回 `'unavailable'`，绝不代答放行。

## 会话内工具面（In-session Tool Surface）
每个能力同时给两个入口：`bot_*` 工具（会话内 agent 调用）+ HTTP 端点（外部触发）。工具 execute 永不抛错（safeExecute 包裹，返回值无损化清洗）。

## 已知接缝（Known Seams）
- 群成员的回复进 Session 执行，不回写群历史——群记录只含「谁被选中投递」，不含成员的执行结果。
- MCP 能力只做接口切片（命名校验 + 工具名映射），真实 MCP server 接线未通。
