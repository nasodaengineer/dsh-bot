/**
 * 共享 KV 打开 helper（修复轮 B5/B10）。
 *
 * 修复轮之前 identity/memory/template/groupchat 四处各自「backend.get → kv.open →
 * 失败降级进程内」，且对 unit 'dsh-bot' 声明了互不相同的表集合——多次 open 同一
 * unit 若带不同 tables 有覆盖/互斥风险。现在统一：
 * - openKvUnit(ctx)：唯一打开路径，全部模块打开同一张表清单 DSH_BOT_TABLES；
 * - 失败返回 undefined，调用方保留各自的 warn 降级文案（降级路径不崩溃不变）。
 */
import type { HostContext, KvUnit } from './types.js'

const BACKEND_NAME = 'json'
// 实测#8：宿主 UNIT_NAME_RE=/^[a-z][a-z0-9_]*$/ 不允许连字符，unit 名用下划线。
export const DSH_BOT_UNIT_NAME = 'dsh_bot'
export const DSH_BOT_UNIT_VERSION = 1

/**
 * 实测#8：宿主规定「同一 unit 打开两次未关闭是调用方 bug」——插件按 ctx 多实例
 * apply 时会重复调用 openKvUnit，第二次起 kv.open 拒绝并静默降级进程内（重启丢
 * 数据）。按 backend 对象身份缓存打开 promise：同一进程内多个 ctx 共享同一
 * backend → 共享同一 KvUnit；不同 backend（测试 fake）互不影响。
 */
const openedUnit = new WeakMap<object, Promise<KvUnit | undefined>>()

/** unit 'dsh-bot' 的全部表：唯一声明点，所有模块 open 同一清单（B10） */
export const DSH_BOT_TABLES = [
  'bots',
  'selection',
  'groups',
  'messages',
  'approvals',
  'memory',
  'memory_journal',
  'memory_snapshots',
  'templates',
] as const

export interface OpenKvUnitDescriptor {
  readonly name: typeof DSH_BOT_UNIT_NAME
  readonly version: typeof DSH_BOT_UNIT_VERSION
  readonly tables: readonly string[]
  readonly hasGlobal: false
}

/** 解析 KV unit；失败返回 undefined（调用方降级进程内），绝不抛错。 */
export async function openKvUnit(ctx: HostContext): Promise<{ kv: KvUnit | undefined; descriptor: OpenKvUnitDescriptor }> {
  const descriptor: OpenKvUnitDescriptor = {
    name: DSH_BOT_UNIT_NAME,
    version: DSH_BOT_UNIT_VERSION,
    tables: [...DSH_BOT_TABLES],
    hasGlobal: false,
  }
  const backend = ctx.storage?.backend
  if (backend === undefined) return { kv: undefined, descriptor }
  const cached = openedUnit.get(backend)
  if (cached !== undefined) return { kv: await cached, descriptor }
  const pending = (async (): Promise<KvUnit | undefined> => {
    // 实测#8 探针：trace KV 后端解析情况
    try {
      const fs = await import('node:fs')
      const names = backend ? (backend as unknown as { backends?: Map<string, unknown> }).backends : undefined
      fs.appendFileSync('E:\\data\\my-work\\dsh\\my-plugins\\dsh-bot\\.dsh-test-dsh-bot\\apply-trace.log',
        `${new Date().toISOString()} [pid=${process.pid}] openKvUnit: storage=${typeof ctx.storage} backend=${typeof backend} registered=[${names ? [...names.keys()].join(',') : 'n/a'}]\n`)
    } catch { /* 探针失败忽略 */ }
    if (backend === undefined) return undefined
    try {
      const medium = backend.get(BACKEND_NAME) as { kv?: { open(d: unknown): Promise<KvUnit> } } | undefined
      const kv = medium?.kv
      if (kv === undefined) return undefined
      return await kv.open(descriptor)
    } catch (err) {
      // 实测#8 探针：open 失败原因
      try {
        const fs = await import('node:fs')
        fs.appendFileSync('E:\\data\\my-work\\dsh\\my-plugins\\dsh-bot\\.dsh-test-dsh-bot\\apply-trace.log',
          `${new Date().toISOString()} [pid=${process.pid}] openKvUnit: open FAILED ${(err as Error)?.message ?? String(err)}\n`)
      } catch { /* 探针失败忽略 */ }
      return undefined
    }
  })()
  openedUnit.set(backend, pending)
  return { kv: await pending, descriptor }
}
