/**
 * Bot 名册：分层混合（票 #2 决策）——
 * - 持久身份（名字/颜色/人格）存自有 KV 状态（IdentityStore）；
 * - 装配面（register/list/mount/select）透传到原生 ctx.agentPresets。
 * 原生 roster 扁平且不可变（无重命名、无删除、名字不复用），所以身份字段不能
 * 只依赖原生侧；这里自有状态是事实源，agentPresets 只承载 preset 装配。
 * agentPresets 缺失时降级为纯自有名册并 warn。
 *
 * persona 与 preset 的关系：persona 同时走两条路——
 * ① KV（identity.persona，由 persona.ts 渲染进 `dsh-bot:persona` 提示词段，
 *    作用域是「当前选中的 Bot」，跟会话走）；
 * ② preset 的 plugins 里挂 `@deepseek-ai/dsh-persona` 行（config.prefix = persona），
 *    作用域是「挂载了这个 preset 的会话」，跟 preset 走。
 * 两条路互补而非重复：① 不需要 preset 装配就能生效，② 才是 preset 语义里的人设。
 * dsh-persona 需要 agent scope（在 scope 外挂载会与 deployment:persona-prefix 相撞
 * 并明确报错），而 preset.register 的 mount 正是在 agent scope 内建的（见 DSH
 * packages/preset/agent-preset-registry/src/index.ts:103 activate → createScope）。
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

  const registerPreset = async (identity: BotIdentity): Promise<void> => {
    if (presets === undefined) return
    const disposer = await presets.register({
      id: `${PRESET_ID_PREFIX}${identity.id}`,
      name: identity.name,
      description: identity.description,
      plugins: identity.persona !== undefined && identity.persona.trim() !== ''
        ? [{ name: '@deepseek-ai/dsh-persona', config: { prefix: identity.persona.trim() } }]
        : [],
    })
    disposers.set(identity.id, disposer)
  }

  // 启动重建：preset 注册是进程内的（注册表持有 Definition map），重启即全丢，
  // 而 KV 里的 Bot 还在。若不在这里按 KV 重建，agent/created 绑 preset 会拿到
  // `Unknown agent preset: dsh-bot:<id>`（实测 #12，pid 12652 那次重启）。
  // 单个 Bot 注册失败只 warn 并继续，不让一个坏身份堵死整份名册。
  for (const identity of store.listSync()) {
    try {
      await registerPreset(identity)
    } catch (error) {
      warn(`启动重建 preset 失败（${identity.id}）：${String(error)}`)
    }
  }

  return {
    presetsAvailable: presets !== undefined,

    async create(identity) {
      await store.put(identity)
      await registerPreset(identity)
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
