/**
 * dsh-bot host 入口（票 #5 · P0）。
 *
 * inject 只放本票真正用到的三个服务（路线图 §6 纪律：不一次性 inject 一把）：
 * - agentPresets：Bot 名册的原生装配面（register/list/mount/select）
 * - systemPrompt：人格段注入
 * - storage：Bot 持久身份的 KV 存储
 *
 * 分层混合决策（票 #2/#3）：spawn/消息/任务板归 ctx.agentTeams（P2 做）；
 * Bot 持久身份走自有 KV 状态。本票不做任何 client 侧注入（P2 的事）。
 */
import type { AgentEventPayload, HostContext } from './types.js'
import { createIdentityStore } from './identity.js'
import { createRoster, type BotRoster } from './roster.js'
import { personaSection } from './persona.js'

export const name = 'dsh-bot'

export const inject = ['agentPresets', 'systemPrompt', 'storage']

export interface DshBotRuntime {
  readonly roster: BotRoster
}

export function apply(ctx: HostContext): DshBotRuntime {
  const runtime: { roster?: BotRoster } = {}

  // 异步装配：cordis 的 apply 可以返回 Promise；注册动作都在 Promise 内完成。
  void (async () => {
    const store = await createIdentityStore(ctx)
    const roster = await createRoster(ctx, store)
    runtime.roster = roster

    // 会话内「当前选中 Bot」——P0 用进程内选择器，P1 再持久化到 KV
    let selectedId: string | undefined
    if (ctx.systemPrompt !== undefined) {
      ctx.systemPrompt.section(personaSection(store, { selectedId: () => selectedId }))
    } else {
      ctx.logger?.warn('dsh-bot: ctx.systemPrompt 服务缺失，人格段不注入')
    }
  })().catch((error) => {
    ctx.logger?.warn(`dsh-bot: 初始化失败：${String(error)}`)
  })

  return { get roster() { return runtime.roster! } } as DshBotRuntime
}

/** agent/created 注入的容错封装（路线图 §6 纪律 5）：P0 只留钩子位，P1 接会话启动人格。 */
export function onAgentCreated(ctx: HostContext, handler: (payload: AgentEventPayload) => void): void {
  ctx.on('agent/created', (payload) => {
    try {
      handler(payload as AgentEventPayload)
    } catch (error) {
      ctx.logger?.warn(`dsh-bot: agent/created 注入失败：${String(error)}`)
    }
  })
}
