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
  /** 人格提示词正文：注入该 Bot 的 systemPrompt（可缺省，缺省则只用 description） */
  persona?: string
  /** 创建时间（可缺省，写入时由 roster.create 填） */
  createdAt?: string
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

/** dsh-llm 的 LlmService 精确切片（lib/types/index.d.ts:272,350） */
export interface LlmProviderInfo {
  readonly name: string
}

export interface LlmModelInfo {
  readonly id: string
}

export interface LlmService {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
}

/** dsh-api-session-controller 的 ModelSelection（types.d.ts:91-95） */
export interface ModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** selectModel 请求/返回切片（index.d.ts:105 + types.d.ts:84-89） */
export interface SessionControllerService {
  selectModel(request: ModelSelection & { sessionId: string }): Promise<{ selected: ModelSelection }>
}

/** dsh-tools 的 ToolDefinition / register 切片（lib/types/index.d.ts:115）。 */
export interface ToolOutputDefinition {
  /** 成功返回值的 JSON Schema（宿主逐笔校验）；`{}` 为最宽松形状。 */
  readonly schema: unknown
  /** 纯投影：把 (args, value) 渲染为模型可见 ContentBlock[]。 */
  render(args: unknown, value: unknown): unknown[]
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
  /** 宿主强制字段：缺失时 register 直接拒绝（实测 #1 根因，2026-10-14）。 */
  readonly output?: ToolOutputDefinition
  execute(args: unknown, exec?: unknown): Promise<unknown>
}

export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** dsh-credentials 的 CredentialProvider 切片（lib/types/index.d.ts:129-174） */
export interface ResolvedCredential {
  readonly value: string
  readonly source: string
}

export interface CredentialInfo {
  readonly configured: boolean
  readonly source?: string
}

export interface CredentialsService {
  resolve(ref: string): Promise<ResolvedCredential | undefined>
  describe(ref: string): Promise<CredentialInfo>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  listRecords(): Promise<readonly unknown[]>
}

/** dsh-user-approval 的 ApprovalOutcome（types.d.ts，fail-closed 唯一授权值 allowed-once） */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** dsh-user-approval 的 ApprovalService 切片（index.d.ts:116,135） */
export interface ApprovalService {
  request(req: { toolName: string; [key: string]: unknown }): Promise<ApprovalOutcome>
  setPolicy?(agent: unknown, policy: 'ask' | 'never'): void
}

/** dsh-permission-presets 的 PermissionPresetService 切片（index.d.ts:138,162,186） */
export interface PermissionPresetsService {
  catalog(): Promise<readonly { name: string }[]>
  current(session: unknown): Promise<{ name: string }>
  set(session: unknown, name: string): Promise<string>
}

/** dsh-schedule 六形态输入切片（lib/types/types.d.ts ScheduleCreateRequest） */
export interface ScheduleCreateRequest {
  readonly title: string
  readonly prompt: string
  readonly after_seconds?: number
  readonly at?: string | { date: string; time: string; time_zone: string }
  readonly every_seconds?: number
  readonly daily?: { time: string; time_zone: string }
  readonly weekly?: { time: string; time_zone: string; weekdays: number[] }
  readonly cron?: { expression: string; time_zone: string }
}

export interface ScheduleRecord {
  readonly id: string
  readonly kind: string
  readonly title: string
  readonly prompt: string
}

/** dsh-schedule 的 ScheduleService 切片（lib/types/index.d.ts:69,104 起） */
export interface ScheduleService {
  create(sessionId: string, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord>
  list(request: { sessionId: string }): Promise<readonly ScheduleRecord[]>
  delete(request: { sessionId: string; id: string }): Promise<boolean>
}

/** host 插件上下文切片：apply(ctx) 收到的东西 */
export interface HostContext {
  readonly logger?: { warn(message: string): unknown; info?(message: string): unknown }
  readonly storage?: StorageHub
  readonly agentPresets?: AgentPresetsService
  readonly systemPrompt?: SystemPromptService
  readonly llm?: LlmService
  readonly sessionController?: SessionControllerService
  readonly tools?: ToolsService
  readonly credentials?: CredentialsService
  readonly approval?: ApprovalService
  readonly permissionPresets?: PermissionPresetsService
  readonly schedule?: ScheduleService
  /**
   * 订阅宿主事件，如 'agent/created'。事件瀑布（如 'approval/request'）的 handler 收
   * (payload, next)：返回 next() 让事件继续下传，返回其他值即认领该事件。
   */
  on(event: string, handler: (payload: unknown, next: () => unknown) => unknown, options?: unknown): unknown
  /** cordis 运行期可选依赖：服务到齐后执行，掉了重跑（registry.d.ts:111） */
  inject(names: readonly string[], callback: (services: Record<string, unknown>) => void): unknown
}

/** 与 dsh-llm UserMessage 对齐的最小注入结构：四个字段缺一，会话日志读取端会拒收整条会话 */
export interface InjectedUserMessage {
  id: string
  role: 'user'
  content: ReadonlyArray<{ type: 'text'; text: string }>
  source: { kind: string }
}

/** dsh-mmaping 验证过的会话启动注入形态（research/dsh-plugin-skeleton.md §2.4） */
export interface CreatedAgent {
  session?: { header?: { cwd?: string } }
  inject?(message: InjectedUserMessage): unknown
}

export interface AgentEventPayload {
  agent?: CreatedAgent
}
