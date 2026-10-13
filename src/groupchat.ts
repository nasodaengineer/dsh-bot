/**
 * 票 #8·群聊运行时（票 #7 裁决 1/3/4）。
 *
 * 骨架：群聊 = 隐藏 root Session + 宿主侧自建投递。群是我们数据模型里的实体
 * （KV unit 'dsh-bot' 的 groups/messages/approvals 三张表），Session 只是执行载体。
 * 不伪造工具调用、不在 llm/stream 上动手脚。
 *
 * 投递：postMessage → Jev choice 路由（jev.ts）→ 命中成员则把消息投给隐藏 root
 * Session（deliverer 由宿主注入；默认只记日志）。Jev 不可用 → 降级提示写群历史，
 * 不投递、不挂死。
 *
 * 审批代答：隐藏 Session 发起的 approval.request 永远等不到人（GLOSSARY·审批代答）。
 * requestApproval 把请求登记为待批卡并挂起 Promise；answerApproval 由群聊 UI 的
 * 人工应答触发后代答；在待批状态 Promise 不 resolve，fail-closed：只有
 * 'allowed-once' 算放行。
 */
import type { ApprovalOutcome, HostContext, KvUnit } from './types.js'
import type { IdentityStore } from './identity.js'
import { routeTurn, type JevJudge, type JevRouteMessage, type JevRouteMember } from './jev.js'

const BACKEND_NAME = 'json'
const UNIT_NAME = 'dsh-bot'
const UNIT_VERSION = 1
const TABLES = ['groups', 'messages', 'approvals'] as const

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

export interface GroupChatRuntime {
  createGroup(input: { name: string; memberIds: readonly string[] }): Promise<GroupRecord>
  listGroups(): Promise<GroupRecord[]>
  history(groupId: string): Promise<GroupMessage[]>
  /** 宿主注入投递实现；未注入时投递降级为日志（不丢消息记录） */
  setDeliverer(deliverer: GroupDeliverer): void
  /** 一轮投递：路由 → 投递或降级；返回本轮判定 */
  postMessage(input: { groupId: string; from: string; text: string }): Promise<{
    responder: string
    degraded?: boolean
    reason?: string
    message: GroupMessage
  }>
  /** 审批代答：登记待批卡，Promise 挂起直到人工应答 */
  requestApproval(input: { groupId: string; toolName: string; summary?: string }): Promise<{ granted: boolean; outcome: ApprovalOutcome }>
  listPendingApprovals(groupId: string): PendingApproval[]
  answerApproval(id: string, outcome: ApprovalOutcome): Promise<void>
}

async function openTables(ctx: HostContext): Promise<{ kv: KvUnit | undefined; degraded: boolean }> {
  try {
    const backend = ctx.storage?.backend
    if (backend === undefined) return { kv: undefined, degraded: true }
    const medium = backend.get(BACKEND_NAME) as { kv?: { open(d: unknown): Promise<KvUnit> } } | undefined
    const kv = medium?.kv
    if (kv === undefined) return { kv: undefined, degraded: true }
    return { kv: await kv.open({ name: UNIT_NAME, version: UNIT_VERSION, tables: [...TABLES], hasGlobal: false }), degraded: false }
  } catch {
    return { kv: undefined, degraded: true }
  }
}

interface Waiter {
  resolve(outcome: ApprovalOutcome): void
  timer?: ReturnType<typeof setTimeout>
}

export function createGroupChatRuntime(
  ctx: HostContext,
  opts: { store: IdentityStore; judge?: JevJudge; sessionId?: string },
): GroupChatRuntime {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  const groups = new Map<string, GroupRecord>()
  const messages = new Map<string, GroupMessage[]>() // groupId → 有序消息
  const pending = new Map<string, PendingApproval>()
  const waiters = new Map<string, Waiter>()
  let seq = 0
  let approvalSeq = 0
  let kv: KvUnit | undefined
  let kvReady = false
  let deliverer: GroupDeliverer | undefined

  void (async () => {
    const opened = await openTables(ctx)
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
      seq += 1
      const group: GroupRecord = {
        id: `grp-${Date.now().toString(36)}-${seq}`,
        name: input.name,
        memberIds: [...input.memberIds],
        sessionId: opts.sessionId ?? 'group-root',
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
      return new Promise((resolve) => {
        waiters.set(card.id, {
          resolve: (outcome) => {
            pending.delete(card.id)
            resolve({ granted: outcome === 'allowed-once', outcome })
          },
        })
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
