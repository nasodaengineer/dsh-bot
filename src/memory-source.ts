/**
 * 票 #15 · dsh-bot 记忆的 MemorySource 贡献形态。
 *
 * 契约参考 dsh-mnemon src/core/contracts/view.ts:118-446 的本地窄切片：
 * - 只保留本 Source 用到的字段，全部本地声明，不 import @deepseek-ai/* 或 mnemon 内部模块；
 * - 形态备好即可（本仓库不实际调用 installMemory，不提交 mnemon 侧、不上报外部——用户硬边界）；
 * - 全部跨界值都是 JSON-safe（facts/project/query/mutate 的返回不含任何 handle）。
 *
 * 摘要产物（含 compact 压缩出的「摘要」条目）随索引一并 project 贡献；原文不外发，
 * 贡献面即 ctx.storage KV 里的 dsh-bot 记忆仓库（票 #3 裁决：事实源仍是 KV）。
 */
import type { MemoryRepo, MemoryEntry } from './memory.js'

/** COMPOSABLE_MEMORY_API_VERSION（view.ts:16） */
export const COMPOSABLE_MEMORY_API_VERSION = 'dsh-mnemon/v1' as const

/** MemoryJsonValue 窄切片（contracts/index.ts） */
export type MemoryJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly MemoryJsonValue[]
  | { readonly [key: string]: MemoryJsonValue }

export type MemoryCapability =
  | 'status' | 'project' | 'recall' | 'search' | 'read'
  | 'browse' | 'write' | 'archive' | 'graph' | 'related'

export type MemorySourceAvailability = 'ready' | 'degraded' | 'unavailable'
export type MemoryViewConsistencyMode = 'exact-snapshot' | 'namespace-pinned-live-read'
export type MemoryReceiptStatus = 'succeeded' | 'partial' | 'failed' | 'cancelled'
export type MemoryMutationCompletion = 'accepted' | 'candidate' | 'committed' | 'partial' | 'failed' | 'unknown'

export interface MemoryOperationScope {
  readonly storage: 'global' | 'workspace' | 'custom' | 'workspaces'
  readonly workspaceId?: string
  readonly sessionId?: string
  readonly agentId?: string
}

export interface MemoryPackageProvenance {
  readonly packageName: string
  readonly entryId: string
  readonly artifactDigest?: string
}

/** view.ts:118 MemorySourceManifest 窄切片（routes/actions 只保留用到的字段） */
export interface MemorySourceRouteManifest {
  readonly id: string
  readonly description: string
  readonly capability: MemoryCapability
  readonly inputSchema: MemoryJsonValue
}

export interface MemorySourceActionManifest {
  readonly id: string
  readonly description: string
  readonly capability: MemoryCapability
  readonly inputSchema: MemoryJsonValue
}

export interface MemorySourceManifest {
  readonly apiVersion: typeof COMPOSABLE_MEMORY_API_VERSION
  readonly kind: 'source'
  readonly typeId: string
  readonly packageName: string
  readonly role: string
  readonly capabilities: readonly MemoryCapability[]
  readonly consistency: MemoryViewConsistencyMode
  readonly routes?: readonly MemorySourceRouteManifest[]
  readonly actions?: readonly MemorySourceActionManifest[]
}

/** view.ts:191/226/261 请求切片 */
export interface MemoryViewRequest {
  readonly scope: MemoryOperationScope
  readonly scenario: string
  readonly budget: unknown
}

export interface MemoryProjectionRequest {
  readonly scope: MemoryOperationScope
  readonly sourceInstanceKey: string
  readonly expectedRevision: string
  readonly includeProjection: boolean
  readonly mode: 'eager' | 'routed'
  readonly maxCharacters: number
}

export interface MemoryViewFragment {
  readonly id: string
  readonly sourceInstanceKey: string
  readonly mode: 'eager' | 'routed'
  readonly text: string
  readonly revision: string
  readonly provenance?: MemoryJsonValue
}

export interface MemoryViewContribution {
  readonly fragments: readonly MemoryViewFragment[]
  readonly readGrant?: unknown
  readonly presentation?: unknown
}

export interface MemoryViewRoute {
  readonly id: string
  readonly sourceInstanceKey: string
  readonly sourceRouteId: string
  readonly description: string
  readonly capability: MemoryCapability
  readonly inputSchema: MemoryJsonValue
}

export interface MemoryActionOffer {
  readonly id: string
  readonly sourceInstanceKey: string
  readonly sourceActionId: string
  readonly description: string
  readonly capability: MemoryCapability
  readonly inputSchema: MemoryJsonValue
}

export interface MemoryEvidenceItem {
  readonly id: string
  readonly text: string
  readonly provenance: MemoryJsonValue
  readonly score?: number
  readonly revision?: string
}

export interface MemoryEvidence {
  readonly id: string
  readonly viewId: string
  readonly routeId: string
  readonly sourceInstanceKey: string
  readonly observedAt: string
  readonly items: readonly MemoryEvidenceItem[]
  readonly truncated: boolean
  readonly unavailable?: string
  readonly metadata?: MemoryJsonValue
}

export interface MemoryMutationReceipt {
  readonly viewId: string
  readonly offerId: string
  readonly sourceInstanceKey: string
  readonly status: MemoryReceiptStatus
  readonly completion: MemoryMutationCompletion
  readonly committedAt?: string
  readonly revision?: string
  readonly details?: MemoryJsonValue
}

/** view.ts:204/235/425-458 runtime 切片（manage 本 Source 不提供） */
export interface MemorySourceRuntimeContext {
  readonly sourceInstanceKey: string
  readonly provenance: MemoryPackageProvenance
  readonly configuration?: Readonly<Record<string, MemoryJsonValue>>
}

export interface MemorySourceRuntime {
  facts(request: MemoryViewRequest, signal?: AbortSignal): MemorySourceFacts | Promise<MemorySourceFacts>
  project(request: MemoryProjectionRequest, signal?: AbortSignal): MemoryViewContribution | Promise<MemoryViewContribution>
  query?(request: {
    readonly view: { readonly id: string; readonly scope: MemoryOperationScope }
    readonly route: MemoryViewRoute
    readonly grant: unknown
    readonly input: MemoryJsonValue
    readonly signal?: AbortSignal
  }): MemoryEvidence | Promise<MemoryEvidence>
  mutate?(request: {
    readonly view: { readonly id: string; readonly scope: MemoryOperationScope }
    readonly offer: MemoryActionOffer
    readonly grant?: unknown
    readonly input: MemoryJsonValue
    readonly signal?: AbortSignal
  }): MemoryMutationReceipt | Promise<MemoryMutationReceipt>
  dispose?(): void | Promise<void>
}

export interface MemorySourceFacts {
  readonly sourceInstanceKey: string
  readonly sourceTypeId: string
  readonly role: string
  readonly availability: MemorySourceAvailability
  readonly revision: string
  readonly capabilities: readonly MemoryCapability[]
  readonly routeIds: readonly string[]
  readonly actionIds: readonly string[]
  readonly hints?: MemoryJsonValue
}

export interface MemorySourceDefinition {
  readonly manifest: MemorySourceManifest
  create(context: MemorySourceRuntimeContext): MemorySourceRuntime
}

export interface DshBotMemorySourceOptions {
  /** 实例键（Host 安装时通常自定；测试注入稳定值） */
  readonly instanceKey?: string
  /** facts.project/project 的默认 Bot（缺省时用 scope.agentId，再缺省 'default'） */
  readonly defaultBotId?: string
}

const TYPE_ID = 'dsh-bot/memory'
const REVISION = 'rev-1'

/**
 * 构造 dsh-bot 记忆的 MemorySource 定义：事实源是 MemoryRepo（ctx.storage KV），
 * project 贡献索引（含 compact 摘要条目），query 走关键词检索，mutate 走 write 动作。
 */
export function createDshBotMemorySource(
  repo: Pick<MemoryRepo, 'write' | 'search' | 'list' | 'indexText'>,
  options: DshBotMemorySourceOptions = {},
): MemorySourceDefinition {
  const instanceKey = options.instanceKey ?? 'dsh-bot/memory'
  const manifest: MemorySourceManifest = {
    apiVersion: COMPOSABLE_MEMORY_API_VERSION,
    kind: 'source',
    typeId: TYPE_ID,
    packageName: 'dsh-bot',
    role: 'bot-facts',
    capabilities: ['status', 'project', 'recall', 'search', 'write'],
    consistency: 'namespace-pinned-live-read',
    routes: [
      {
        id: 'search',
        description: '按关键词全命中检索 dsh-bot 记忆（输入 {query: string}）',
        capability: 'search',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ],
    actions: [
      {
        id: 'write',
        description: '写入一条 Bot 记忆（输入 {botId, topic, text}）',
        capability: 'write',
        inputSchema: {
          type: 'object',
          properties: {
            botId: { type: 'string' },
            topic: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['botId', 'topic', 'text'],
        },
      },
    ],
  }

  /**
   * 修复轮·resolveBotId（原 botIdOf 改名，表意「解析」而非「取属」）：
   * 真实优先级是注入配置优先于 scope——options.defaultBotId（装配方显式注入）最优先，
   * 其次 scope.agentId（运行期上下文），最后 'default' 兜底。
   */
  const resolveBotId = (scope: MemoryOperationScope | undefined) =>
    options.defaultBotId ?? (typeof scope?.agentId === 'string' && scope.agentId !== '' ? scope.agentId : 'default')

  return {
    manifest,
    create(context: MemorySourceRuntimeContext): MemorySourceRuntime {
      const key = context.sourceInstanceKey
      return {
        async facts(): Promise<MemorySourceFacts> {
          return {
            sourceInstanceKey: key,
            sourceTypeId: TYPE_ID,
            role: manifest.role,
            availability: 'ready',
            revision: REVISION,
            capabilities: manifest.capabilities,
            routeIds: (manifest.routes ?? []).map((r) => r.id),
            actionIds: (manifest.actions ?? []).map((a) => a.id),
            hints: { factSource: 'ctx.storage KV (unit dsh-bot)', compactSummariesIncluded: true },
          }
        },

        async project(request: MemoryProjectionRequest): Promise<MemoryViewContribution> {
          const botId = resolveBotId(request.scope)
          const index = await repo.indexText(botId)
          if (!request.includeProjection || index === '') {
            return { fragments: [] }
          }
          const truncated = index.length > request.maxCharacters
          const text = truncated ? index.slice(0, request.maxCharacters) : index
          return {
            fragments: [
              {
                id: `${key}:index:${botId}`,
                sourceInstanceKey: key,
                mode: request.mode,
                text,
                revision: request.expectedRevision,
                provenance: { botId, kind: 'memory-index', truncated },
              },
            ],
          }
        },

        async query(request): Promise<MemoryEvidence> {
          const input = (request.input ?? {}) as { query?: unknown }
          const query = typeof input.query === 'string' ? input.query : ''
          if (query.trim() === '') {
            return {
              id: `ev-${Date.now().toString(36)}`,
              viewId: request.view.id,
              routeId: request.route.id,
              sourceInstanceKey: key,
              observedAt: new Date().toISOString(),
              items: [],
              truncated: false,
            }
          }
          const botId = resolveBotId(request.view.scope)
          const hits = await repo.search(botId, query)
          return {
            id: `ev-${Date.now().toString(36)}`,
            viewId: request.view.id,
            routeId: request.route.id,
            sourceInstanceKey: key,
            observedAt: new Date().toISOString(),
            items: hits.map((entry: MemoryEntry) => ({
              id: `${key}:${entry.id}`,
              text: entry.text,
              provenance: { botId, topic: entry.topic, entryId: entry.id, updatedAt: entry.updatedAt },
              revision: REVISION,
            })),
            truncated: false,
          }
        },

        async mutate(request): Promise<MemoryMutationReceipt> {
          const base = { viewId: request.view.id, offerId: request.offer.id, sourceInstanceKey: key }
          const input = (request.input ?? {}) as Record<string, unknown>
          const botId = typeof input.botId === 'string' ? input.botId : ''
          const topic = typeof input.topic === 'string' ? input.topic : ''
          const text = typeof input.text === 'string' ? input.text : ''
          if (botId === '' || topic === '' || text === '') {
            return { ...base, status: 'failed', completion: 'failed', details: { reason: 'botId/topic/text 均为必填字符串' } }
          }
          try {
            const entry = await repo.write(botId, { topic, text })
            return { ...base, status: 'succeeded', completion: 'committed', committedAt: new Date().toISOString(), revision: REVISION, details: { entryId: entry.id } }
          } catch (error) {
            return { ...base, status: 'failed', completion: 'failed', details: { reason: String(error) } }
          }
        },

        async dispose(): Promise<void> {
          // MemoryRepo 由宿主生命周期管理，这里无可释放资源（幂等空实现）
        },
      }
    },
  }
}
