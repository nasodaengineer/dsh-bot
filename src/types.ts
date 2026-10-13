/**
 * 本地类型切片：不 import 任何 @deepseek-ai/* 包。
 * 每个 interface 都是 DSH 包文档化的精确切片（来源：dsh-storage / dsh-agent-preset-registry /
 * dsh-system-prompt 的 lib/types/*.d.ts，调研记录见 research/dsh-plugin-boundaries.md）。
 * 保持本地类型可规避 pre-stable API 的 peer 版本耦合。
 */

/** dsh-storage 的 KV unit 切片（lib/types/backend.d.ts） */
export interface KvUnit {
  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }>
  putRecord(table: string, key: string, value: unknown): Promise<void>
  deleteRecord(table: string, key: string): Promise<void>
  close(): Promise<void>
}

/** dsh-storage 的 backend 注册表切片（lib/types/registry.d.ts） */
export interface StorageBackendRegistry {
  get(name: string): unknown
  names(): string[]
}

/** ctx.storage 切片（lib/types/index.d.ts） */
export interface StorageHub {
  readonly backend: StorageBackendRegistry
}

/** Bot 的持久身份字段（原生 roster 是扁平不可变的，身份字段必须自有状态管理） */
export interface BotIdentity {
  /** 稳定 id，同时是 preset id 的后缀 */
  readonly id: string
  /** 显示名 */
  name: string
  /** 角色标签 */
  title: string
  /** 人格描述 */
  description: string
  /** 侧栏颜色（可缺省） */
  color?: string
}

/** dsh-agent-preset-registry 的 PresetDefinition 切片（lib/types/definition.d.ts，plugins 必填） */
export interface PresetDefinition {
  readonly id: string
  readonly name?: string
  readonly description?: string
  readonly order?: number
  readonly plugins: readonly unknown[]
}

/** ctx.agentPresets 切片（lib/types/index.d.ts） */
export interface AgentPresetsService {
  register(definition: PresetDefinition): Promise<() => Promise<void>>
  list(): Promise<ReadonlyArray<{ id: string; name?: string; description?: string; broken?: string }>>
  mount(ctx: unknown, id?: string): Promise<{ id: string }>
  select(agent: unknown, id: string): Promise<string>
}

/** dsh-system-prompt 的 PromptSection 切片（lib/types/index.d.ts） */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
}

/** ctx.systemPrompt 切片 */
export interface SystemPromptService {
  section(section: PromptSection): () => void
}

/** host 插件上下文切片：apply(ctx) 收到的东西 */
export interface HostContext {
  readonly logger?: { warn(message: string): unknown; info?(message: string): unknown }
  readonly storage?: StorageHub
  readonly agentPresets?: AgentPresetsService
  readonly systemPrompt?: SystemPromptService
  /** 订阅宿主事件，如 'agent/created' */
  on(event: string, handler: (payload: unknown) => unknown, options?: unknown): unknown
}

/** dsh-mmaping 验证过的会话启动注入形态（research/dsh-plugin-skeleton.md §2.4） */
export interface CreatedAgent {
  session?: { header?: { cwd?: string } }
  inject?(message: unknown): unknown
}

export interface AgentEventPayload {
  agent?: CreatedAgent
}
