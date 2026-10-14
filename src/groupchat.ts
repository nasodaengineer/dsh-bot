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
import { routeTurn, judgeApprovalDenial, type JevJudge, type JevRouteMessage, type JevRouteMember, type AutoDecideService } from './jev.js'

/** 审批代答默认超时（A6：默认 10 分钟） */
export const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * 票 #16·审批三档：manual=现状（群内卡+人工，超时 fail-closed）；
 * limited=超时前 LIMITED_LEAD_MS 用 autoDecide 判一次，拒/不确定→自动 reject，允许→仍等人工；
 * full=收到审批即判一次，允许→直接代答 allowed-once，否则 reject，不等待。
 * autoDecide 不可用/超时/decode 失败 → 一律回退 manual 语义，绝不 fail-open。
 */
export type ApprovalTier = 'manual' | 'limited' | 'full'

/** limited 档在超时前多少毫秒做自动判定（票面示例：剩 60 秒时） */
export const APPROVAL_LIMITED_LEAD_MS = 60_000

export function normalizeApprovalTier(tier: unknown, warn?: (message: string) => void): ApprovalTier {
  if (tier === 'limited' || tier === 'full') return tier
  if (tier !== undefined && tier !== 'manual') {
    warn?.(`dsh-bot: 未知审批档位 '${String(tier)}'，按 manual 处理（fail-closed）`)
  }
  return 'manual'
}

/** 票 #16·审计记录：每次自动判定与人工代答都落 KV approvals 表 */
export interface ApprovalAuditRecord {
  readonly id: string
  readonly approvalId: string
  readonly groupId: string
  readonly toolName: string
  readonly summary?: string
  readonly tier: ApprovalTier
  readonly source: 'auto' | 'human'
  readonly judgment: 'allow' | 'deny' | 'uncertain' | 'unavailable'
  readonly outcome?: ApprovalOutcome
  /** 判定依据摘要 */
  readonly basis?: string
  readonly probabilities?: Record<string, number>
  readonly confidence?: number
  readonly at: string
}

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
  readonly status: 'pending' | 'answered'
  readonly createdAt: string
  /** full 档自动判定结果（卡片上展示）；undefined 表示未走自动判定 */
  readonly autoVerdict?: 'allowed' | 'rejected'
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
  /** 审批代答：登记待批卡，Promise 挂起直到人工应答或超时（A6，fail-closed）。
   *  票 #16：approvalTier=limited/full 时按档位接入 autoDecide 自动判定（不可用回退 manual 语义） */
  requestApproval(input: { groupId: string; toolName: string; summary?: string; timeoutMs?: number }): Promise<{ granted: boolean; outcome: ApprovalOutcome }>
  listPendingApprovals(groupId: string): PendingApproval[]
  /** 票 #16：待批卡 + full 档已自动判定的卡（群面板展示「已自动判定」结果） */
  listApprovalCards(groupId: string): PendingApproval[]
  answerApproval(id: string, outcome: ApprovalOutcome): Promise<void>
  /** 票 #16：审批审计记录（内存 + KV approvals 表双写；KV 失败降级内存） */
  listApprovalAudits(): ApprovalAuditRecord[]
}

interface Waiter {
  resolve(outcome: ApprovalOutcome): void
  timer?: ReturnType<typeof setTimeout>
}

export function createGroupChatRuntime(
  ctx: HostContext,
  opts: {
    store: IdentityStore
    judge?: JevJudge
    sessionId?: string
    ensureSession?: RootSessionCarrier
    /** 票 #16：审批档位，默认 manual */
    approvalTier?: ApprovalTier
    /** 票 #16：autoDecide 服务弱读（复用票 #14 模式：到齐前返回 undefined） */
    getAutoDecide?: () => AutoDecideService | undefined
  },
): GroupChatRuntime {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)
  const approvalTier = normalizeApprovalTier(opts.approvalTier, warn)
  const groups = new Map<string, GroupRecord>()
  const messages = new Map<string, GroupMessage[]>() // groupId → 有序消息
  const pending = new Map<string, PendingApproval>()
  const decidedCards = new Map<string, PendingApproval>() // full 档自动判定后的卡（保留展示）
  const audits: ApprovalAuditRecord[] = []
  const waiters = new Map<string, Waiter>()
  let seq = 0
  let approvalSeq = 0
  let auditSeq = 0
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

  /** 系统提示写群历史（票 #16：limited 档「自动建议：拒绝」等提示） */
  async function writeNotice(groupId: string, text: string): Promise<void> {
    seq += 1
    const notice: GroupMessage = { groupId, seq, from: 'system', text, at: new Date().toISOString() }
    const list = messages.get(groupId) ?? []
    list.push(notice)
    messages.set(groupId, list)
    try {
      await persistMessage(notice)
    } catch (error) {
      warn(`审批提示消息落 KV 失败：${String(error)}`)
    }
  }

  /** 票 #16：审计双写（内存必达 + KV 尽力），绝不抛错 */
  async function recordAudit(rec: Omit<ApprovalAuditRecord, 'id' | 'at'>): Promise<void> {
    auditSeq += 1
    const record: ApprovalAuditRecord = { id: `aud-${auditSeq}-${rec.approvalId}`, at: new Date().toISOString(), ...rec }
    audits.push(record)
    if (kvReady && kv !== undefined) {
      try {
        await kv.putRecord('approvals', record.id, record)
      } catch (error) {
        warn(`审批审计落 KV 失败（保留内存记录）：${String(error)}`)
      }
    }
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
      const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0 ? input.timeoutMs : APPROVAL_TIMEOUT_MS

      // 票 #16·full 档：收到审批即判一次。允许→直接代答 allowed-once（卡片保留展示）；
      // 拒绝/不确定→reject；autoDecide 不可用→回退人工等待（manual 语义，fail-closed）。
      if (approvalTier === 'full') {
        try {
          const j = await judgeApprovalDenial(opts.getAutoDecide, { toolName: input.toolName, summary: input.summary })
          if (j.judgment === 'allow') {
            await recordAudit({
              approvalId: card.id, groupId: card.groupId, toolName: card.toolName, summary: card.summary,
              tier: 'full', source: 'auto', judgment: 'allow', outcome: 'allowed-once', basis: j.basis,
              probabilities: j.probabilities, confidence: j.confidence,
            })
            decidedCards.set(card.id, { ...card, status: 'answered', autoVerdict: 'allowed' })
            return { granted: true, outcome: 'allowed-once' }
          }
          if (j.judgment === 'deny' || j.judgment === 'uncertain') {
            await recordAudit({
              approvalId: card.id, groupId: card.groupId, toolName: card.toolName, summary: card.summary,
              tier: 'full', source: 'auto', judgment: j.judgment, outcome: 'rejected', basis: j.basis,
              probabilities: j.probabilities, confidence: j.confidence,
            })
            decidedCards.set(card.id, { ...card, status: 'answered', autoVerdict: 'rejected' })
            return { granted: false, outcome: 'rejected' }
          }
          // unavailable：同样落审计（fail-closed 回退证据），但不代答
          await recordAudit({
            approvalId: card.id, groupId: card.groupId, toolName: card.toolName, summary: card.summary,
            tier: 'full', source: 'auto', judgment: 'unavailable', basis: j.basis,
            probabilities: j.probabilities, confidence: j.confidence,
          })
          warn(`full 档 autoDecide 不可用（${j.basis ?? '未知原因'}），审批 '${card.id}' 回退人工等待，不代答`)
        } catch (error) {
          warn(`full 档自动判定异常，审批 '${card.id}' 回退人工等待：${String(error)}`)
        }
      }

      // manual 路径（manual 档，或 limited/full 档自动判定不可用时的回退）：
      // 待批卡 + 人工应答 + 真超时 fail-closed。
      pending.set(card.id, card)
      return new Promise((resolve) => {
        let settled = false
        let autoTimer: ReturnType<typeof setTimeout> | undefined
        const settle = (outcome: ApprovalOutcome) => {
          if (settled) return
          settled = true
          pending.delete(card.id)
          if (waiters.get(card.id) === waiter) waiters.delete(card.id)
          if (waiter.timer !== undefined) clearTimeout(waiter.timer)
          if (autoTimer !== undefined) clearTimeout(autoTimer)
          resolve({ granted: isGranted(outcome), outcome })
        }
        const waiter: Waiter = { resolve: settle }
        // A6：真超时——超时 fail-closed 放行=false，并清掉待批卡与 Waiter
        waiter.timer = setTimeout(() => {
          if (waiters.get(card.id) !== waiter) return
          warn(`待批卡 '${card.id}' 超时（${timeoutMs}ms），fail-closed 不放行`)
          settle('unavailable')
        }, timeoutMs)
        waiters.set(card.id, waiter)
        // 票 #16·limited 档：超时前 APPROVAL_LIMITED_LEAD_MS 判一次。拒/不确定→直接 reject
        // （fail-closed 方向）；允许→仍等人工；判定不可用→什么都不做（manual 语义）。
        if (approvalTier === 'limited') {
          const leadAt = timeoutMs > APPROVAL_LIMITED_LEAD_MS
            ? timeoutMs - APPROVAL_LIMITED_LEAD_MS
            : Math.max(1, Math.floor(timeoutMs / 2))
          autoTimer = setTimeout(() => {
            if (waiters.get(card.id) !== waiter) return
            void (async () => {
              let j
              try {
                j = await judgeApprovalDenial(opts.getAutoDecide, { toolName: input.toolName, summary: input.summary })
              } catch (error) {
                warn(`limited 档自动判定异常，继续等人工：${String(error)}`)
                return
              }
              const auditBase = {
                approvalId: card.id, groupId: card.groupId, toolName: card.toolName, summary: card.summary,
                tier: 'limited' as const, source: 'auto' as const, probabilities: j.probabilities, confidence: j.confidence,
              }
              if (j.judgment === 'deny' || j.judgment === 'uncertain') {
                await recordAudit({ ...auditBase, judgment: j.judgment, outcome: 'rejected', basis: j.basis })
                await writeNotice(input.groupId, `审批自动建议：拒绝（${j.basis ?? 'fail-closed'}）——已自动驳回 '${input.toolName}'`)
                settle('rejected')
                return
              }
              // allow → 仍等人工（超时仍 fail-closed）；unavailable → manual 语义，均落审计
              await recordAudit({ ...auditBase, judgment: j.judgment, basis: j.basis })
            })()
          }, leadAt)
        }
      })
    },

    listPendingApprovals(groupId) {
      return [...pending.values()].filter((c) => c.groupId === groupId)
    },

    listApprovalCards(groupId) {
      return [
        [...pending.values()].filter((c) => c.groupId === groupId),
        [...decidedCards.values()].filter((c) => c.groupId === groupId),
      ].flat()
    },

    async answerApproval(id, outcome) {
      const waiter = waiters.get(id)
      if (waiter === undefined) throw new Error(`dsh-bot: 未知待批卡 '${id}'（已应答或不存在）`)
      const card = pending.get(id)
      // 票 #16：人工代答也落审计（source=human）
      try {
        await recordAudit({
          approvalId: id,
          groupId: card?.groupId ?? '',
          toolName: card?.toolName ?? '',
          summary: card?.summary,
          tier: approvalTier,
          source: 'human',
          judgment: isGranted(outcome) ? 'allow' : 'deny',
          outcome,
          basis: '人工应答',
        })
      } catch (error) {
        warn(`人工应答审计记录失败（不影响应答）：${String(error)}`)
      }
      waiter.resolve(outcome)
    },

    listApprovalAudits() {
      return [...audits]
    },
  }
}
