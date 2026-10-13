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
Bot 的持久身份以自有 KV（'dsh-bot' unit）为准；`agentPresets` 的 preset 是它的投影（`dsh-bot:<id>` 前缀），两者冲突时以 KV 为准。
