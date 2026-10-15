/**
 * 票 #6·例程：ctx.schedule.create 六形态封装 + 最小 pause/resume/delete API。
 *
 * 签名来源（0.2.1-alpha.2，dsh-schedule index.d.ts:69 + lib/types/types.d.ts）：
 * create(sessionId, request, signal?): Promise<ScheduleRecord>。
 * 纪律：sessionId 必须是 root Session——宿主对子代理 Session 拒绝（错误码
 * subagent_session），本插件只接受装配方显式传入的 root sessionId。
 * pause 语义：宿主 schedule 无暂停原语，这里用「记住请求 + delete，resume 时重建」，
 * 重建后的 record id 会变（诚实告知调用方）。
 */
import type { HostContext, ScheduleCreateRequest, ScheduleRecord, ScheduleService } from './types.js'

export interface BotSchedulesRuntime {
  create(sessionId: string, request: ScheduleCreateRequest): Promise<ScheduleRecord>
  list(sessionId: string): Promise<readonly ScheduleRecord[]>
  /** 暂停 = 记住请求并从宿主删除；返回是否确实暂停了一个已知例程 */
  pause(sessionId: string, id: string): Promise<boolean>
  /** 恢复 = 按记住的请求重建（新 id） */
  resume(sessionId: string, id: string): Promise<ScheduleRecord | undefined>
  delete(sessionId: string, id: string): Promise<boolean>
  /** 完整创建请求（修复轮 C11：模板导出要序列化完整 timing+prompt，不只是标题） */
  requests(): readonly ScheduleCreateRequest[]
}

const TIMING_FIELDS = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'] as const

export function attachBotSchedules(
  ctx: HostContext,
  opts: {
    schedule: ScheduleService | (() => ScheduleService | undefined)
    /** 实测#4：sessionId 执行期从工具 exec.agent.session.id 取（宿主工具同款）；装配方
     * 显式传入时优先。必须是非空 root/用户会话——子代理 Session 会被宿主以
     * subagent_session 拒绝。 */
    preferredSessionId?: string
  },
): BotSchedulesRuntime {
  const resolveSessionId = (sessionId: string | undefined): string => {
    const id = typeof opts.preferredSessionId === 'string' && opts.preferredSessionId.trim() !== ''
      ? opts.preferredSessionId
      : sessionId
    if (typeof id !== 'string' || id.trim() === '') {
      throw new Error('dsh-bot: 无法确定目标 Session（exec.agent.session.id 缺失且未配置 rootSessionId）')
    }
    return id
  }
  // 实测#4：宿主后端 ctx 上没有名为 'schedule' 的 cordis Service（dsh-tool-schedule
  // 也是直接弱读 ctx.schedule，见其 index.js:539），inject(['schedule']) 永远等不到。
  // 改为调用时惰性弱读：宿主挂了就能用，没挂走统一的未挂载错误。
  const resolveSchedule = (): ScheduleService | undefined =>
    typeof opts.schedule === 'function' ? opts.schedule() : opts.schedule
  const requireSchedule = (): ScheduleService => {
    const schedule = resolveSchedule()
    if (schedule === undefined) {
      throw new Error('dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）')
    }
    return schedule
  }
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)

  // 已知例程：id -> 请求（供 pause/resume）；宿主没有 list 全量保证，这里只管自己建的
  const known = new Map<string, ScheduleCreateRequest>()
  const paused = new Map<string, ScheduleCreateRequest>()
  let counter = 0

  function validate(request: ScheduleCreateRequest): void {
    if (typeof request.title !== 'string' || request.title.trim() === '' || request.title.length > 120) {
      throw new Error('dsh-bot: 例程 title 必须为 1-120 字符')
    }
    if (typeof request.prompt !== 'string' || request.prompt.trim() === '') {
      throw new Error('dsh-bot: 例程 prompt 不能为空')
    }
    const present = TIMING_FIELDS.filter((field) => (request as unknown as Record<string, unknown>)[field] !== undefined)
    if (present.length !== 1) {
      throw new Error(`dsh-bot: 六种定时形态必须且只能给一种（当前：${present.length === 0 ? '未给' : present.join(' + ')}）`)
    }
  }

  return {
    async create(sessionId, request) {
      const sid = resolveSessionId(sessionId)
      validate(request)
      const record = await requireSchedule().create(sid, request)
      known.set(record.id, request)
      return record
    },

    async list(sessionId) {
      try {
        return await requireSchedule().list({ sessionId: resolveSessionId(sessionId) })
      } catch (error) {
        warn(`列例程失败：${String(error)}`)
        return []
      }
    },

    async pause(sessionId, id) {
      const schedule = requireSchedule()
      const request = known.get(id)
      if (request === undefined) return false
      const deleted = await schedule.delete({ sessionId: resolveSessionId(sessionId), id })
      if (!deleted) return false
      known.delete(id)
      paused.set(id, request)
      return true
    },

    async resume(sessionId, id) {
      const schedule = requireSchedule()
      const request = paused.get(id)
      if (request === undefined) return undefined
      const record = await schedule.create(resolveSessionId(sessionId), request)
      paused.delete(id)
      known.set(record.id, request)
      return record
    },

    async delete(sessionId, id) {
      const schedule = requireSchedule()
      const existed = known.delete(id)
      paused.delete(id)
      return (await schedule.delete({ sessionId: resolveSessionId(sessionId), id })) || existed
    },

    requests() {
      return [...known.values()]
    },
  }
}
