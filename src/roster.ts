/**
 * Bot 名册：分层混合（票 #2 决策）——
 * - 持久身份（名字/颜色/人格）存自有 KV 状态（IdentityStore）；
 * - 装配面（register/list/mount/select）透传到原生 ctx.agentPresets。
 * 原生 roster 扁平且不可变（无重命名、无删除、名字不复用），所以身份字段不能
 * 只依赖原生侧；这里自有状态是事实源，agentPresets 只承载 preset 装配。
 * agentPresets 缺失时降级为纯自有名册并 warn。
 */
import type { AgentPresetsService, BotIdentity, HostContext } from './types.js'
import type { IdentityStore } from './identity.js'

export const PRESET_ID_PREFIX = 'dsh-bot:'

export interface BotRoster {
  create(identity: BotIdentity): Promise<void>
  list(): Promise<BotIdentity[]>
  remove(id: string): Promise<void>
  /** 透传 agentPresets.mount：把 Agent 绑定到该 Bot 的 preset */
  mount(ctx: unknown, id?: string): Promise<{ id: string }>
  /** 透传 agentPresets.select：会话首个 turn 前选定 preset */
  select(agent: unknown, id: string): Promise<string>
  readonly presetsAvailable: boolean
}

export async function createRoster(ctx: HostContext, store: IdentityStore): Promise<BotRoster> {
  const presets: AgentPresetsService | undefined = ctx.agentPresets
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  if (presets === undefined) {
    warn('ctx.agentPresets 服务缺失，名册降级为纯自有状态（无原生 preset 装配）')
  }

  // 已注册 preset 的 disposer，remove 时注销
  const disposers = new Map<string, () => Promise<void>>()

  return {
    presetsAvailable: presets !== undefined,

    async create(identity) {
      await store.put(identity)
      if (presets !== undefined) {
        const disposer = await presets.register({
          id: `${PRESET_ID_PREFIX}${identity.id}`,
          name: identity.name,
          description: identity.description,
          plugins: [],
        })
        disposers.set(identity.id, disposer)
      }
    },

    async list() {
      return store.list()
    },

    async remove(id) {
      const disposer = disposers.get(id)
      if (disposer !== undefined) {
        await disposer()
        disposers.delete(id)
      }
      await store.remove(id)
    },

    async mount(agentCtx, id) {
      if (presets === undefined) return { id: id ?? '' }
      return presets.mount(agentCtx, id === undefined ? undefined : `${PRESET_ID_PREFIX}${id}`)
    },

    async select(agent, id) {
      if (presets === undefined) return id
      return presets.select(agent, `${PRESET_ID_PREFIX}${id}`)
    },
  }
}
