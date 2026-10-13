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
export const DSH_BOT_UNIT_NAME = 'dsh-bot'
export const DSH_BOT_UNIT_VERSION = 1

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
  try {
    const medium = backend.get(BACKEND_NAME) as { kv?: { open(d: unknown): Promise<KvUnit> } } | undefined
    const kv = medium?.kv
    if (kv === undefined) return { kv: undefined, descriptor }
    return { kv: await kv.open(descriptor), descriptor }
  } catch {
    return { kv: undefined, descriptor }
  }
}
