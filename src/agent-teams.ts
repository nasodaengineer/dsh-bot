/**
 * 票 #8·ctx.agentTeams 封装（原生 TeamService 的门面）。
 *
 * 原生安全模型（票 #7 裁决 1/任务范围 1）：原生 spawnTeammate / sendMessage / 任务四件
 * 都要求传「确切的 live 调用方 Agent」作权限凭据——本门面每个方法把 caller 作为显式
 * 第一参收下并**原样透传**，绝不合成、不缓存、不绕过。caller 缺失直接抛错。
 *
 * 类型策略：dsh-experimental-agent-team 是 pre-stable 包，这里只做文档化契约的
 * 宽松切片（unknown 透传），不 import @deepseek-ai/*。
 */

/** 原生 TeamService 切片：签名与宿主 dsh-experimental-agent-team 一致（caller 在第一位） */
export interface AgentTeamsService {
  membership(caller: unknown): Promise<unknown>
  tryMembership(caller: unknown): Promise<unknown>
  listMembers(caller: unknown): Promise<unknown[]>
  spawnTeammate(caller: unknown, request: Record<string, unknown>): Promise<unknown>
  sendMessage(caller: unknown, request: { to: string; text: string; [key: string]: unknown }): Promise<unknown>
  createTask(caller: unknown, request: Record<string, unknown>): Promise<unknown>
  getTask(caller: unknown, id: string): Promise<unknown>
  listTasks(caller: unknown): Promise<unknown[]>
  updateTask(caller: unknown, request: { id: string; patch: Record<string, unknown> }): Promise<unknown>
  waitForChange(caller: unknown, timeoutMs: number, signal: unknown): Promise<unknown>
  interrupt(caller: unknown, targetName: string): Promise<unknown>
}

export interface AgentTeamsFacade {
  membership(caller: unknown): Promise<unknown>
  tryMembership(caller: unknown): Promise<unknown>
  listMembers(caller: unknown): Promise<unknown[]>
  spawnTeammate(options: Record<string, unknown>, caller: unknown): Promise<unknown>
  sendMessage(input: { to: string; text: string; [key: string]: unknown }, caller: unknown): Promise<unknown>
  createTask(spec: Record<string, unknown>, caller: unknown): Promise<unknown>
  getTask(request: { id: string }, caller: unknown): Promise<unknown>
  listTasks(filter: Record<string, unknown> | undefined, caller: unknown): Promise<unknown[]>
  updateTask(request: { id: string; patch: Record<string, unknown> }, caller: unknown): Promise<unknown>
  waitForChange(filter: Record<string, unknown> | undefined, options: Record<string, unknown> | undefined, caller: unknown): Promise<unknown>
  interrupt(target: string, caller: unknown): Promise<unknown>
}

function requireCaller(caller: unknown): void {
  if (caller === undefined || caller === null) {
    throw new Error('dsh-bot: agentTeams 调用缺少 live 调用方 caller（原生安全模型：不合成权限凭据）')
  }
}

export function createAgentTeamsFacade(native: AgentTeamsService): AgentTeamsFacade {
  // 实测#9 根因：原生 TeamService 的签名是 caller 在第一位（listTasks(caller) 甚至
  // 不收 filter），此前门面按 (参数, caller) 顺序透传，filter 落进 caller 位 →
  // roster.membership(filter) 崩（TypeError: reading 'id'）。门面在内部统一重排；
  // caller 仍必须由外部显式提供，绝不合成。
  return {
    async membership(caller) {
      requireCaller(caller)
      return native.membership(caller)
    },
    async tryMembership(caller) {
      requireCaller(caller)
      return native.tryMembership(caller)
    },
    async listMembers(caller) {
      requireCaller(caller)
      return native.listMembers(caller)
    },
    async spawnTeammate(options, caller) {
      requireCaller(caller)
      return native.spawnTeammate(caller, options)
    },
    async sendMessage(input, caller) {
      requireCaller(caller)
      return native.sendMessage(caller, input)
    },
    async createTask(spec, caller) {
      requireCaller(caller)
      return native.createTask(caller, spec)
    },
    async getTask(request, caller) {
      requireCaller(caller)
      return native.getTask(caller, request.id)
    },
    async listTasks(filter, caller) {
      requireCaller(caller)
      const all = (await native.listTasks(caller)) as TeamLike[]
      if (filter === undefined) return all
      const entries = Object.entries(filter)
      return all.filter((t) => entries.every(([k, v]) => t[k] === v))
    },
    async updateTask(request, caller) {
      requireCaller(caller)
      return native.updateTask(caller, request)
    },
    async waitForChange(filter, options, caller) {
      requireCaller(caller)
      void filter
      const timeoutMs = typeof (options as { timeoutMs?: unknown } | undefined)?.timeoutMs === 'number'
        ? (options as { timeoutMs: number }).timeoutMs
        : 10_000
      return native.waitForChange(caller, timeoutMs, undefined)
    },
    async interrupt(target, caller) {
      requireCaller(caller)
      return native.interrupt(caller, target)
    },
  }
}

interface TeamLike { [key: string]: unknown }
