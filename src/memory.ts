/**
 * 票 #10·Bot 记忆机制（Agent Memory Repo 格式 × ctx.storage）。
 *
 * 格式沿用 DS Bot 的 Agent Memory Repo：MEMORY.md 索引 + 主题条目 + journal + 快照，
 * 但存储/索引换成 ctx.storage（KV unit 'dsh-bot'，与 #3/#7/#8 一致）：
 * - 表 memory：条目 {id, botId, topic, text, size, createdAt, updatedAt}（按 bot 隔离）
 * - 表 memory_journal：动作流水（write/forget）
 * - 表 memory_snapshots：索引快照（摘要压缩接缝：后续 compact 可基于快照做）
 *
 * 体积上限策略：单条 MAX_ENTRY_CHARS（超限拒绝，不静默截断）；每 Bot 条目数上限。
 * KV 缺失时降级进程内并 warn（与 identity.ts 同款降级路径）。
 */
import type { HostContext, KvUnit } from './types.js'
import { openKvUnit } from './kv.js'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** journal 流水条数上限（C13：超出裁掉最旧；摘要压缩仍留接缝不做） */
export const MAX_JOURNAL_RECORDS = 1000

/** 单条记忆体积上限（K 体积上限策略：超限拒绝，摘要压缩走 snapshot 接缝） */
export const MAX_ENTRY_CHARS = 8 * 1024
/** 每 Bot 条目数上限 */
export const MAX_ENTRIES_PER_BOT = 500
/** 快照保留数（旧的淘汰） */
const SNAPSHOT_KEEP = 20

/**
 * 摘要产物镜像目录（票 #15：用户指定的本地 mnemon 数据目录，绝不外发）。
 * 这是固定目录锚点，不适用 agent.session.cwd 的路径纪律；写入必须 try/catch + warn 降级。
 */
export const DEFAULT_MIRROR_DIR = 'E:\\data\\my-work\\dsh\\mem-space'
/** 默认压缩批次（到顶时一次合并的最旧条数） */
export const DEFAULT_COMPACT_BATCH = Math.floor(MAX_ENTRIES_PER_BOT / 2)

export interface MemoryEntry {
  readonly id: string
  readonly botId: string
  readonly topic: string
  readonly text: string
  readonly size: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface JournalRecord {
  readonly seq: number
  readonly botId: string
  readonly action: 'write' | 'forget' | 'compact'
  readonly entryId: string
  readonly topic: string
  readonly at: string
}

export interface SnapshotRecord {
  readonly id: string
  readonly botId: string
  readonly index: string
  readonly at: string
}

export interface MemoryRepo {
  write(botId: string, input: { topic: string; text: string }): Promise<MemoryEntry>
  read(botId: string, topic: string): Promise<MemoryEntry[]>
  /** 关键词全命中检索（token 全部出现在 text+topic 里才算命中），按命中 token 数排序 */
  search(botId: string, query: string): Promise<MemoryEntry[]>
  list(botId: string): Promise<MemoryEntry[]>
  forget(botId: string, topic: string, entryId: string): Promise<boolean>
  /** MEMORY.md 风格索引：主题分组的 Markdown 文本 */
  indexText(botId: string): Promise<string>
  journal(botId: string, limit?: number): Promise<JournalRecord[]>
  /** 索引快照（摘要压缩的接缝：后续 compact 流程可基于快照改写条目） */
  snapshot(botId: string): Promise<SnapshotRecord>
  /**
   * 摘要压缩（票 #15）：把最旧一批记忆合成一条「摘要」条目并腾出空间。
   * 摘要算法为最简实现（首句拼接 + 计数），标注可替换为 LLM 通道；
   * 摘要产物镜像写入本地 mnemon 数据目录（失败 warn 降级跳过）。
   */
  compact(botId: string): Promise<MemoryEntry | undefined>
}

export interface MemoryRepoOptions {
  /** 触发压缩的条目数阈值（默认 MAX_ENTRIES_PER_BOT：500 条到顶触发） */
  readonly compactThreshold?: number
  /** 到顶时一次合并的最旧条数（默认 min(阈值/2, MAX/2)） */
  readonly compactBatch?: number
  /** 摘要镜像目录（默认 DEFAULT_MIRROR_DIR；测试注入 tmp 路径） */
  readonly mirrorDir?: string
}

/** 解析 KV unit（B5：走共享 openKvUnit）；失败返回 undefined（调用方降级进程内）。 */
async function openUnit(ctx: HostContext) {
  return (await openKvUnit(ctx)).kv
}

export async function createMemoryRepo(ctx: HostContext, options: MemoryRepoOptions = {}): Promise<MemoryRepo> {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  const compactBatch = Math.max(1, options.compactBatch ?? DEFAULT_COMPACT_BATCH)
  const compactThreshold = Math.max(compactBatch, options.compactThreshold ?? MAX_ENTRIES_PER_BOT)
  const mirrorDir = options.mirrorDir ?? DEFAULT_MIRROR_DIR
  let kv: KvUnit | undefined
  try {
    kv = await openUnit(ctx)
  } catch (error) {
    kv = undefined
    warn(`记忆仓库打开 KV unit 失败，降级为进程内存储：${String(error)}`)
  }
  if (kv === undefined && ctx.storage !== undefined) {
    warn('记忆仓库打开 KV unit 失败，降级为进程内存储，重启即丢')
  }

  const entries = new Map<string, MemoryEntry>() // `${botId}:${id}` → entry
  const journalRows = new Map<string, JournalRecord>() // seq → record
  const snapshots = new Map<string, SnapshotRecord>() // `${botId}:${id}` → snapshot
  let seq = 0

  // 启动时装载已有记录：读走缓存，写双写（identity.ts 同款）。
  if (kv !== undefined) {
    const snapshot = await kv.loadAll()
    for (const value of Object.values(snapshot.tables['memory'] ?? {})) {
      const entry = value as MemoryEntry
      entries.set(`${entry.botId}:${entry.id}`, entry)
    }
    for (const [key, value] of Object.entries(snapshot.tables['memory_journal'] ?? {})) {
      journalRows.set(key, value as JournalRecord)
      const n = Number(key)
      if (Number.isFinite(n) && n > seq) seq = n
    }
    for (const [key, value] of Object.entries(snapshot.tables['memory_snapshots'] ?? {})) {
      snapshots.set(key, value as SnapshotRecord)
    }
  }

  const keyOf = (botId: string, id: string) => `${botId}:${id}`

  function listEntries(botId: string): MemoryEntry[] {
    return [...entries.values()]
      .filter((e) => e.botId === botId)
      .sort((a, b) => a.topic.localeCompare(b.topic) || a.createdAt.localeCompare(b.createdAt))
  }

  function buildIndex(botId: string, mine: readonly MemoryEntry[]): string {
    const topics = new Map<string, MemoryEntry[]>()
    for (const entry of mine) {
      const list = topics.get(entry.topic) ?? []
      list.push(entry)
      topics.set(entry.topic, list)
    }
    const lines = [`# 记忆索引（${botId}）`, '']
    for (const [topic, list] of topics) {
      lines.push(`## ${topic}`)
      for (const entry of list) lines.push(`- ${entry.text}`)
      lines.push('')
    }
    return lines.join('\n').trimEnd()
  }

  async function persistPut(entry: MemoryEntry): Promise<void> {
    if (kv !== undefined) await kv.putRecord('memory', keyOf(entry.botId, entry.id), entry)
  }

  async function appendJournal(
    action: JournalRecord['action'],
    fields: { entryId: string; topic: string; botId: string },
  ): Promise<void> {
    seq += 1
    const record: JournalRecord = {
      seq,
      botId: fields.botId,
      action,
      entryId: fields.entryId,
      topic: fields.topic,
      at: new Date().toISOString(),
    }
    journalRows.set(String(record.seq), record)
    if (kv !== undefined) await kv.putRecord('memory_journal', String(record.seq), record)
    // C13：流水按条数上限裁掉最旧（摘要压缩不做，留 snapshot 接缝）
    if (journalRows.size > MAX_JOURNAL_RECORDS) {
      let oldestKey: string | undefined
      let oldestSeq = Number.POSITIVE_INFINITY
      for (const [key, row] of journalRows) {
        if (row.seq < oldestSeq) {
          oldestSeq = row.seq
          oldestKey = key
        }
      }
      if (oldestKey !== undefined) {
        journalRows.delete(oldestKey)
        if (kv !== undefined) await kv.deleteRecord('memory_journal', oldestKey)
      }
    }
  }

  /** 摘要产物镜像（票 #15）：JSON 落盘到本地 mnemon 数据目录；任何失败 warn 降级，不崩溃 */
  async function mirrorSummary(botId: string, summary: MemoryEntry, mergedCount: number): Promise<void> {
    try {
      const dir = join(mirrorDir, 'dsh-bot', botId)
      await mkdir(dir, { recursive: true })
      const payload = {
        plugin: 'dsh-bot',
        botId,
        summaryEntryId: summary.id,
        mergedCount,
        at: summary.createdAt,
        summary: summary.text,
      }
      const file = join(dir, `${summary.createdAt.replace(/[:.]/g, '-')}-${summary.id}.json`)
      await writeFile(file, JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      warn(`摘要镜像写入失败（目录 ${mirrorDir} 不可写？），降级跳过不崩溃：${String(error)}`)
    }
  }

  /** 最简摘要算法：首句拼接 + 计数（标注可替换为 LLM 通道） */
  function buildSummaryText(merged: readonly MemoryEntry[]): string {
    const header = `[压缩摘要] 合并 ${merged.length} 条最旧记忆（算法：首句拼接，可替换为 LLM 摘要）`
    const lines: string[] = []
    let size = header.length
    for (const entry of merged) {
      const firstSentence = entry.text.split(/(?<=[。！？!?\n])/)[0]?.trim() ?? entry.text
      const line = `- ${entry.topic}：${firstSentence}`
      if (size + line.length + 1 > MAX_ENTRY_CHARS) {
        lines.push('- …（更多已省略）')
        break
      }
      lines.push(line)
      size += line.length + 1
    }
    return [header, ...lines].join('\n')
  }

  async function newEntry(botId: string, topic: string, text: string): Promise<MemoryEntry> {
    const now = new Date().toISOString()
    const entry: MemoryEntry = {
      id: `mem-${Date.now().toString(36)}-${seq + 1}-${Math.random().toString(36).slice(2, 6)}`,
      botId,
      topic,
      text,
      size: text.length,
      createdAt: now,
      updatedAt: now,
    }
    entries.set(keyOf(botId, entry.id), entry)
    await persistPut(entry)
    return entry
  }

  /** 摘要压缩核心：合并最旧一批为一条「摘要」条目，journal 落 compact 记录，镜像降级写盘 */
  async function compactEntries(botId: string): Promise<MemoryEntry | undefined> {
    const mine = [...entries.values()]
      .filter((e) => e.botId === botId)
      // 稳定排序：createdAt 相同（同毫秒批量写入）时保持 Map 插入序 = 写入序
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    if (mine.length === 0) return undefined
    const merged = mine.slice(0, Math.min(compactBatch, mine.length))
    const text = buildSummaryText(merged)
    const summary = await newEntry(botId, '摘要', text)
    for (const entry of merged) {
      const key = keyOf(botId, entry.id)
      entries.delete(key)
      if (kv !== undefined) await kv.deleteRecord('memory', key)
    }
    await appendJournal('compact', { entryId: summary.id, topic: summary.topic, botId })
    await mirrorSummary(botId, summary, merged.length)
    return summary
  }

  return {
    async write(botId, input) {
      const topic = input.topic.trim()
      if (topic === '') throw new Error('dsh-bot: 记忆 topic 不能为空')
      const text = input.text
      if (text.length > MAX_ENTRY_CHARS) {
        throw new Error(`dsh-bot: 单条记忆体积超上限（${text.length} > ${MAX_ENTRY_CHARS} 字符），请先摘要压缩`)
      }
      const mine = [...entries.values()].filter((e) => e.botId === botId)
      if (mine.length + 1 > compactThreshold) {
        // 票 #15：到顶先压缩腾空间，而不是直接拒绝
        await compactEntries(botId)
        const left = [...entries.values()].filter((e) => e.botId === botId).length
        if (left + 1 > compactThreshold) {
          throw new Error(`dsh-bot: Bot '${botId}' 记忆条目数已达上限 ${compactThreshold}，压缩后仍满，请先整理（snapshot + forget）`)
        }
      }
      const now = new Date().toISOString()
      const existing = mine.find((e) => e.topic === topic && e.text === text)
      const entry: MemoryEntry = {
        id: existing?.id ?? `mem-${Date.now().toString(36)}-${seq + 1}-${Math.random().toString(36).slice(2, 6)}`,
        botId,
        topic,
        text,
        size: text.length,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      entries.set(keyOf(botId, entry.id), entry)
      await persistPut(entry)
      await appendJournal('write', { entryId: entry.id, topic: entry.topic, botId: entry.botId })
      return entry
    },

    async read(botId, topic) {
      return [...entries.values()]
        .filter((e) => e.botId === botId && e.topic === topic)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async search(botId, query) {
      const tokens = query.split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t !== '')
      if (tokens.length === 0) return []
      const scored: Array<{ entry: MemoryEntry; hits: number }> = []
      for (const entry of entries.values()) {
        if (entry.botId !== botId) continue
        const haystack = `${entry.topic} ${entry.text}`.toLowerCase()
        let hits = 0
        let all = true
        for (const token of tokens) {
          if (haystack.includes(token)) hits += 1
          else all = false
        }
        if (all) scored.push({ entry, hits })
      }
      return scored.sort((a, b) => b.hits - a.hits).map((s) => s.entry)
    },

    async list(botId) {
      return listEntries(botId)
    },

    async forget(botId, topic, entryId) {
      const key = keyOf(botId, entryId)
      const entry = entries.get(key)
      if (entry === undefined || entry.topic !== topic) return false
      entries.delete(key)
      if (kv !== undefined) await kv.deleteRecord('memory', key)
      await appendJournal('forget', { entryId: entry.id, topic: entry.topic, botId: entry.botId })
      return true
    },

    async indexText(botId) {
      return buildIndex(botId, listEntries(botId))
    },

    async journal(botId, limit = 50) {
      return [...journalRows.values()]
        .filter((r) => r.botId === botId)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, limit)
    },

    async snapshot(botId) {
      const index = buildIndex(botId, listEntries(botId))
      seq += 1
      const record: SnapshotRecord = {
        id: `snap-${seq}`,
        botId,
        index,
        at: new Date().toISOString(),
      }
      const key = keyOf(botId, record.id)
      snapshots.set(key, record)
      if (kv !== undefined) await kv.putRecord('memory_snapshots', key, record)
      // 淘汰旧快照（每 Bot 只保留最近 SNAPSHOT_KEEP 份）
      const mine = [...snapshots.entries()]
        .filter(([k, v]) => v.botId === botId)
        .sort((a, b) => b[1].at.localeCompare(a[1].at))
      for (const [k] of mine.slice(SNAPSHOT_KEEP)) {
        snapshots.delete(k)
        if (kv !== undefined) void kv.deleteRecord('memory_snapshots', k)
      }
      return record
    },

    async compact(botId) {
      return compactEntries(botId)
    },
  }
}
