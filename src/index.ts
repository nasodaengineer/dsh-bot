/**
 * dsh-bot host 入口（票 #5 P0 · 票 #6 P1）。
 *
 * 静态 inject 仍只放 P0 真正用到的三个服务（路线图 §6 纪律：不一次性 inject 一把）：
 * - agentPresets：Bot 名册的原生装配面（register/list/mount/select）
 * - systemPrompt：人格段注入
 * - storage：Bot 持久身份的 KV 存储
 *
 * P1 五个新服务（llm/sessionController/tools/credentials/approval/schedule）全部走
 * 运行期 ctx.inject([...], attach)：它们要么是条件挂载（schedule 只在 Automation
 * tasks bundle 打开时存在），要么插件可无此服务降级运行；运行期订阅不阻塞 fiber，
 * 服务掉了会重挂（boundaries §1.2/§1.4，ds-bot 同款先例）。
 *
 * 分层混合决策（票 #2/#3）：spawn/消息/任务板归 ctx.agentTeams（P2 做）；
 * Bot 持久身份走自有 KV 状态。本票不做任何 client 侧注入（P2 的事）。
 */
import type { AgentEventPayload, BotIdentity, HostContext, LlmService, SessionControllerService, ToolsService, CredentialsService, ApprovalService, ScheduleService } from './types.js'
import { createIdentityStore, type IdentityStore } from './identity.js'
import { createRoster, type BotRoster } from './roster.js'
import { personaSection } from './persona.js'
import { attachModelRuntime, type ModelRuntime } from './model.js'
import { attachBotTools, createMcpBridge, type BotToolsRuntime, type McpBridge, type McpServerConfig } from './bot-tools.js'
import { attachBotCredentials, type BotCredentialsRuntime } from './bot-credentials.js'
import { attachBotApproval, type BotApprovalRuntime } from './bot-approval.js'
import { attachBotSchedules, type BotSchedulesRuntime } from './schedules.js'
import { createAgentTeamsFacade, type AgentTeamsFacade, type AgentTeamsService } from './agent-teams.js'
import { createTaskBoard, type TaskBoard } from './taskboard.js'
import { createJevJudge, resolveJevBackend, type AutoDecideService, type JevJudge } from './jev.js'
import { createGroupChatRuntime, createRootSessionCarrier, type GroupChatRuntime } from './groupchat.js'
import { createMemoryRepo, type MemoryRepo } from './memory.js'
import { createTemplateStore, type TemplateStore } from './template.js'
import { attachHttpEndpoint, type HttpEndpointRuntime } from './endpoint.js'
import { trace } from './diag.js'

export const name = 'dsh-bot'

export const inject = ['agentPresets', 'systemPrompt', 'storage']

/** Jev 决策模型配置：judge 直接注入（测试/自建），或给 apiKey 走 TypeSafe HTTP API。
 * 票 #14：decision 选决策后端——'autoDecide'（默认，运行期 ctx.inject 消费 'autoDecide'
 * 服务，不在/失败/超时自动降级 builtin）| 'builtin'（TypeSafe 直连，凭据面归此） */
export interface TypesafeOptions {
  readonly apiKey?: string
  readonly endpoint?: string
  readonly judge?: JevJudge
  readonly decision?: 'autoDecide' | 'builtin'
  /** 票 #16：审批三档 manual|limited|full（默认 manual；沿用本读取面，键名 approval） */
  readonly approval?: 'manual' | 'limited' | 'full'
}

export interface DshBotRuntime {
  readonly roster: BotRoster
  /** 选中 Bot：KV 持久化（票 #6 接 P0 接缝 1） */
  readonly selection: {
    selectBot(id: string | undefined): Promise<void>
    selectedBotId(): string | undefined
    selectedBot(): Promise<BotIdentity | undefined>
  }
  /** 以下运行时由 ctx.inject 到齐后出现；服务缺失时保持 undefined */
  readonly models?: ModelRuntime
  readonly botTools?: BotToolsRuntime
  readonly credentials?: BotCredentialsRuntime
  readonly approval?: BotApprovalRuntime
  readonly schedules?: BotSchedulesRuntime
  /** P2：原生 TeamService 门面（caller 透传）+ 任务板 + 群聊 */
  readonly teams?: AgentTeamsFacade
  readonly tasks?: TaskBoard
  readonly groups?: GroupChatRuntime
  /** P3：Bot 记忆仓库（票 #10，异步就绪） */
  readonly memory?: MemoryRepo
  /** P3：Bot 模板仓库（票 #11，异步就绪） */
  readonly templates?: TemplateStore
  /** P3：HTTP 端点（票 #12，connection 服务存在时挂载） */
  readonly endpoint?: HttpEndpointRuntime
  readonly mcp: McpBridge
}

export interface ApplyOptions {
  mcpServers?: readonly McpServerConfig[]
  rootSessionId?: string
  typesafe?: TypesafeOptions
}

export function apply(ctx: HostContext, options: ApplyOptions = {}): DshBotRuntime {
  const runtime: {
    roster?: BotRoster
    selectedId?: string
    models?: ModelRuntime
    botTools?: BotToolsRuntime
    credentials?: BotCredentialsRuntime
    approval?: BotApprovalRuntime
    schedules?: BotSchedulesRuntime
    teams?: AgentTeamsFacade
    tasks?: TaskBoard
    groups?: GroupChatRuntime
    memory?: MemoryRepo
    templates?: TemplateStore
    endpoint?: HttpEndpointRuntime
  } = {}
  let storeRef: IdentityStore | undefined

  const mcp = createMcpBridge(options.mcpServers ?? [])

  // agent/created 注入（票 #6 接 P0 接缝 2）：会话启动时把人格文本注入 Agent。
  function handleAgentCreated(payload: AgentEventPayload): void {
    const agent = payload.agent
    if (agent?.inject === undefined) return
    const selected = runtime.selectedId
    // A1：IIFE 内部任何拒绝都要就地捕获，不能逃逸外层 try/catch（同步捕获管不到异步）
    void (async () => {
      const roster = runtime.roster
      if (roster === undefined) return
      const bots = await roster.list()
      const bot = selected !== undefined ? bots.find((b) => b.id === selected) : undefined
      if (bot === undefined) return
      agent.inject?.(`[dsh-bot] 当前 Bot：${bot.name}（${bot.title}）\n${bot.description}`)
    })().catch((error) => {
      ctx.logger?.warn(`dsh-bot: agent/created 异步注入失败：${String(error)}`)
    })
  }

  // 异步装配：cordis 的 apply 可以返回 Promise；注册动作都在 Promise 内完成。
  void (async () => {
    trace('apply: async 装配开始')
    const store = await createIdentityStore(ctx)
    const roster = await createRoster(ctx, store)
    runtime.roster = roster
    trace('apply: identity+roster 完成')
    storeRef = store
    runtime.selectedId = await store.getSelectedId()
    // 票 #10：记忆仓库与身份共用 KV unit 'dsh-bot'（自有表），失败内部降级
    runtime.memory = await createMemoryRepo(ctx)
    // 票 #11：模板仓库（依赖 roster/memory/schedules 的 getter，见下）
    runtime.templates = await createTemplateStore(ctx, {
      roster,
      getMemory: () => runtime.memory,
      getSchedules: () => runtime.schedules,
      getMcpServerNames: () => mcp.configured.map((c) => c.name),
    })

    // 票 #12：HTTP 端点（connection 服务缺失时内部降级不注册）
    runtime.endpoint = attachHttpEndpoint(ctx, {
      getGroups: () => runtime.groups,
      getTasks: () => runtime.tasks,
      getRoster: () => runtime.roster,
    })

    if (ctx.systemPrompt !== undefined) {
      ctx.systemPrompt.section(personaSection(store, { selectedId: () => runtime.selectedId }, {
        warn: (message) => ctx.logger?.warn(message),
      }))
    } else {
      ctx.logger?.warn('dsh-bot: ctx.systemPrompt 服务缺失，人格段不注入')
    }

    // P1 功能面：运行期可选依赖，到齐即挂，掉了重挂。
    attachRuntimes(ctx, runtime, store, options)
    trace('apply: attachRuntimes 完成（inject 订阅已注册）')
  })().catch((error) => {
    trace(`apply: 初始化失败 ${String(error)}`)
    ctx.logger?.warn(`dsh-bot: 初始化失败：${String(error)}`)
  })

  onAgentCreated(ctx, handleAgentCreated)

  return {
    get roster() { return runtime.roster! },
    get models() { return runtime.models },
    get botTools() { return runtime.botTools },
    get credentials() { return runtime.credentials },
    get approval() { return runtime.approval },
    get schedules() { return runtime.schedules },
    get teams() { return runtime.teams },
    get tasks() { return runtime.tasks },
    get groups() { return runtime.groups },
    get memory() { return runtime.memory },
    get templates() { return runtime.templates },
    get endpoint() { return runtime.endpoint },
    mcp,
    selection: {
      async selectBot(id) {
        runtime.selectedId = id
        await storeRef?.putSelectedId(id)
      },
      selectedBotId() {
        return runtime.selectedId
      },
      async selectedBot() {
        const roster = runtime.roster
        const id = runtime.selectedId
        if (roster === undefined || id === undefined) return undefined
        return roster.list().then((bots) => bots.find((b) => b.id === id))
      },
    },
  } as DshBotRuntime
}

/** P1/P2 运行时装配：ctx.inject 订阅（见文件头注释的取舍理由） */
function attachRuntimes(
  ctx: HostContext,
  runtime: Record<string, unknown>,
  store: IdentityStore,
  options: ApplyOptions,
): void {
  ctx.inject(['llm', 'sessionController'], (services) => {
    runtime.models = attachModelRuntime(ctx, {
      llm: services.llm as LlmService,
      sessionController: services.sessionController as SessionControllerService,
      store,
    })
  })

  const getSchedules = () => runtime.schedules as BotSchedulesRuntime | undefined
  ctx.inject(['tools'], (services) => {
    const roster = runtime.roster as BotRoster | undefined
    trace(`inject(tools): 触发 roster=${roster !== undefined ? 'ok' : 'undefined'} toolsSvc=${services.tools !== undefined ? 'ok' : 'undefined'}`)
    if (roster === undefined) return
    runtime.botTools = attachBotTools(ctx, services.tools as ToolsService, {
      roster,
      getSchedules,
      getMemory: () => runtime.memory as MemoryRepo | undefined,
      getSelectedBotId: () => runtime.selectedId as string | undefined,
      getTemplates: () => runtime.templates as TemplateStore | undefined,
    })
  })

  ctx.inject(['credentials'], (services) => {
    runtime.credentials = attachBotCredentials(ctx, services.credentials as CredentialsService)
  })

  ctx.inject(['approval'], (services) => {
    runtime.approval = attachBotApproval(ctx, {
      approval: services.approval as ApprovalService,
      permissionPresets: ctx.permissionPresets,
    })
  })

  // 实测#4：schedule 服务默认不在 web profile（用户级 cordis.patch.yml 已挂
  // @deepseek-ai/dsh-schedule）。优先主树 inject 到齐捕获引用（工具执行在 worker
  // 门面 ctx 上，其 schedule getter 恒 undefined，不能依赖执行期弱读）；
  // 同时保留惰性弱读兜底（api-remotes 增强场景）。
  // sessionId 不再来自装配方（rootSessionId 通常无人传）：bot_schedule_* 执行期
  // 从 exec.agent.session.id 取（宿主 dsh-tool-schedule 同款），preferredSessionId
  // 仅作为显式配置时的优先值。
  {
    const scheduleRef: { service?: ScheduleService } = {}
    try {
      ctx.inject(['schedule'], (services) => {
        scheduleRef.service = services.schedule as ScheduleService
      })
    } catch (error) {
      ctx.logger?.warn(`dsh-bot: 订阅 schedule 服务失败（例程将走惰性弱读）：${String(error)}`)
    }
    runtime.schedules = attachBotSchedules(ctx, {
      schedule: () => scheduleRef.service ?? (ctx as unknown as { schedule?: ScheduleService }).schedule,
      preferredSessionId: options.rootSessionId,
    })
  }

  // 票 #14：决策双后端。autoDecide 服务是运行期可选依赖（dsh-auto-decide 提供），
  // 到齐即挂、掉了重挂；judge 在每次判定时弱读，缺失自动降级 builtin。
  const autoDecideRef: { service?: AutoDecideService } = {}
  ctx.inject(['autoDecide'], (services) => {
    autoDecideRef.service = services.autoDecide as AutoDecideService
  })

  // P2：ctx.agentTeams（dsh-experimental-agent-team）。门面只做 caller 透传；
  // 本函数由异步装配在 store 就绪后调用（attachRuntimes 的 store 参数）。
  ctx.inject(['agentTeams'], (services) => {
    const teams = createAgentTeamsFacade(services.agentTeams as AgentTeamsService)
    runtime.teams = teams
    runtime.tasks = createTaskBoard(teams)
    const builtinJudge: JevJudge | undefined = options.typesafe?.judge ??
      (options.typesafe?.apiKey !== undefined
        ? createJevJudge({ apiKey: options.typesafe.apiKey, endpoint: options.typesafe.endpoint })
        : undefined)
    const judge: JevJudge | undefined = options.typesafe?.judge ?? resolveJevBackend({
      decision: options.typesafe?.decision,
      getAutoDecide: () => autoDecideRef.service,
      builtin: builtinJudge,
      warn: (message) => ctx.logger?.warn(message),
    })
    if (judge === undefined) {
      ctx.logger?.warn('dsh-bot: 未配置 typesafe.apiKey/judge 且无 autoDecide 服务，群聊路由走降级（本轮无人响应提示）')
    }
    // A2：群聊载体——宿主侧真实创建/复用隐藏 root Session（schedules.ts 同款强制 root 手法）
    runtime.groups = createGroupChatRuntime(ctx, {
      store,
      judge,
      ensureSession: createRootSessionCarrier({ rootSessionId: options.rootSessionId }),
      // 票 #16：审批三档 + autoDecide 弱读（limited/full 档自动判定，不可用回退 manual 语义）
      approvalTier: options.typesafe?.approval,
      getAutoDecide: () => autoDecideRef.service,
    })
  })
}

/** agent/created 注入的容错封装（路线图 §6 纪律 5） */
export function onAgentCreated(ctx: HostContext, handler: (payload: AgentEventPayload) => void): void {
  ctx.on('agent/created', (payload) => {
    try {
      handler(payload as AgentEventPayload)
    } catch (error) {
      ctx.logger?.warn(`dsh-bot: agent/created 注入失败：${String(error)}`)
    }
  })
}
