/**
 * 票 #6·Bot 专属工具 + MCP 接口切片。
 *
 * 工具面：ctx.tools.register(definition): () => void（dsh-tools index.d.ts:636），
 * 注册 bot_* 前缀的工具，execute 永不抛错（错误折叠进返回值）。
 * MCP：本票只做接口切片（server 名文法、公开工具名规则、配置登记），
 * 真正的 dsh-mcp-client 接线留给 P2。
 */
import type { BotRoster } from './roster.js'
import type { BotSchedulesRuntime } from './schedules.js'
import type { MemoryRepo } from './memory.js'
import type { TemplateStore } from './template.js'
import type { HostContext, ScheduleCreateRequest, ToolsService } from './types.js'

/** MCP server 名文法（预留 P2，先在这里冻结） */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/

export function isValidMcpServerName(name: string): boolean {
  return MCP_SERVER_NAME_RE.test(name)
}

export function assertMcpServerName(name: string): void {
  if (!isValidMcpServerName(name)) {
    throw new Error(`dsh-bot: 非法 MCP server 名 '${name}'（允许 1-32 位 [A-Za-z0-9_-]）`)
  }
}

/** 公开工具名规则：mcp__<server>__<原始工具名> */
export function mcpToolName(server: string, rawTool: string): string {
  assertMcpServerName(server)
  return `mcp__${server}__${rawTool}`
}

/** MCP server 配置（P2 接线时的输入形状，本票只登记与校验） */
export interface McpServerConfig {
  readonly name: string
  readonly transport: 'stdio' | 'http'
  readonly command?: string
  readonly args?: readonly string[]
  readonly url?: string
}

export interface McpBridge {
  readonly configured: readonly McpServerConfig[]
  /** P2 接线位：返回 false 表示尚未连接（本票不连） */
  connect(server: string): Promise<boolean>
}

export function createMcpBridge(configs: readonly McpServerConfig[]): McpBridge {
  for (const config of configs) {
    assertMcpServerName(config.name)
  }
  return {
    configured: [...configs],
    async connect(server) {
      assertMcpServerName(server)
      return false // P2：接 dsh-mcp-client
    },
  }
}

export interface BotToolsRuntime {
  readonly names: readonly string[]
  /** 注销全部 bot_* 工具 */
  dispose(): void
}

export interface BotToolsDeps {
  readonly roster: BotRoster
  /** 例程运行时可能晚于工具注册（schedule 是条件挂载），用取值函数解耦 */
  readonly getSchedules: () => BotSchedulesRuntime | undefined
  /** 记忆仓库（票 #10，异步就绪，用取值函数解耦） */
  readonly getMemory: () => MemoryRepo | undefined
  /** 当前选中 Bot（记忆按 Bot 隔离） */
  readonly getSelectedBotId: () => string | undefined
  /** 模板仓库（票 #11，异步就绪） */
  readonly getTemplates: () => TemplateStore | undefined
}

/** execute 统一包装：工具永不抛错 */
async function safeExecute(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn()
  } catch (error) {
    return { error: String(error instanceof Error ? error.message : error) }
  }
}

export function attachBotTools(ctx: HostContext, tools: ToolsService, deps: BotToolsDeps): BotToolsRuntime {
  const disposers: (() => void)[] = []
  const names: string[] = []
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)

  const register = (definition: Parameters<ToolsService['register']>[0]) => {
    try {
      disposers.push(tools.register(definition))
      names.push(definition.name)
    } catch (error) {
      warn(`注册工具 ${definition.name} 失败：${String(error)}`)
    }
  }

  register({
    name: 'bot_roster_list',
    description: '列出 dsh-bot 名册里的全部 Bot（id/名字/角色/人格）',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () =>
      safeExecute(async () => {
        const bots = await deps.roster.list()
        return { bots: bots.map((b) => ({ id: b.id, name: b.name, title: b.title, description: b.description })) }
      }),
  })

  register({
    name: 'bot_schedule_create',
    description:
      '为当前 Bot 创建定时例程（六形态之一：after_seconds | at | every_seconds | daily | weekly | cron），到点后 Bot 以 prompt 自动运行',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        prompt: { type: 'string' },
        after_seconds: { type: 'number' },
        at: { type: 'string' },
        every_seconds: { type: 'number' },
        daily: { type: 'object', properties: { time: { type: 'string' }, time_zone: { type: 'string' } } },
        weekly: {
          type: 'object',
          properties: { time: { type: 'string' }, time_zone: { type: 'string' }, weekdays: { type: 'array', items: { type: 'number' } } },
        },
        cron: { type: 'object', properties: { expression: { type: 'string' }, time_zone: { type: 'string' } } },
      },
      required: ['title', 'prompt'],
    },
    execute: (args) =>
      safeExecute(async () => {
        const schedules = deps.getSchedules()
        if (schedules === undefined) return { error: 'dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）' }
        return schedules.create(args as unknown as ScheduleCreateRequest)
      }),
  })

  register({
    name: 'bot_schedule_delete',
    description: '删除一个已创建的 Bot 例程（按 record id）',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: (args) =>
      safeExecute(async () => {
        const schedules = deps.getSchedules()
        if (schedules === undefined) return { error: 'dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）' }
        const id = (args as { id?: string }).id
        if (typeof id !== 'string' || id === '') return { error: 'dsh-bot: 缺少例程 id' }
        const deleted = await schedules.delete(id)
        return { deleted }
      }),
  })

  register({
    name: 'bot_schedule_list',
    description: '列出当前 Bot 在 root Session 上的全部例程',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () =>
      safeExecute(async () => {
        const schedules = deps.getSchedules()
        if (schedules === undefined) return { error: 'dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）' }
        return { schedules: await schedules.list() }
      }),
  })

  // ---- 修复轮 A3：bot_schedule_pause / bot_schedule_resume（schedules.ts 已有语义）----
  register({
    name: 'bot_schedule_pause',
    description: '暂停一个 Bot 例程（记住请求并从宿主删除；恢复用 bot_schedule_resume，record id 会变）',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: (args) =>
      safeExecute(async () => {
        const schedules = deps.getSchedules()
        if (schedules === undefined) return { error: 'dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）' }
        const id = (args as { id?: string }).id
        if (typeof id !== 'string' || id === '') return { error: 'dsh-bot: 缺少例程 id' }
        const paused = await schedules.pause(id)
        return paused === true ? { paused: true } : { error: `dsh-bot: 例程 '${id}' 不可暂停（未知或非本插件创建的例程）` }
      }),
  })

  register({
    name: 'bot_schedule_resume',
    description: '恢复一个已暂停的 Bot 例程（按记住的请求重建，返回新 record id）',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: (args) =>
      safeExecute(async () => {
        const schedules = deps.getSchedules()
        if (schedules === undefined) return { error: 'dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）' }
        const id = (args as { id?: string }).id
        if (typeof id !== 'string' || id === '') return { error: 'dsh-bot: 缺少例程 id' }
        const record = await schedules.resume(id)
        return record === undefined
          ? { error: `dsh-bot: 例程 '${id}' 不可恢复（没有暂停记录）` }
          : { record, note: '恢复后的例程 record id 已变，旧 id 失效' }
      }),
  })

  // ---- 票 #10：bot_memory_* 六件 ----
  const getMemory = (): MemoryRepo | undefined => {
    const repo = deps.getMemory()
    if (repo === undefined) warn('记忆仓库未就绪')
    return repo
  }
  const requireSelectedBot = (): string | undefined => {
    const id = deps.getSelectedBotId()
    if (id === undefined) warn('未选中 Bot，记忆工具需要先选定 Bot')
    return id
  }

  register({
    name: 'bot_memory_write',
    description: '为当前 Bot 写入一条长期记忆（主题 + 文本；单条有体积上限，超限请先摘要）',
    parameters: { type: 'object', properties: { topic: { type: 'string' }, text: { type: 'string' } }, required: ['topic', 'text'] },
    execute: (args) =>
      safeExecute(async () => {
        const repo = getMemory()
        const botId = requireSelectedBot()
        if (repo === undefined || botId === undefined) return { error: 'dsh-bot: 记忆仓库未就绪或未选中 Bot' }
        const a = args as { topic?: string; text?: string }
        if (typeof a.topic !== 'string' || typeof a.text !== 'string') return { error: 'dsh-bot: topic 与 text 必填' }
        return { entry: await repo.write(botId, { topic: a.topic, text: a.text }) }
      }),
  })

  register({
    name: 'bot_memory_read',
    description: '读取当前 Bot 某个主题下的全部记忆条目',
    parameters: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
    execute: (args) =>
      safeExecute(async () => {
        const repo = getMemory()
        const botId = requireSelectedBot()
        if (repo === undefined || botId === undefined) return { error: 'dsh-bot: 记忆仓库未就绪或未选中 Bot' }
        const topic = (args as { topic?: string }).topic
        if (typeof topic !== 'string') return { error: 'dsh-bot: topic 必填' }
        return { entries: await repo.read(botId, topic) }
      }),
  })

  register({
    name: 'bot_memory_search',
    description: '按关键词检索当前 Bot 的长期记忆（关键词全命中才返回）',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    execute: (args) =>
      safeExecute(async () => {
        const repo = getMemory()
        const botId = requireSelectedBot()
        if (repo === undefined || botId === undefined) return { error: 'dsh-bot: 记忆仓库未就绪或未选中 Bot' }
        const query = (args as { query?: string }).query
        if (typeof query !== 'string') return { error: 'dsh-bot: query 必填' }
        return { entries: await repo.search(botId, query) }
      }),
  })

  register({
    name: 'bot_memory_list',
    description: '列出当前 Bot 的全部记忆条目（按主题排序）',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () =>
      safeExecute(async () => {
        const repo = getMemory()
        const botId = requireSelectedBot()
        if (repo === undefined || botId === undefined) return { error: 'dsh-bot: 记忆仓库未就绪或未选中 Bot' }
        return { entries: await repo.list(botId) }
      }),
  })

  register({
    name: 'bot_memory_forget',
    description: '删除当前 Bot 的一条记忆（按 topic + 条目 id）',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string' }, id: { type: 'string' } },
      required: ['topic', 'id'],
    },
    execute: (args) =>
      safeExecute(async () => {
        const repo = getMemory()
        const botId = requireSelectedBot()
        if (repo === undefined || botId === undefined) return { error: 'dsh-bot: 记忆仓库未就绪或未选中 Bot' }
        const a = args as { topic?: string; id?: string }
        if (typeof a.topic !== 'string' || typeof a.id !== 'string') return { error: 'dsh-bot: topic 与 id 必填' }
        return { deleted: await repo.forget(botId, a.topic, a.id) }
      }),
  })

  register({
    name: 'bot_memory_journal',
    description: '查看当前 Bot 的记忆变更流水（write/forget），最新的在前',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } },
    execute: (args) =>
      safeExecute(async () => {
        const repo = getMemory()
        const botId = requireSelectedBot()
        if (repo === undefined || botId === undefined) return { error: 'dsh-bot: 记忆仓库未就绪或未选中 Bot' }
        const limit = (args as { limit?: number }).limit
        return { journal: await repo.journal(botId, typeof limit === 'number' ? limit : undefined) }
      }),
  })

  // ---- 票 #11：bot_template_* 三件 ----
  register({
    name: 'bot_template_export',
    description: '把一个 Bot 导出成模板（人格 + 可选记忆 + 技能清单；非标准插件如 MCP server 不打包）',
    parameters: {
      type: 'object',
      properties: { botId: { type: 'string' }, includeMemory: { type: 'boolean' }, name: { type: 'string' } },
      required: ['botId', 'includeMemory'],
    },
    execute: (args) =>
      safeExecute(async () => {
        const store = deps.getTemplates()
        if (store === undefined) return { error: 'dsh-bot: 模板仓库未就绪' }
        const a = args as { botId?: string; includeMemory?: boolean; name?: string }
        if (typeof a.botId !== 'string' || typeof a.includeMemory !== 'boolean') {
          return { error: 'dsh-bot: botId 与 includeMemory 必填' }
        }
        return { template: await store.exportTemplate(a.botId, { includeMemory: a.includeMemory, name: a.name }) }
      }),
  })

  register({
    name: 'bot_template_import',
    description: '从模板导入派生一个新 Bot（人格 + 技能重建 + 记忆按模板还原）',
    parameters: {
      type: 'object',
      properties: { templateId: { type: 'string' }, name: { type: 'string' } },
      required: ['templateId'],
    },
    execute: (args) =>
      safeExecute(async () => {
        const store = deps.getTemplates()
        if (store === undefined) return { error: 'dsh-bot: 模板仓库未就绪' }
        const a = args as { templateId?: string; name?: string }
        if (typeof a.templateId !== 'string') return { error: 'dsh-bot: templateId 必填' }
        return store.importTemplate(a.templateId, { name: a.name })
      }),
  })

  register({
    name: 'bot_template_list',
    description: '列出全部已导出的 Bot 模板',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: () =>
      safeExecute(async () => {
        const store = deps.getTemplates()
        if (store === undefined) return { error: 'dsh-bot: 模板仓库未就绪' }
        return { templates: await store.list() }
      }),
  })

  return {
    names,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      names.length = 0
    },
  }
}
