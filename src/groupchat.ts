/**
 * 票 #8·群聊运行时（票 #7 裁决 1/3/4；修复轮 A2/A6/A8/B5/B10）。
 *
 * 骨架：群聊 = 隐藏 root Session + 宿主侧自建投递。群是我们数据模型里的实体
 * （KV unit 'dsh-bot' 的 groups/messages/approvals 三张表），Session 只是执行载体。
 * 不伪造工具调用、不在 llm/stream 上动手脚。
 *
 * A2·Session 载体：群记录的 sessionId 不再是 'group-root' 兜底字符串——由宿主侧
 * RootSessionCarrier 真实创建/复用一个隐藏 root Session（复用 schedules.ts 已验证的
 * 强制 root Session 手法：只接受装配方显式传入的 root sessionId）。首次建群时解析并
 * 缓存（复用）；解析失败 → warn 且群聊标记不可用（createGroup/postMessage 拒绝，
 * fail-visible，不假装在工作）。
 *
 * 投递：postMessage → Jev choice 路由（jev.ts）→ 命中成员则把消息投给隐藏 root
 * Session（deliverer 由宿主注入；默认只记日志）。Jev 不可用 → 降级提示写群历史，
 * 不投递、不挂死。
 *
 * A6·审批代答超时：requestApproval 挂 Waiter 并真正接 setTimeout（可配，默认
 * 10 分钟）；超时 fail-closed resolve { granted: false, outcome: 'unavailable' }
 * 并清掉待批卡与 Waiter。审批代答语义（GLOSSARY）：只有 'allowed-once' 算放行，
 * 判定统一复用 bot-approval.ts 的 isGranted。
 */
import type { ApprovalOutcome, HostContext } from './types.js'
import type { IdentityStore } from './identity.js'
import { isGranted } from './bot-approval.js'
import { openKvUnit } from './kv.js'
import { routeTurn, type JevJudge, type JevRouteMessage, type JevRouteMember } from './jev.js'

/** 审批代答默认超时（A6：默认 10 分钟） */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

export interface GroupRecord {
  readonly id: string
  readonly name: string
  readonly memberIds: readonly string[]
  readonly sessionId: string
  readonly createdAt: string
}

export interface GroupMessage {
  readonly groupId: string
  readonly seq: number
  readonly from: string
  readonly text: string
  readonly at: string
}

export interface PendingApproval {
  readonly id: string
  readonly groupId: string
  readonly toolName: string
  readonly summary?: string
  readonly status: 'pending'
  readonly createdAt: string
}

export interface ApprovalCard {
  readonly id: string
  readonly groupId: string
  readonly toolName: string
  readonly summary?: string
  readonly status: 'pending' | 'answered'
}

/** 宿主侧投递：把群消息转成对隐藏 root Session 的输入 */
export type GroupDeliverer = (
  groupId: string,
  delivery: { sessionId: string; responder: string; message: GroupMessage },
) => void

/**
 * A2·隐藏 root Session 载体：宿主侧创建/复用群聊执行 Session。
 * 与 schedules.ts 同款纪律——只复用装配方显式传入的 root sessionId，不接受子代理 Session。
 */
export interface RootSessionCarrier {
  ensure(): Promise<string | undefined>
}

export function createRootSessionCarrier(opts: { rootSessionId?: string }): RootSessionCarrier {
  let cached: string | undefined
  let resolved = false
  return {
    async ensure() {
      if (!resolved) {
        resolved = true
        const id = opts.rootSessionId
        if (typeof id === 'string' && id.trim() !== '') cached = id
      }
      return cached
    },
  }
}

export interface GroupChatRuntime {
  createGroup(input: { name: string; memberIds: readonly string[] }): Promise<GroupRecord>
  listGroups(): Promise<GroupRecord[]>
  history(groupId: string): Promise<GroupMessage[]>
  /** A2：隐藏 root Session 载体是否已解析可用（不可用时群聊功能拒绝，不假装在工作） */
  sessionReady(): boolean
  /** 宿主注入投递实现；未注入时投递降级为日志（不丢消息记录） */
  setDeliverer(deliverer: GroupDeliverer): void
  /** 一轮投递：路由 → 投递或降级；返回本轮判定 */
  postMessage(input: { groupId: string; from: string; text: string }): Promise<{
    responder: string
    confidence?: number
    degraded?: boolean
    reason?: string
    message: GroupMessage
  }>
  /** 审批代答：登记待批卡，Promise 挂起直到人工应答或超时（A6，fail-closed） */
  requestApproval(input: { groupId: string; toolName: string; summary?: string; timeoutMs?: number }): Promise<{ granted: boolean; outcome: ApprovalOutcome }>
  listPendingApprovals(groupId: string): PendingApproval[]
  answerApproval(id: string, outcome: ApprovalOutcome): Promise<void>
}

interface Waiter {
  resolve(outcome: ApprovalOutcome): void
  timer?: ReturnType<typeof setTimeout>
}

export function createGroupChatRuntime(
  ctx: HostContext,
  opts: { store: IdentityStore; judge?: JevJudge; sessionId?: string; ensureSession?: RootSessionCarrier },
): GroupChatRuntime {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  const groups = new Map<string, GroupRecord>()
  const messages = new Map<string, GroupMessage[]>() // groupId → 有序消息
  const pending = new Map<string, PendingApproval>()
  const waiters = new Map<string, Waiter>()
  let seq = 0
  let approvalSeq = 0
  let kvReady = false
  let kv: Awaited<ReturnType<typeof openKvUnit>>['kv'] | undefined
  let deliverer: GroupDeliverer | undefined

  // A2：隐藏 root Session 载体（运行时创建即解析并缓存，之后复用）
  let carrierSessionId: string | undefined
  let carrierResolved = false
  async function resolveSession(): Promise<string | undefined> {
    if (!carrierResolved) {
      carrierResolved = true
      try {
        carrierSessionId = (await opts.ensureSession?.ensure()) ?? opts.sessionId
      } catch (error) {
        warn(`群聊载体 Session 解析失败：${String(error)}`)
        carrierSessionId = undefined
      }
      if (carrierSessionId === undefined) {
        warn('群聊载体 Session 不可用（未配置 rootSessionId 且无创建路径），群聊功能拒绝服务，不假装在工作')
      }
    }
    return carrierSessionId
  }
  // 装配即解析（sessionReady 可同步观察），失败走上面的 warn 降级
  void resolveSession()

  void (async () => {
    const opened = await openKvUnit(ctx)
    if (opened.kv === undefined) {
      warn('群聊状态打开 KV unit 失败，降级为进程内存储，重启即丢')
      return
    }
    kv = opened.kv
    kvReady = true
    const snapshot = await kv.loadAll()
    for (const [key, value] of Object.entries(snapshot.tables['groups'] ?? {})) {
      groups.set(key, value as GroupRecord)
    }
    for (const [key, value] of Object.entries(snapshot.tables['messages'] ?? {})) {
      const msg = value as GroupMessage
      const list = messages.get(msg.groupId) ?? []
      list.push(msg)
      messages.set(msg.groupId, list)
    }
    for (const list of messages.values()) list.sort((a, b) => a.seq - b.seq)
    // 待批卡是易逝状态（进程重启后人工应答入口要重建），不恢复：fail-closed
  })()

  async function persistGroup(group: GroupRecord): Promise<void> {
    if (kvReady && kv !== undefined) await kv.putRecord('groups', group.id, group)
  }

  async function persistMessage(message: GroupMessage): Promise<void> {
    if (kvReady && kv !== undefined) await kv.putRecord('messages', `${message.groupId}:${message.seq}`, message)
  }

  return {
    async createGroup(input) {
      const sessionId = await resolveSession()
      if (sessionId === undefined) {
        throw new Error('dsh-bot: 群聊载体 Session 不可用，无法建群（fail-visible，不假装在工作）')
      }
      seq += 1
      const group: GroupRecord = {
        id: `grp-${Date.now().toString(36)}-${seq}`,
        name: input.name,
        memberIds: [...input.memberIds],
        sessionId,
        createdAt: new Date().toISOString(),
      }
      groups.set(group.id, group)
      await persistGroup(group)
      return group
    },

    async listGroups() {
      return [...groups.values()]
    },

    async history(groupId) {
      return [...(messages.get(groupId) ?? [])]
    },

    sessionReady() {
      return carrierResolved && carrierSessionId !== undefined
    },

    setDeliverer(fn) {
      deliverer = fn
    },

    async postMessage(input) {
      const group = groups.get(input.groupId)
      if (group === undefined) throw new Error(`dsh-bot: 未知群 '${input.groupId}'`)
      seq += 1
      const message: GroupMessage = {
        groupId: group.id,
        seq,
        from: input.from,
        text: input.text,
        at: new Date().toISOString(),
      }
      const list = messages.get(group.id) ?? []
      list.push(message)
      messages.set(group.id, list)
      await persistMessage(message)

      const members: JevRouteMember[] = group.memberIds.map((id) => ({ id }))
      const transcript: JevRouteMessage[] = list.slice(-12).map((m) => ({ from: m.from, text: m.text }))
      let result
      if (opts.judge === undefined) {
        result = { responder: 'none' as const, degraded: true as const, reason: '未配置 Jev 决策模型' }
      } else {
        result = await routeTurn({ members, transcript }, opts.judge)
      }
      if (result.responder === 'none') {
        seq += 1
        const notice: GroupMessage = {
          groupId: group.id,
          seq,
          from: 'system',
          text: result.degraded === true
            ? `（Jev 路由不可用，本轮无人响应：${result.reason ?? '未知原因'}）`
            : '（本轮无人响应）',
          at: new Date().toISOString(),
        }
        list.push(notice)
        await persistMessage(notice)
        return { responder: 'none', degraded: result.degraded, reason: result.reason, message }
      }
      const delivery = { sessionId: group.sessionId, responder: result.responder, message }
      if (deliverer === undefined) {
        warn(`群 '${group.name}' 未注入投递实现，本轮判定 ${result.responder} 只记录不投递`)
      } else {
        try {
          deliverer(group.id, delivery)
        } catch (error) {
          warn(`群投递失败：${String(error)}`)
        }
      }
      return { responder: result.responder, confidence: result.confidence, message }
    },

    async requestApproval(input) {
      approvalSeq += 1
      const card: PendingApproval = {
        id: `apr-${Date.now().toString(36)}-${approvalSeq}`,
        groupId: input.groupId,
        toolName: input.toolName,
        summary: input.summary,
        status: 'pending',
        createdAt: new Date().toISOString(),
      }
      pending.set(card.id, card)
      const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : APPROVAL_TIMEOUT_MS
      return new Promise((resolve) => {
        const settle = (outcome: ApprovalOutcome) => {
          pending.delete(card.id)
          resolve({ granted: isGranted(outcome), outcome })
        }
        const waiter: Waiter = { resolve: settle }
        // A6：真超时——超时 fail-closed 放行=false，并清掉待批卡与 Waiter
        waiter.timer = setTimeout(() => {
          if (waiters.get(card.id) !== waiter) return
          waiters.delete(card.id)
          warn(`待批卡 '${card.id}' 超时（${timeoutMs}ms），fail-closed 不放行`)
          settle('unavailable')
        }, timeoutMs)
        waiters.set(card.id, waiter)
      })
    },

    listPendingApprovals(groupId) {
      return [...pending.values()].filter((c) => c.groupId === groupId)
    },

    async answerApproval(id, outcome) {
      const waiter = waiters.get(id)
      if (waiter === undefined) throw new Error(`dsh-bot: 未知待批卡 '${id}'（已应答或不存在）`)
      waiters.delete(id)
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.resolve(outcome)
    },
  }
}
