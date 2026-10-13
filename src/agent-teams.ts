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

/** 原生 TeamService 切片：宽松透传，签名以运行时为准 */
export interface AgentTeamsService {
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
      return native.spawnTeammate(options, caller)
    },
    async sendMessage(input, caller) {
      requireCaller(caller)
      return native.sendMessage(input, caller)
    },
    async createTask(spec, caller) {
      requireCaller(caller)
      return native.createTask(spec, caller)
    },
    async getTask(request, caller) {
      requireCaller(caller)
      return native.getTask(request, caller)
    },
    async listTasks(filter, caller) {
      requireCaller(caller)
      return native.listTasks(filter, caller)
    },
    async updateTask(request, caller) {
      requireCaller(caller)
      return native.updateTask(request, caller)
    },
    async waitForChange(filter, options, caller) {
      requireCaller(caller)
      return native.waitForChange(filter, options, caller)
    },
    async interrupt(target, caller) {
      requireCaller(caller)
      return native.interrupt(target, caller)
    },
  }
}
