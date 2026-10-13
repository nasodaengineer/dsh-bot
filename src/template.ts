/**
 * 票 #11·模板分发：把「人格 + 记忆 + 技能」打包成可导入的模板。
 *
 * 关键事实（research/grok-bot-features.md 模板域，裁决照搬）：
 * 非标准插件（MCP servers、脚本、代码）不包含在模板里——只登记技能清单
 * （例程标题、MCP server 名）作为描述性元数据；标准可重建的部分（例程）
 * 导入时用 schedules 运行时重建，MCP 重连留接缝（mcp.connect P2 桩尚未实现）。
 *
 * 存储：KV unit 'dsh-bot' 的 templates 表（与 #3/#7/#8/#10 一致）。
 */
import type { HostContext, KvUnit, BotIdentity } from './types.js'
import type { BotRoster } from './roster.js'
import type { MemoryRepo } from './memory.js'
import type { BotSchedulesRuntime } from './schedules.js'

const BACKEND_NAME = 'json'
const UNIT_NAME = 'dsh-bot'
const UNIT_VERSION = 1
const TABLE_NAME = 'templates'

export interface TemplateRecord {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly sourceBotId: string
  /** 人格：派生 Bot 时的身份字段 */
  readonly persona: { name: string; title: string; description: string; color?: string }
  /** 技能：可重建的例程（标题清单，导入时重建）+ 描述性 MCP server 名（不打包，留接缝） */
  readonly skills: { scheduleTitles: readonly string[]; mcpServerNames: readonly string[] }
  /** 记忆：includeMemory=false 时为空数组 */
  readonly includeMemory: boolean
  readonly memory: readonly { topic: string; text: string }[]
  readonly createdAt: string
}

export interface TemplateStoreDeps {
  readonly roster: BotRoster
  readonly getMemory: () => MemoryRepo | undefined
  readonly getSchedules: () => BotSchedulesRuntime | undefined
  /** 已配置的 MCP server 名（只登记名字，不打包） */
  readonly getMcpServerNames: () => readonly string[]
}

export interface TemplateStore {
  exportTemplate(botId: string, options: { includeMemory: boolean; name?: string }): Promise<TemplateRecord>
  importTemplate(templateId: string, options: { name?: string }): Promise<{
    botId: string
    restoredSchedules: number
    restoredMemory: number
    mcpRestored: boolean
  }>
  list(): Promise<TemplateRecord[]>
  get(templateId: string): Promise<TemplateRecord | undefined>
}

async function openTables(ctx: HostContext): Promise<KvUnit | undefined> {
  const backend = ctx.storage?.backend
  if (backend === undefined) return undefined
  try {
    const medium = backend.get(BACKEND_NAME) as { kv?: { open(d: unknown): Promise<KvUnit> } } | undefined
    const kv = medium?.kv
    if (kv === undefined) return undefined
    return await kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: [TABLE_NAME], hasGlobal: false })
  } catch {
    return undefined
  }
}

function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'bot'
}

export async function createTemplateStore(ctx: HostContext, deps: TemplateStoreDeps): Promise<TemplateStore> {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  let kv: KvUnit | undefined
  try {
    kv = await openTables(ctx)
  } catch {
    kv = undefined
  }
  if (kv === undefined && ctx.storage !== undefined) {
    warn('模板表打开 KV unit 失败，降级为进程内存储，重启即丢')
  }

  const templates = new Map<string, TemplateRecord>()
  if (kv !== undefined) {
    const snapshot = await kv.loadAll()
    for (const [key, value] of Object.entries(snapshot.tables[TABLE_NAME] ?? {})) {
      templates.set(key, value as TemplateRecord)
    }
  }

  let importSeq = 0
  let tplSeq = 0

  async function persist(record: TemplateRecord): Promise<void> {
    if (kv !== undefined) await kv.putRecord(TABLE_NAME, record.id, record)
  }

  return {
    async exportTemplate(botId, options) {
      const bots = await deps.roster.list()
      const bot: BotIdentity | undefined = bots.find((b) => b.id === botId)
      if (bot === undefined) throw new Error(`dsh-bot: 未知 Bot '${botId}'，无法导出模板`)
      tplSeq += 1
      const memoryEntries: { topic: string; text: string }[] = []
      if (options.includeMemory) {
        const repo = deps.getMemory()
        if (repo === undefined) warn('记忆仓库未就绪，模板不带记忆')
        else for (const entry of await repo.list(botId)) memoryEntries.push({ topic: entry.topic, text: entry.text })
      }
      const scheduleTitles: string[] = []
      const schedules = deps.getSchedules()
      if (schedules !== undefined) {
        for (const record of await schedules.list()) scheduleTitles.push(record.title)
      }
      const record: TemplateRecord = {
        id: `tpl-${Date.now().toString(36)}-${tplSeq}`,
        name: options.name ?? `${bot.name} 模板`,
        description: `从 Bot '${botId}' 导出的模板：${bot.title}`,
        sourceBotId: botId,
        persona: { name: bot.name, title: bot.title, description: bot.description, color: bot.color },
        skills: { scheduleTitles, mcpServerNames: [...deps.getMcpServerNames()] },
        includeMemory: options.includeMemory,
        memory: memoryEntries,
        createdAt: new Date().toISOString(),
      }
      templates.set(record.id, record)
      await persist(record)
      return record
    },

    async importTemplate(templateId, options) {
      const tpl = templates.get(templateId)
      if (tpl === undefined) throw new Error(`dsh-bot: 未知模板 '${templateId}'`)
      importSeq += 1
      const name = options.name ?? `${tpl.persona.name}-${importSeq}`
      const botId = `${slugOf(name)}-tpl-${importSeq}`
      const identity: BotIdentity = {
        id: botId,
        name,
        title: tpl.persona.title,
        description: tpl.persona.description,
        ...(tpl.persona.color !== undefined ? { color: tpl.persona.color } : {}),
      }
      await deps.roster.create(identity)

      let restoredMemory = 0
      if (tpl.includeMemory) {
        const repo = deps.getMemory()
        if (repo === undefined) warn('记忆仓库未就绪，模板记忆未还原')
        else {
          for (const entry of tpl.memory) {
            await repo.write(botId, { topic: entry.topic, text: entry.text })
            restoredMemory += 1
          }
        }
      }

      let restoredSchedules = 0
      const schedules = deps.getSchedules()
      if (schedules === undefined) {
        if (tpl.skills.scheduleTitles.length > 0) warn('schedule 服务未挂载，模板例程未重建（接缝：宿主开 Automation 后可用 bot_schedule_create 手工重建）')
      } else {
        // 例程 prompt 不在模板清单里（清单只存标题），重建用占位 prompt 并留接缝：
        // 后续可把完整 ScheduleCreateRequest 序列化进模板。
        for (const title of tpl.skills.scheduleTitles) {
          try {
            await schedules.create({ title, prompt: `（模板 ${tpl.id} 重建的例程：${title}）`, every_seconds: 86_400 })
            restoredSchedules += 1
          } catch (error) {
            warn(`例程 '${title}' 重建失败：${String(error)}`)
          }
        }
      }

      // 接缝：MCP server 不打包（非标准插件），导入后需用户在宿主重新配置
      const mcpRestored = false
      if (tpl.skills.mcpServerNames.length > 0) {
        warn(`模板登记的 MCP server [${tpl.skills.mcpServerNames.join(', ')}] 不随模板分发，需在宿主重新配置`)
      }
      return { botId, restoredSchedules, restoredMemory, mcpRestored }
    },

    async list() {
      return [...templates.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    async get(templateId) {
      return templates.get(templateId)
    },
  }
}
