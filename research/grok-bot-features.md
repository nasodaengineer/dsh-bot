# Grok Bot 功能面清单

> 调研时间：2026-10-13
> 对标对象：xAI 的 **Grok Bot**（AI teammates / always-on agents，带自己的云计算机）
> 方法：`web_search` 在本会话不可用（报 `multiple usable web providers are registered (deepseek-official, auto); configure one explicitly`），全程用 `web_fetch` 直取官方页面。
> 口径：**一个能力域 = 能数出 ≥1 条具体功能条目，且该域至少有一条官方出处 URL 支撑。** 每条条目尽量保留官方原文关键词，便于回溯。

---

## 0. 信源清单

| # | URL | 抓取 | 内容性质 |
|---|---|---|---|
| S1 | `https://x.ai/news/introducing-grok-bot` | HTTP 200 | 发布公告（Aug 11, 2026），讲设计理念与内部用法 |
| S2 | `https://x.ai/bot` | HTTP 200 | 产品主页，讲价值主张、定价档位 |
| S3 | `https://x.ai/changelog/bot` | HTTP 200 | **金矿**：v0.56.0–v0.68.1 逐版本功能增量（Sep 17 – Oct 7, 2026） |
| S4 | `https://x.ai/bot/guides` | HTTP 200 | 指南索引，9 个分类 |
| S5 | `https://x.ai/bot/marketplace` | HTTP 200 | 市场分类与样例 Bot |
| S6 | `https://x.ai/bot/guides/templates-for-grok-bot` | HTTP 200 | 模板机制（分享什么、不含什么） |
| S7 | `https://x.ai/bot/guides/how-i-run-multiple-teams-of-grok-bots` | HTTP 200 | 多团队协作的实验模式（channel + roster + 看板） |
| S8 | `https://x.ai/bot/guides/grok-bot-for-support` | HTTP 200 | 支持队列的五个工种 + routine |
| S9 | `https://x.ai/bot/guides/grok-bot-for-engineering` | HTTP 200 | 工程舰队、cloud agent 编排、mini org |
| S10 | `https://x.ai/bot/guides/grok-bot-for-work` | HTTP 200 | 四个个人 Bot + Bot Boss 汇聚（含完整 prompt 模板） |
| S11 | `https://x.ai/bot/use-cases` | HTTP 200 | 56 个用例，分 9 类 |
| S12 | `https://docs.x.ai/grok-bot/overview`、`/get-started` | **抓取失败**（`TypeError: fetch failed`） | 官方文档站不可达，相关细节只能从 S1–S11 与 changelog 反推 |

**覆盖缺口（明说）**：`docs.x.ai/grok-bot/*`（含 `team-bots` 专页）全程抓不到。Team Bots 的细节因此**全部来自 changelog v0.61.0 及其后版本**，而不是官方文档。

---

## 1. Bot 本体与人格配置 —— 11 条

出处：S3（v0.58.0 / v0.59.0 / v0.60.0 / v0.64.0 / v0.66.0 / v0.67.0 / v0.68.0 / v0.68.1）、S10

1. 从 New chat 创建 Bot（"Create a Bot from New chat reliably opens the new Bot"）。
2. 可编辑 profile：Name / Title / Description（v0.57.0 把 Edit Profile 从侧边栏菜单移到 conversation details）。
3. 头像编辑器：方形、sparkle、clover、flower、heart、house、star 形状；v0.64.0 刷新为"bigger eyes"。
4. **Bot 颜色**：1:1 聊天里你的消息用该 Bot 的颜色；Settings → General → Accent 设 Black 可关闭。
5. **每 Bot 独立的 voice / speed / language**，且"keeps the voice, speed, and language you set for it instead of resetting them"。
6. **Primary Bot**：带星标，会主动发现可接手的工作并提议（v0.66.0，需 Grok Bot 0.59.0+）。
7. Team Bots 不出现在 primary Bot 选择器里；被拒绝时提示 "Team Bots can't be a primary Bot"。
8. 侧边栏顺序跨 reload / relaunch 保持；打开 Bot 后它留在原位。
9. Hidden Bots：侧边栏底部可折叠区，菜单里有 Show in sidebar 恢复。
10. 状态短语："Thinking it through"、"Working on your computer"、"Waiting for you"；不前缀 Bot 名。等待状态在不再等待时清除，不会卡住。
11. 删除 Bot 会释放它在共享计算机上占的屏幕（v0.62.0）。

---

## 2. 云计算机（Computer）—— 12 条

出处：S1、S3（v0.57.0 / v0.58.0 / v0.59.0 / v0.62.0 / v0.67.0 / v0.68.1）

> **关键澄清**：官方口径是 **Bots share a computer of their own in the cloud**（S1）——一台**共享的**云计算机，**每个 Bot 分到一块屏幕**，而不是每个 Bot 一台机器。v0.62.0 的 "Deleted Bots free their screens on the shared computer" 是直接佐证。这条对 dsh-bot 的可行性判断很重要。

1. Bot 共享一台云端计算机，"jobs do not stall when you step away"。
2. 屏幕分辨率 **1920 × 1200**（v0.68.1 从 1280 × 800 提升，"giving more room when you watch it or take over"）。
3. 每个 Bot 一块屏幕；屏幕被占满会导致其他 Bot 的浏览器动作失败。
4. **观看与接管**：可全屏看 Bot 操作（v0.68.0 修掉了"打开全屏先闪一下 Connecting"）；UI 上有 "Computer / You're in control / Working"。
5. Settings → Computer 显示你的**其他计算机**并带 Remove；移除后提示重启 Grok Bot 才能加回。
6. **Terminate Inactive Computers**（Enterprise）：成员 30 天未使用则终止其计算机。
7. **Route traffic through this computer**（团队级开关，管理员可关；关闭后 Settings → Computer 会说明）。
8. 计算机短暂不可达、或自动更新失败时，**聊天继续工作**，不弹对话框打断你。
9. 本地计算机重启后 Bot 会**重连**，而不是报告未连接。
10. 性能改进：动作结算更快、截图返回更快、新窗口跳过 5 秒等待（v0.68.1）。
11. **卡死自救**：Stop 或新消息能在约 30 秒内结束卡在无响应步骤上的 Bot；卡在无响应命令/计算机上的 Bot 会自己停下并留一条说明，你的下一条消息接着往下走。
12. 计算机操作有"接管"语义——人可以随时接手，Bot 与人共用一个屏幕。

---

## 3. 浏览器与网页操作 —— 12 条

出处：S3（v0.57.0 / v0.60.0 / v0.62.0 / v0.63.0 / v0.67.0 / v0.68.1）、S9

1. 每个 Bot 有自己的浏览器；多个 Bot 在同机各用各的浏览器时互不干扰。
2. 标签页崩溃能恢复；掉线后能重连。
3. 支持大文件上传。
4. **卡住的页面 25 秒后放弃**。
5. 登录状态在浏览器重启后保持（"A Bot stays signed in to websites when its computer's browser restarts"）。
6. 网页动作提速：点击/表单提交后的页面稳定等待更短。
7. 读页面 + 填表；**Secure Forms** 填到 Bot 已打开的页面里。
8. 结账卡字段用 Secure Form 而不是屏幕接管（"checkout card fields get a Secure Form instead of a screen handoff"）。
9. **链接预览卡**：悬停 PR 链接显示状态与标题；私有 Notion 页、GitHub issue/PR、Slack 消息用你已连接的账号显示真实标题。
10. **内置站点指南**：热门 travel / food / shopping / shipping 站点带直链与步骤。
11. **截图能力**：cloud agent 能截图，Bot 用多模态确认视觉改动是否生效（S9 的"complete feedback loop"）。
12. 需要重新登录时（X / Vercel 等）Bot 显示 **reconnect card**，而不是反复重试或直接放弃。

---

## 4. 例程与触发（Routines / Triggers）—— 12 条

出处：S3（v0.63.0 / v0.67.0）、S8、S9、S10

1. **Routine = 按日程重复的动作**（"a Routine (aka Automation) that repeats every day or hour"）。
2. **教一次就学会**：让 Bot 跟着你走一遍工作流，它把步骤记下来存成 routine，下次自己跑，并接受你的纠正。
3. Routine 的 **Pause / Resume / Test / Edit / Delete**（详情面板里右键 routine）。
4. 失败的 pause/resume 会显示错误。
5. 删除的 routine 芯片显示 `(deleted)`。
6. 日程不会声称一个并不重复的间隔。
7. **触发器**：除定时外还能监听事件（Slack thread、GitHub PR 等）。
8. **默认停用**：guides 里的官方 prompt 模板反复写 "clocks stay Disabled until I hit Enable" / "Create Disabled until I hit Enable"。
9. **cron 式时间**：模板里直接给表达式，如 `5 9,16 * * 1-5`（工作日 9:05 与 16:05）。
10. 告警型 routine：每小时检查，出问题就发告警。
11. 结果可在手机上随时查看（"review the results on your own schedule, from the Grok Bot Mobile App"）。
12. **P0 紧急流程**（S9）：临时 routine 每 5 分钟读 transcript、盯进度与推理，在 cloud agent 开始烧无谓时间时主动 steer。

---

## 5. 记忆（Memories）—— 10 条

出处：S1、S2、S3（v0.59.0 / v0.61.0）、S6、S9

1. 跨会话保持 context（"They remember conversations, learn how you like things done"）。
2. save / forget memory（v0.59.0 修了"save and forget memories reliably"）。
3. 大量记忆或技能时仍能快速回复，不出现数秒停顿。
4. **每个用户的私密笔记**：Team Bot 跨 app、Slack、routine 给每个人保留各自的私密笔记。
5. 记忆带归属（产品截图里出现 "Updated memory for **Account Manager**"）。
6. **Bot 之间互相学习**（"Bots keep context and learn from each other. Show one a workflow today, hand off the project by Friday."）。
7. 每个 Bot 有**各自的记忆系统与有限上下文**（S9）；专注单一领域时表现最好，因为领域内的规格与设计原则更锋利。
8. 记忆随协作变锋利：几轮任务后学会你的语气、边界情况，知道何时该 ping 你、何时继续。
9. 主动性随时间提升：从"你问才做"到"在你开口前接活"，并知道什么需要你注意。
10. 模板里的记忆：**保留重要记忆，默认排除个人或内部专属的记忆**（S6）。

---

## 6. 权限与审批（Approvals）—— 11 条

出处：S3（v0.58.0 / v0.59.0 / v0.61.0 / v0.63.0 / v0.64.0 / v0.68.0 / v0.68.1）

1. **Approval card 按名字问**是否允许该 Bot，并**引用它的指令原文**（v0.68.0）。
2. 规则三态：**Ask first / Always allow / Custom Rules**（Settings 里保存的规则在 v0.68.0 改称 Custom Rules）。
3. 审批卡说明**是哪条规则触发的**：是 Ask first 暂停了动作，还是 Always allow 新增了规则；带 Edit rule 直接去改。
4. **Auto-review**：过期卡提供 "Always allow this in the future"，避免重复问同一动作。
5. 工作时新增的 auto-review 规则会保存下来。
6. 存在**独立 review agent** 的概念（审批不靠主 Bot 自己判）。
7. Slack 场景：需要审批时 Bot 发一张**只有你能回答**的 "Review an action" 卡，而不是把动作丢掉。
8. **Secure Forms**：Bot 需要登录或其他表单时，聊天卡打开一个安全表单窗口，显示站点名与图标。
9. Team Bot 使用你已连接的插件前先问；**Always allow** 可覆盖"该 Bot"或"所有 Team Bot"，直到你 Clear connector preferences。
10. **自主性分级**：低风险自动放行、高风险等审批（S9 的 "If the review is highly confident and the blast radius is low, the PR is merged automatically"）。
11. 审批是**异步**的：Bot 干到需要人判断时才回来找你（S1 的 "only come back when something needs your approval"）。

---

## 7. 连接器与凭据（Connectors / Secrets）—— 12 条

出处：S3（v0.59.0 / v0.60.0 / v0.61.0 / v0.62.0 / v0.63.0 / v0.64.0 / v0.67.0 / v0.68.0）、S8

1. **Connect Apps**（原 Marketplace，v0.67.0 改名）：一键 authorize。
2. 搜索框下带分类芯片，Recommended for you 排在前面，网页端有 Bot templates。
3. **多账号**：同一个连接器可连多个账号（labeled Outlook account、第二个账号给 Authorize 而不是显示 Added）。
4. 已连接的 Google 账号显示**邮箱地址**而不是 default。
5. 连接器卡在需要重新登录或加账号时，给出对应账号的 Authorize。
6. **1Password 集成**：未连接时 Bot 在聊天里用表单要站点登录；只有装了 app 才提供 Connect 1Password。
7. **Team Secrets**（Enterprise）：管理员在 dashboard 上存，Team Setup 脚本以**环境变量**形式接收。
8. 需要登录时 Bot 在聊天里发卡；**你签完它自己恢复任务**（"it resumes the task on its own once you finish signing in"）。
9. 连接失败会说明原因或提示链接过期，Reopen / Retry 重新开始。
10. 另一个 app 占用该连接器的登录端口时，连接仍能完成。
11. **TLS 检查代理网络**下，用本机安装的根证书完成登录与连接。
12. 从 Marketplace 添加需要登录的插件时，**立即开始登录**，不再停在 Added。

---

## 8. 技能与插件（Skills / Plugins）—— 7 条

出处：S3（v0.62.0 / v0.63.0 / v0.68.0 / v0.68.1）、S6、S9

1. **Skills**：可被调用的技能，S9 里的实例有 `/lingxi-design`（视觉）、`/react-native-best-practices`（代码质量审计）、`/lingxi-review`（架构评审）、`/lingxi-product`（产品决策）。
2. Bot 能**按你的个性化指导智能调用**额外技能，而不是每次显式点名。
3. **Plugins**：Gmail、GitHub、Cursor、pstack 等（S6 的模板详情里可见）。
4. **MCP servers** 属于插件范畴，但"非标准插件（MCP server、其他脚本或代码）不随模板分发"。
5. 命令面板搜索也能找到插件，Enter 打开插件页。
6. Marketplace 专注插件：Featured Bots 与 Bot 搜索结果不再出现，搜索框文案改为 "Search plugins"。
7. v0.68.1 **移除**了在 composer 里输入 `/` 弹出技能与动作菜单的行为。

---

## 9. 模板与团队分发（Templates / Team Bots）—— 22 条

出处：S3（v0.61.0 / v0.62.0 / v0.63.0 / v0.64.0 / v0.66.0 / v0.67.0 / v0.68.0 / v0.68.1）、S6

> 这是 Grok Bot **最厚的一域**，也是 changelog 里条目最密集的地方。分两组。

### 9a. Templates（7 条）

1. **模板 = recipe，不是 meal**：打包的是 bot 的 instructions、相关 memories 与 skills、以及指定的 plugins（S6）。
2. 设置页右下角有 **Share as Template** 按钮；点击**不会**让 Bot 上线，模板是匿名化的私有版本。
3. **不含**：secrets、个人或私有 skills、私有信息、自定义代码与脚本。
4. 分享范围二选一：**Public 链接** 或 **仅团队**；发布后拿到链接，Copy Link 可发给别人。
5. **View Details** 能看清模板里到底包含什么（context + memories + integrations）。
6. 别人点 **Add to Grok Bot → 审查 → Add Bot**，得到一份**独立副本**；模板里带的插件需要新 Bot 重新安装（但会带着它们）。
7. 复杂模板可在指令里**编码 setup 步骤**（尤其是需要 API key 或自定义 MCP server 的场景）。

### 9b. Team Bots（15 条）

8. **Team Bots**：把一个 Bot 发布给整个团队，队友在 app 或 Slack 里各自对话（各在自己的会话里）。
9. **Publish to Team**（Share 菜单）：可做一份**带聊天与记忆**的团队副本，或 **Start fresh**；原 Bot 保持私有。
10. 新 Team Bot 走**卡片式引导**（plugins → secrets → skills → files，逐卡推进，卡上显示 "Step 2 of 5"），在你 Publish to team 之前只有你能看见。
11. Owner 可编辑 name / description / plugins / secrets / skills / files / Slack app；**Unpublish** 收回。
12. **Managers**：创建者可添加队友为管理者，管理者可改 profile / skills / plugins / secrets / Slack app。
13. 队友在 **New chat → Team Bots** 找到，加进侧边栏后拿到带 **Try asking** 建议的问候。
14. 队友的使用**计入自己的额度**；Bot 给每个人**跨 app / Slack / routine 保留私密笔记**。
15. Team Bot 在 Slack：回复 thread、读已加入的频道、答 workflow mention、发起新帖、保持链接/代码/表格完整。
16. 在 Slack 里可让 Team Bot **设置/修改/暂停/删除你的 routine**；需在 Settings → General → Team Bots 里关联 Slack 账号。
17. **Team admin** 可从 dashboard 的 Manage team bots 为**整个团队或指定组**添加，成员无法隐藏。
18. Manage Team Bots 页支持按 Bot 或创建者名搜索，并删除队友的 Team Bot。
19. Team Bots **不出现在 primary Bot 选择器**里。
20. **Copy link** 分享的是 x.ai 链接，且已分享过的链接继续有效。
21. Team Bot 在它跟的 Slack thread 里，对不需要它的未标记回复（如只有 emoji 的回复）**保持安静**。
22. 名字被 Slack 拒绝（emoji、非拉丁字符）的 Team Bot，可用一个 Slack 安全名加入 Slack。

---

## 10. 多 Bot 协作（Multi-Bot / Group Chat）—— 10 条

出处：S1、S2、S3（v0.59.0 / v0.68.1）、S7

1. **同时跑多个 Bot**，各自并行工作（"one on a project, one on outbound, one on systems"）。
2. **一个 Bot 管其他 Bot**：chief of staff 坐在顶上，下面是各 lane 的专家（inbox、expenses、recruiting、bug fixes、operations）。
3. **Bot 之间独立互发消息**，在 thread 里共享 context。
4. 项目重叠时，Bot 们在同一 account / project 上**自动保持一致**，不需要你在聊天之间粘贴笔记。
5. **群聊**：把几个 Bot 放进同一个 thread，它们**互相传递工作、分配 ownership**，只在需要判断时才拉你进来。
6. **实验模式（S7）**：一个项目 = 侧边栏一个 channel = 一个 roster。`projects`（复数）Manager bot 负责高层协调，带一个 Project Ops 技能负责"创建项目、开频道、配人"。
7. **配人规则**（S7 原文）：优先复用已有 Bot；除 PM 外最多提议 5 个；每频道上限 6 个 Bot；只有 bench 上没有合适的才新建，且**需你点头**。
8. **Bot 卡住时标记 `Blocked` 并在频道里 ping 你**；其余时间你只是看着卡片在板上移动。
9. **优先级仲裁**：你给一个正忙的 Bot 发消息，它**先答你**，再处理来自其他 Bot / Cloud Agent / 后台任务的排队更新。
10. 协调形态刻意模仿人类团队：一块板、一个经理、专家认领任务、一个 Blocked 列、一个频道。

---

## 11. 项目与任务编排（Projects / Cloud Agents / Tasks）—— 9 条

出处：S3（v0.57.0 / v0.63.0）、S7、S9

1. **Project**（v0.57.0）：你开口，Bot 起一个 Project —— 本质是一个 **Cloud Agent**，它规划工作并**运行自己的 agents**。
2. Cloud Agents：Bot 可创建、读 transcript、审 PR 上附的 proof、发 follow-up（**排队消息**或**打断运行**）。
3. Cloud agent 可跑在**你自己的 worker 机器**上（如闲置的 Mac mini；Cursor Cloud private worker），适合需要 VPN 或特殊机器配置的场景，例如跑 iOS Simulator 并回传截图。
4. **监控与守候**：盯 transcript 与 artifacts（截图），完成时通知你、排队消息、出错时打断。
5. **Tasks tab**（Bot 详情面板）：列出 cloud agent 运行；删除或过期的运行会离开 Coding 列表，卡住的状态显示 "Status unavailable"。
6. **共享看板**（S9）：每个 engineer bot 管一个共享 Notion 数据库；每 30 分钟 review 一遍，检查每张 PR 的 bugbot 评论/安全发现是否成立、CI 是否失败、有无合并冲突。
7. **状态流转**：发现问题 → 立刻找 cloud agent 处理并把行移回 `Working`；一切正常 → 标 `Ready for Review` 并自动起一次 code review。
8. **自动合并阈值**：review 置信度高且 blast radius 低 → 自动 merge；否则等你回来审代码与 proof 再定。
9. **规模证据**：作者从"手管 15 个 cloud agent"变成"fleet 管 200+"。

---

## 12. 多渠道触达与客户端（Surfaces）—— 16 条

出处：S3（v0.57.0 – v0.68.1）、S1

1. **macOS 桌面 app + iOS app**，同一 thread 跨端接续（"pick up the same thread later on either surface"）。
2. 手机通知：每个 Bot 回复只通知一次；**不通知你正在电脑上看的那个 Bot**，电脑锁屏/休眠/空闲后恢复通知。
3. 停靠栏角标不计算已删除 Bot 的未读消息。
4. **Slack**：Team Bot 在 thread 回复、读已加入频道、答 workflow mention、发起新帖。
5. Slack 账号关联在 Settings → General → Team Bots。
6. **Bot 语音备忘**：播放时 transcript **逐词同步高亮**，点击某个词跳到该处播放。
7. **语音聊天**：队友可与 Team Bot 通话，通话留在各自的会话里。
8. 挂断通话时 Bot 若仍在工作，它会**做完并把结果发到聊天**。
9. **邮件草稿卡**：Gmail 与 Outlook 都能在聊天里审阅 Bot 写的新邮件，再决定发送。
10. 从草稿卡发**格式化邮件**（标题、粗体、列表）；草稿含签名与 logo。
11. Gmail 专项：可搜索 **Spam 文件夹**并把邮件移回收件箱；支持 **send-as 地址**与 From 选择器；reply-all 失败时草稿卡说 "Message not delivered" 而不是显示成已发送。
12. **Composer**：选中文本按 `Cmd/Ctrl+L` 或 Add to prompt 引用到下一条消息；输入 `-` 或 `1.` 起列表，Shift+Enter 加项、Tab 嵌套、Enter 仍然发送。
13. **拼写检查**：输入时给拼错的词加下划线，右键给建议与 Add to Dictionary，可用 "Check Spelling While Typing" 关掉。
14. **语言**：Settings 里可选多语言，含 Marathi / Tamil / Telugu / Swahili / Hausa（v0.68.0）与 Czech / Danish / Finnish / Hungarian / Norwegian Bokmål（v0.58.0）；Follow System 跟随系统。
15. **无障碍**：屏幕阅读器播报建议、新问题、消息作者；键盘焦点可见且在全屏查看器内保持。
16. **消息状态**：没发出去的消息显示 "Failed to send" + Resend / Delete，而不是卡在 "Not delivered yet"；超过 2 秒才出现小进度条；宽表格在窄窗口横向滚动而不是压成高列。

---

## 13. 交付物形态（Deliverables）—— 8 条

出处：S3（v0.57.0 / v0.61.0 / v0.62.0 / v0.68.1）、S8

1. **幻灯片**：Bot 与你一起做 deck，先给样例幻灯片让你选，最终交付 **PowerPoint 文件或 Google Slides**。
2. **格式化邮件**（见 12.10）。
3. **电子表格**（v0.56.0 版本标题 "GitHub, spreadsheets, and clearer approvals"）。
4. **报告 / infographic**：按你关心的指标生成自定义报告（S8 的第 5 个工种）。
5. **图片**：可一次往 Slack 发多张，且每张都会发出去（v0.62.0 修了只发第一张的 bug）。
6. **文件**：Bot 说在发给你的文件更可靠地到达聊天，而不是静默丢失。
7. **链接卡与预览**（见 3.9）。
8. **Library tab**（v0.62.0）：Bot 分享过的**页面、文件、链接**集中列出，按 Today / This week / Older 分组。

---

## 14. 治理、用量与企业能力 —— 9 条

出处：S1、S2、S3（v0.58.0 / v0.59.0 / v0.63.0 / v0.67.0）

1. **Usage & Billing**：显示套餐包含的用量与重置时间；触顶时显示完整横幅，带 Upgrade / Set Spend Limit / Request Upgrade 等按钮。
2. **用量独立**：Grok Bot 有自己的一份用量，与你的 Grok / Cursor 套餐分开，交给 Bot 的活不计入你已有用量。
3. Team Bot 的使用**计入使用者自己的额度**。
4. **Audit Logs**（Enterprise）：记录 computers、group chats、templates、skills、plugins、routines，以及删除或分享 Bot。
5. **Action Recording**（Enterprise）：记录更多 Bot 活动，含工具结果与**交接给 subagent 和 cloud agent**；对卡号与 access token 做**脱敏**。
6. **Team admins**：dashboard 上 Manage team bots；可存 Team Secrets。
7. 企业开关：Terminate Inactive Computers、Route traffic through this computer、Team Secrets、Audit Logs、Action Recording。
8. **套餐门槛**：SuperGrok / SuperGrok Plus / SuperGrok Heavy；Cursor Pro / Pro+ / Ultra；Cursor Teams Standard / Premium。桌面与 iOS 可用。
9. 企业用户走**等待名单**。

---

## 15. 客户端界面（Client UI）—— 12 条

出处：S3（v0.57.0 – v0.68.1）

1. **侧边栏**：Bot 列表 + 你自己的 sections；Unassigned 区可拖拽，或用 Move up / Move down（v0.68.0）。
2. Search 与 New chat 是侧边栏顶部的**圆按钮**，Connect apps 在页脚。
3. 聊天头部的 Bot 名点击打开 **conversation details**。
4. **居中列布局**（v0.59.0）：宽窗口下聊天与输入框居中，宽表格可跨列伸展。
5. **详情面板**：Library tab、Tasks tab、routine 右键菜单、Team Bot 的 counts 与 Publish 卡。
6. 消息用 **Bot 的颜色**（见 1.4）。
7. 链接显示**站点图标**，紧挨下划线的链接文字。
8. Emoji 反应带**弹出动画**。
9. **命令面板**可搜插件。
10. 通知文案说 Bot 在等你；每个 Bot 有通知开关。
11. **设置页**分区：General / Computer / Updates / Usage & Billing / Language / Microphone / Team Bots。
12. **自动更新默认开**（v0.65.0）：你离开时重启应用完成更新；Settings → Updates 可关。下载在电脑休眠后会续传；Mac 上从磁盘映像或 Downloads 运行的副本会提示 Move to Applications。

---

## 16. 统计与交叉核对

### 16.1 域与条目计数

| 域 | 条目数 |
|---|---|
| 1. Bot 本体与人格配置 | 11 |
| 2. 云计算机 | 12 |
| 3. 浏览器与网页操作 | 12 |
| 4. 例程与触发 | 12 |
| 5. 记忆 | 10 |
| 6. 权限与审批 | 11 |
| 7. 连接器与凭据 | 12 |
| 8. 技能与插件 | 7 |
| 9. 模板与团队分发 | 22 |
| 10. 多 Bot 协作 | 10 |
| 11. 项目与任务编排 | 9 |
| 12. 多渠道触达与客户端 | 16 |
| 13. 交付物形态 | 8 |
| 14. 治理、用量与企业能力 | 9 |
| 15. 客户端界面 | 12 |
| **合计** | **15 域 / 173 条** |

**结论：15 个能力域，远超"≥8"的门槛。** 每个域都至少挂到一条 S1–S11 的官方 URL。

### 16.2 无法归域的能力

**无。** 逐条检查 S1–S11 的内容后，没有出现任何无法归入上述 15 个域的功能条目。

### 16.3 跨源矛盾与张力（如实记录）

1. **"自己的计算机" vs "共享的计算机"** —— S2/S1 的宣传语是 "Bots have their own computer" / "a computer of their own"，但 S1 正文同时说 "Bots **share** a computer of their own in the cloud"，S3 v0.62.0 说 "Deleted Bots free their screens on the **shared** computer"。**判定：不是矛盾，是粒度问题** —— 一台共享的云计算机，每个 Bot 一块独立屏幕。营销语取"专属感"，机制描述取"共享 + 分屏"。
2. **Marketplace vs Connect Apps** —— S5 的页面与站点导航仍叫 Marketplace，S3 v0.67.0 宣布改名为 Connect Apps。**判定：时间差**（页面标题未同步更新），不是功能分歧。
3. **品牌名 SpaceXSI vs SpaceXAI** —— 页面正文与域名用 SpaceXSI，页脚版权行写 "© 2026 SpaceXAI LLC"。**判定：过渡期命名不一致**，与功能无关。
4. **`/` 菜单的两次相反改动** —— v0.62.0 新增"输入 `-` 或 `1.` 起列表"，v0.68.1 移除"输入 `/` 弹出技能与动作菜单"。**判定：不是矛盾**，是同一区域先后两次不同的改动。

### 16.4 版本时间线（S3）

| 版本 | 日期 | 主题 |
|---|---|---|
| v0.56.0 | 2026-09-17 | GitHub、电子表格、更清晰的审批 |
| v0.57.0 | 2026-09-18 | Projects、更丰富的链接预览 |
| v0.58.0 | 2026-09-22 | 新语言、侧边栏、无障碍 |
| v0.59.0 | 2026-09-25 | Team Secrets、居中布局 |
| v0.60.0 | 2026-09-26 | Outlook 草稿、更可靠的回复 |
| **v0.61.0** | 2026-09-26 | **Team Bots** |
| v0.62.0 | 2026-09-28 | 引用、列表、拼写检查 |
| v0.63.0 | 2026-09-29 | Slack 审批、更快的浏览 |
| v0.64.0 | 2026-09-30 | Team Bot managers、头像刷新 |
| v0.65.0 | 2026-09-30 | Team Bot 语音聊天、自动更新 |
| v0.66.0 | 2026-10-02 | 主动性、primary Bot |
| v0.67.0 | 2026-10-02 | Connect Apps、新的工作状态 |
| v0.68.0 | 2026-10-05 | 新语言、计算机移除 |
| v0.68.1 | 2026-10-07 | 幻灯片、Bot 配色聊天 |

> 发布公告在 **2026-08-11**，但 changelog 从 **v0.56.0（2026-09-17）** 才开始有记录 —— 中间约 5 周（v0.0–v0.55）的迭代没有公开 changelog。这是本清单的一个已知盲区。

---

## 17. 对 dsh-bot 最要紧的三条

（这一节是给下一步的输入，不是 Grok Bot 的事实。）

1. **Grok Bot 的价值重心不在"单个 agent 多强"，而在"团队 + 共享计算机 + 例程"三件套。** 173 条里，团队分发（22）、多 Bot 协作（10）、例程（12）、云计算机（12）合计 56 条，占三分之一。dsh-bot 若只做一个更强的单 agent，方向就偏了。
2. **"共享计算机 + 每 Bot 一块屏幕"是可复刻的抽象；"云端多租户持久远程桌面"不是。** 前者是调度与资源分配问题，后者需要 DSH 之外的基础设施。这一条留给 DSH 边界那一路去判。
3. **审批、凭据、模板三者的耦合是它的护城河。** Secure Forms + Team Secrets + 模板排除 secrets + Always allow 的粒度（该 Bot / 所有 Team Bot），四条串起来才让"把 Bot 发给同事"这件事安全。dsh-bot 若只做其中一条，团队分发就立不住。
