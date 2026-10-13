/**
 * 票 #8·任务板封装：原生 agentTeams 任务四件 + claim 的 DAG 守卫。
 *
 * 原生任务板自带 CAS revision 与 DAG 校验（research/ds-bot-architecture.md §5 建议 2），
 * 我们不自建任务存储；本模块补的是「依赖全 completed 才可 claim」的门面守卫：
 * canClaim(task, tasks) 是纯函数，claimTask 在守卫不过时拒绝并说明原因，
 * 不把请求发给原生 API。
 */
import type { AgentTeamsFacade } from './agent-teams.js'

export interface TeamTask {
  readonly id: string
  status?: string
  title?: string
  owner?: string
  claimedBy?: string
  dependsOn?: readonly string[]
  [key: string]: unknown
}

/** 纯函数守卫：task 的依赖（dependsOn）全部 status === 'completed' 才可 claim */
export function canClaim(task: TeamTask | undefined, tasks: readonly TeamTask[]): boolean {
  if (task === undefined) return false
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const deps = task.dependsOn ?? []
  return deps.every((depId) => byId.get(depId)?.status === 'completed')
}

/** 从 live caller 提取稳定标识（用于 claimedBy 审计），拿不到就用类型名 */
function callerLabel(caller: unknown): string {
  if (typeof caller === 'string') return caller
  if (typeof caller === 'object' && caller !== null) {
    const record = caller as Record<string, unknown>
    for (const key of ['name', 'id', 'agent', 'label']) {
      if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string
    }
    return 'live-caller'
  }
  return 'live-caller'
}

export interface TaskBoard {
  createTask(spec: Record<string, unknown>, caller: unknown): Promise<TeamTask>
  getTask(request: { id: string }, caller: unknown): Promise<TeamTask | undefined>
  listTasks(filter: Record<string, unknown> | undefined, caller: unknown): Promise<TeamTask[]>
  updateTask(request: { id: string; patch: Record<string, unknown> }, caller: unknown): Promise<TeamTask>
  /** DAG 守卫的 claim：依赖未全完成时返回 { ok:false, reason }，不发原生调用 */
  claimTask(id: string, caller: unknown): Promise<{ ok: boolean; reason?: string; task?: TeamTask }>
  waitForChange(filter: Record<string, unknown> | undefined, options: Record<string, unknown> | undefined, caller: unknown): Promise<unknown>
}

export function createTaskBoard(teams: AgentTeamsFacade): TaskBoard {
  return {
    async createTask(spec, caller) {
      return (await teams.createTask(spec, caller)) as TeamTask
    },
    async getTask(request, caller) {
      return (await teams.getTask(request, caller)) as TeamTask | undefined
    },
    async listTasks(filter, caller) {
      return (await teams.listTasks(filter, caller)) as TeamTask[]
    },
    async updateTask(request, caller) {
      return (await teams.updateTask(request, caller)) as TeamTask
    },
    async claimTask(id, caller) {
      const tasks = (await teams.listTasks(undefined, caller)) as TeamTask[]
      const task = tasks.find((t) => t.id === id)
      if (!canClaim(task, tasks)) {
        const pending = (task?.dependsOn ?? []).filter(
          (depId) => tasks.find((t) => t.id === depId)?.status !== 'completed',
        )
        return { ok: false, reason: `依赖未全部完成：${pending.join(', ') || '(未知任务)'}` }
      }
      const updated = (await teams.updateTask(
        { id, patch: { status: 'claimed', owner: callerLabel(caller), claimedBy: callerLabel(caller) } },
        caller,
      )) as TeamTask
      return { ok: true, task: updated }
    },
    async waitForChange(filter, options, caller) {
      return teams.waitForChange(filter, options, caller)
    },
  }
}
