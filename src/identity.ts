/**
 * Bot 身份存储：基于 ctx.storage（KV hub）。
 *
 * 决策依据（票 #2/#3）：状态走 ctx.storage，不建 state.json 单文件。
 * dsh-storage 的契约是「hub 不做 IO，backend 拥有介质」——本插件假定部署里有
 * 名为 `json` 的 backend（@deepseek-ai/dsh-storage-json 注册）。backend 缺失时
 * 降级为进程内 Map，并 warn（不破坏插件激活，P1 再决定是否自带 backend）。
 */
import type { BotIdentity, HostContext, KvUnit, StorageBackendRegistry } from './types.js'

const BACKEND_NAME = 'json'
const UNIT_NAME = 'dsh-bot'
const TABLE_NAME = 'bots'
const SELECTION_TABLE = 'selection'
const UNIT_VERSION = 1

export interface IdentityStore {
  put(identity: BotIdentity): Promise<void>
  get(id: string): Promise<BotIdentity | undefined>
  list(): Promise<BotIdentity[]>
  /** 同步读缓存：systemPrompt 的 section provider 是同步求值的，人格段用它 */
  listSync(): BotIdentity[]
  remove(id: string): Promise<void>
  /** 当前选中 Bot（票 #6：从 P0 的进程内变量升级为 KV 持久化） */
  putSelectedId(id: string | undefined): Promise<void>
  getSelectedId(): Promise<string | undefined>
  /** Bot 级默认模型选择（随 Bot 持久，key = `model:<botId>` 或全局 `model`） */
  putMeta(key: string, value: unknown): Promise<void>
  getMeta(key: string): Promise<unknown>
}

/** 解析 KV unit；失败返回 undefined 并 warn 一次。 */
async function openUnit(backend: StorageBackendRegistry | undefined): Promise<KvUnit | undefined> {
  if (backend === undefined) return undefined
  let medium: unknown
  try {
    medium = backend.get(BACKEND_NAME)
  } catch {
    return undefined
  }
  const kv = (medium as { kv?: { open(d: unknown): Promise<KvUnit> } } | undefined)?.kv
  if (kv === undefined) return undefined
  return kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: [TABLE_NAME, SELECTION_TABLE], hasGlobal: false })
}

export async function createIdentityStore(ctx: HostContext): Promise<IdentityStore> {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  let unit: KvUnit | undefined
  try {
    unit = await openUnit(ctx.storage?.backend)
  } catch (error) {
    unit = undefined
    warn(`打开 KV unit 失败，降级为进程内存储：${String(error)}`)
  }

  // 降级路径：进程内 Map。ctx.storage 缺失时静默降级即可，warn 一次。
  const memory = new Map<string, BotIdentity>()
  const selectionMemory = new Map<string, unknown>()
  let degraded = false
  if (unit === undefined) {
    degraded = true
    if (ctx.storage === undefined) warn('ctx.storage 服务缺失，Bot 身份降级为进程内存储，重启即丢')
  }

  // 启动时把已有记录捞进缓存：读路径统一走缓存，写路径双写保证耐久。
  if (unit !== undefined) {
    const snapshot = await unit.loadAll()
    const records = snapshot.tables[TABLE_NAME] ?? {}
    for (const [key, value] of Object.entries(records)) {
      memory.set(key, value as BotIdentity)
    }
    const selectionRecords = snapshot.tables[SELECTION_TABLE] ?? {}
    for (const [key, value] of Object.entries(selectionRecords)) {
      selectionMemory.set(key, value)
    }
  }

  return {
    async put(identity) {
      memory.set(identity.id, identity)
      if (!degraded) await unit!.putRecord(TABLE_NAME, identity.id, identity)
    },
    async get(id) {
      return memory.get(id)
    },
    async list() {
      return [...memory.values()]
    },
    listSync() {
      return [...memory.values()]
    },
    async remove(id) {
      memory.delete(id)
      if (!degraded) await unit!.deleteRecord(TABLE_NAME, id)
    },
    async putSelectedId(id) {
      if (id === undefined) {
        selectionMemory.delete('selectedId')
        if (!degraded) await unit!.deleteRecord(SELECTION_TABLE, 'selectedId')
        return
      }
      selectionMemory.set('selectedId', id)
      if (!degraded) await unit!.putRecord(SELECTION_TABLE, 'selectedId', id)
    },
    async getSelectedId() {
      return selectionMemory.get('selectedId') as string | undefined
    },
    async putMeta(key, value) {
      selectionMemory.set(key, value)
      if (!degraded) await unit!.putRecord(SELECTION_TABLE, key, value)
    },
    async getMeta(key) {
      return selectionMemory.get(key)
    },
  }
}
