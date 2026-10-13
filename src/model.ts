/**
 * 票 #6·模型选择：目录聚合 + 选模型 + 随 Bot 持久（KV）。
 *
 * 签名来源（0.2.1-alpha.2，逐个与 .d.ts 核对）：
 * - ctx.llm.listProviders(): LlmProviderInfo[]（同步）；listModels(provider): Promise<LlmModelInfo[]>
 *   （dsh-llm/lib/types/index.d.ts:272,350）
 * - ctx.sessionController.selectModel({provider, model, reasoningEffort?, sessionId}):
 *   Promise<{ selected: ModelSelection }>（dsh-api-session-controller index.d.ts:105）
 * 持久化语义：Session 侧由宿主 selectModel 写 Session record；Bot 侧默认选择写
 * IdentityStore 的 selection 表（key 'model'），重启后 persona/装配可读回。
 */
import type { HostContext } from './types.js'
import type { LlmService, ModelSelection, SessionControllerService } from './types.js'
import type { IdentityStore } from './identity.js'

const MODEL_META_KEY = 'model'

export interface ModelCatalogEntry {
  readonly provider: string
  readonly models: string[]
}

export interface ModelRuntime {
  /** 聚合 llm.listProviders × listModels 为目录；单 provider 失败降级为空列表并 warn */
  listCatalog(): Promise<ModelCatalogEntry[]>
  /** 转发 sessionController.selectModel，并把选择持久化（selection 表 key 'model'） */
  selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection>
  /** 最近一次成功选择（进程内缓存，KV 为事实源） */
  currentSelection(): ModelSelection | undefined
}

export function attachModelRuntime(
  ctx: HostContext,
  opts: { llm: LlmService; sessionController: SessionControllerService; store: IdentityStore },
): ModelRuntime {
  const { llm, sessionController, store } = opts
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  let cached: ModelSelection | undefined

  // 启动即读回持久化的选择（异步、失败静默为 undefined）
  void store.getMeta(MODEL_META_KEY).then((value) => {
    if (isModelSelection(value)) cached = value
  })

  return {
    async listCatalog() {
      const providers = llm.listProviders()
      const entries: ModelCatalogEntry[] = []
      for (const provider of providers) {
        try {
          const models = await llm.listModels(provider.name)
          entries.push({ provider: provider.name, models: models.map((m) => m.id) })
        } catch (error) {
          warn(`列模型失败（provider=${provider.name}）：${String(error)}`)
          entries.push({ provider: provider.name, models: [] })
        }
      }
      return entries
    },

    async selectModel(sessionId, selection) {
      const result = await sessionController.selectModel({ sessionId, ...selection })
      cached = result.selected
      await store.putMeta(MODEL_META_KEY, result.selected)
      return result.selected
    },

    currentSelection() {
      return cached
    },
  }
}

function isModelSelection(value: unknown): value is ModelSelection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ModelSelection).provider === 'string' &&
    typeof (value as ModelSelection).model === 'string'
  )
}
