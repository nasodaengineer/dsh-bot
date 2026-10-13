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

  return {
    names,
    dispose() {
      for (const dispose of disposers.splice(0)) dispose()
      names.length = 0
    },
  }
}
