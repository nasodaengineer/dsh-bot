/**
 * 票 #8·Jev 决策客户端：TypeSafe System One HTTP API 的最小封装 + 群聊路由判定。
 *
 * 裁决（票 #7 裁决 2）：群聊投递决策「谁说话/要不要说话」用 Jev 做类型化路由——
 * choice 判定，候选 = 群成员 + 'none'（无人响应）。Jev 不可用/超时/返回未知选项
 * 一律走降级：responder='none' + degraded=true + reason，出提示文案，绝不挂死。
 *
 * 票 #14 双后端：决策消费方优先走运行期注入的 'autoDecide' 服务（dsh-auto-decide，
 * 自带退避重试/402 熔断/缓存，单次 15s 超时）；服务不在/超时/decode 失败 → 自动
 * 降级 builtin（本文件的 TypeSafe HTTP 直连，TYPESAFE_API_KEY 凭据面归 builtin）。
 * settings：decision: 'autoDecide'（默认）| 'builtin'。
 *
 * builtin API 形状（docs.typesafe.ai/api.md，2026-10 实读）：
 * POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>；body { state, model: 'jev-latest', questions }
 *   → { answers: { [qid]: { type, choice, confidence, probabilities } } }
 */

/** 本地 interface 切片（不 import @deepseek-ai/*）：autoDecide 服务唯一入口 decode() */
export interface DecideAnswer {
  readonly type: 'choice' | 'score' | 'noul'
  readonly choice?: string
  readonly confidence?: number
  readonly probabilities?: Record<string, number>
}

export interface DecideOutcome {
  readonly answers: Record<string, DecideAnswer>
}

export interface AutoDecideService {
  /* 实测#12：my-auto-decide DecideRequest 的字段是 stateText（service.ts:61，state.requireExplicit
   * 默认开，要求显式传「要判定的原文」字符串）——不是早前切片猜的 state 对象 */
  decode(request: { state?: unknown; stateText?: string; questions: Record<string, unknown> }): Promise<DecideOutcome>
}

export type DecisionBackendMode = 'autoDecide' | 'builtin'

export interface JevRouteMessage {
  readonly from: string
  readonly text: string
}

export interface JevRouteMember {
  readonly id: string
  readonly name?: string
  readonly description?: string
}

export type JevJudge = (request: {
  state: unknown
  questions: Record<string, unknown>
  model?: string
}) => Promise<Record<string, { choice?: string; confidence?: number; [key: string]: unknown }>>

export interface JevJudgeOptions {
  readonly apiKey: string
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly fetchImpl?: typeof fetch
}

/**
 * 票 #14：builtin 后端 = 原有 TypeSafe HTTP 直连（凭据面：TYPESAFE_API_KEY 只在这条路径出现）。
 */
export function createJevJudge(options: JevJudgeOptions): JevJudge {
  const endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone'
  const timeoutMs = options.timeoutMs ?? 15_000
  const doFetch = options.fetchImpl ?? fetch
  return async (request) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          state: request.state,
          model: request.model ?? 'jev-latest',
          questions: request.questions,
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        throw new Error(`jev: HTTP ${response.status}`)
      }
      const body = (await response.json()) as { answers?: Record<string, unknown> }
      if (body.answers === undefined || typeof body.answers !== 'object') {
        throw new Error('jev: 响应缺少 answers')
      }
      return body.answers as Record<string, { choice?: string; confidence?: number }>
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 构造路由判定：choice 问「谁说话」，候选 = 全部成员 + none */
export function buildRouteQuestion(input: {
  members: readonly JevRouteMember[]
  transcript: readonly JevRouteMessage[]
}): { state: unknown; questions: Record<string, unknown> } {
  const criteria: Record<string, unknown> = { none: '本轮无人需要响应，保持沉默' }
  for (const member of input.members) {
    criteria[member.id] = `${member.name ?? member.id}${member.description ? `（${member.description}）` : ''} 应该回应这条消息`
  }
  return {
    state: {
      members: input.members.map((m) => ({ id: m.id, name: m.name, description: m.description })),
      transcript: input.transcript.slice(-12),
    },
    questions: {
      responder: {
        type: 'choice',
        instructions:
          '这是一段群聊。根据最近的对话，判断这一轮应该由谁说话：从成员中选择最合适的响应者；如果没有人需要回应（比如消息与所有人无关、对话已结束），选 none。只选一个人。',
        criteria,
      },
    },
  }
}

export interface RouteTurnResult {
  /** 'none' 表示无人响应（含降级） */
  readonly responder: string
  readonly confidence?: number
  readonly degraded?: boolean
  readonly reason?: string
}

/** 每轮投递决策：Jev 判定；不可用/超时/未知选项 → 降级，不挂死 */
export async function routeTurn(
  input: { members: readonly JevRouteMember[]; transcript: readonly JevRouteMessage[] },
  judge: JevJudge,
  options: { timeoutMs?: number } = {},
): Promise<RouteTurnResult> {
  if (input.members.length === 0) {
    return { responder: 'none', degraded: true, reason: '群内没有成员' }
  }
  const { state, questions } = buildRouteQuestion(input)
  let answer: { choice?: string; confidence?: number }
  try {
    const answers = await judge({ state, questions })
    answer = answers.responder ?? {}
  } catch (error) {
    return { responder: 'none', degraded: true, reason: `Jev 判定不可用：${String(error)}` }
  }
  const choice = answer.choice
  if (typeof choice !== 'string') {
    return { responder: 'none', degraded: true, reason: 'Jev 返回缺少 choice' }
  }
  if (choice === 'none') return { responder: 'none', confidence: answer.confidence }
  if (!input.members.some((m) => m.id === choice)) {
    return { responder: 'none', degraded: true, reason: `Jev 返回未知响应者 '${choice}'` }
  }
  return { responder: choice, confidence: answer.confidence }
}

// ==================== 票 #16：审批代答自动判定（fail-closed） ====================

export type ApprovalJudgment = 'allow' | 'deny' | 'uncertain' | 'unavailable'

export interface ApprovalJudgmentResult {
  readonly judgment: ApprovalJudgment
  /** 判定依据摘要（落审计用） */
  readonly basis?: string
  readonly confidence?: number
  readonly probabilities?: Record<string, number>
}

/**
 * 修复轮·共享超时模板：给任意 promise 挂保险超时，超时抛 `tag` 错误。
 * judgeApprovalDenial 与 resolveJevBackend 的 autoDecide 弱读共用（对方自带 15s 超时，
 * 这里只做本地保险，绝不挂死）。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, tag: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error(tag)))
    }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * 票 #16·审批自动判定：noul 题「是否应拒绝该审批」。
 * 只弱读 autoDecide 服务（复用票 #14 的弱读 + withTimeout 保险超时模式）——服务缺失/
 * decode 抛错/超时/应答缺失 → judgment='unavailable'，绝不降级 builtin，也绝不抛错。
 * 判读（修复轮 fail-closed 收紧）：只认 choice——'true'=应拒绝→deny；'false'=允许→allow；
 * choice 缺失（含概率再怎么倾向 false）一律 uncertain（消费方把 uncertain 当 deny，
 * fail-closed）。修复轮删除了旧的「p(false) 占优即 allow」概率兜底：概率不能代替
 * 服务给出的明确判定，缺 choice 说明应答不可解析，宁可拒也不放行。
 */
export async function judgeApprovalDenial(
  getAutoDecide: (() => AutoDecideService | undefined) | undefined,
  input: { toolName: string; summary?: string },
  options: { timeoutMs?: number } = {},
): Promise<ApprovalJudgmentResult> {
  const service = getAutoDecide?.()
  if (service === undefined) {
    return { judgment: 'unavailable', basis: 'autoDecide 服务不可用' }
  }
  const timeoutMs = options.timeoutMs ?? 15_000
  try {
    const outcome = await withTimeout(
      service.decode({
        // 实测#12：my-auto-decide 的字段是 stateText（state.requireExplicit 默认开，要求显式
        // 传「要判定的原文」字符串）。内置 TypeSafe 直连那条路仍用 state 对象。
        stateText: renderStateText({ toolName: input.toolName, summary: input.summary ?? '' }),
        questions: {
          deny: {
            type: 'noul',
            instructions:
              '这是一次工具调用审批请求。根据工具名与摘要判断：是否应当拒绝这次审批？危险、破坏性、超出常规操作范围或摘要可疑的应拒绝。',
            criteria: { true: '应当拒绝该审批', false: '不应当拒绝（可以允许）' },
          },
        },
      }),
      timeoutMs,
      'autoDecide decode 超时',
    )
    const answer = outcome?.answers?.deny
    if (answer === undefined || typeof answer !== 'object') {
      return { judgment: 'unavailable', basis: 'autoDecide 返回缺少 deny 应答' }
    }
    const probabilities = answer.probabilities
    const basis = `noul 判定 choice=${String(answer.choice)}`
    if (answer.choice === 'true') {
      return { judgment: 'deny', basis, confidence: answer.confidence, probabilities }
    }
    if (answer.choice === 'false') {
      return { judgment: 'allow', basis, confidence: answer.confidence, probabilities }
    }
    // choice 缺失一律 uncertain（fail-closed）：概率不作为放行依据（修复轮删除兜底）
    return { judgment: 'uncertain', basis: 'autoDecide 应答无法解析出明确判定', probabilities }
  } catch (error) {
    return { judgment: 'unavailable', basis: `autoDecide 判定失败：${String(error)}` }
  }
}

export interface JevBackendOptions {
  /** settings 决策后端：默认 'autoDecide'（优先），显式 'builtin' 直连 TypeSafe */
  readonly decision?: DecisionBackendMode
  /** 运行期弱读 autoDecide 服务（ctx.inject(['autoDecide']) 到齐前返回 undefined） */
  readonly getAutoDecide?: () => AutoDecideService | undefined
  /** builtin 兜底判定（TypeSafe 直连）；undefined 表示未配置凭据 */
  readonly builtin?: JevJudge
  /** autoDecide decode 兜底超时（对方自带 15s 超时，这里只做保险） */
  readonly timeoutMs?: number
  readonly warn?: (message: string) => void
}

// 修复轮：autoDecide 永不在时的「未注入」warn 是 once 语义（模块级标志，只 warn 一次，
// 避免每轮群聊路由都刷一条重复告警）。
let warnedAutoDecideMissing = false

/**
 * 实测#12：内置 state 对象 → autoDecide stateText 的渲染。群聊路由 state 是
 * {members, transcript}，审批判定 state 是 {toolName, summary}——用可读文本呈现，
 * 不依赖对方接受任意 JSON（my-auto-decide 要求「要判定的原文」字符串）。
 */
export function renderStateText(state: unknown): string {
  if (typeof state === 'string') return state
  if (state !== null && typeof state === 'object') {
    const rec = state as Record<string, unknown>
    if (typeof rec.toolName === 'string') {
      return `工具调用审批请求\n工具名：${rec.toolName}\n摘要：${typeof rec.summary === 'string' ? rec.summary : ''}`
    }
    const members = Array.isArray(rec.members) ? rec.members : []
    const transcript = Array.isArray(rec.transcript) ? rec.transcript : []
    const memberLines = members.map((m) => {
      const mm = m as Record<string, unknown>
      return `- ${String(mm.id)}${typeof mm.name === 'string' ? `（${mm.name}）` : ''}${typeof mm.description === 'string' ? `：${mm.description}` : ''}`
    })
    const lines = transcript.map((t) => {
      const tt = t as Record<string, unknown>
      return `${String(tt.from ?? '?')}: ${String(tt.text ?? '')}`
    })
    return `群聊成员：\n${memberLines.join('\n')}\n\n最近对话：\n${lines.join('\n')}`
  }
  return String(state)
}

/** 票 #14 双后端解析：默认 autoDecide 优先——服务在且 decode 成功则透传 DecideOutcome.answers
 * （choice/score/noul 题型原样透传，路由消费方只读 choice/confidence）；服务不在/decode 抛错/
 * 超时 → 自动降级 builtin。decision='builtin' 时跳过 autoDecide。两个后端都不可用时返回
 * undefined（由调用方走「未配置决策模型」降级文案），运行期双双缺失则抛错交给 routeTurn 降级。
 */
export function resolveJevBackend(options: JevBackendOptions): JevJudge | undefined {
  const builtin = options.builtin
  const warn = options.warn ?? (() => {})
  const timeoutMs = options.timeoutMs ?? 15_000
  if (options.decision === 'builtin') return builtin
  const hasAutoDecideHook = options.getAutoDecide !== undefined
  if (builtin === undefined && !hasAutoDecideHook) return undefined
  return async (request) => {
    const service = options.getAutoDecide?.()
    if (service !== undefined) {
      try {
        const outcome = await withTimeout(
          service.decode({
            // 实测#12：my-auto-decide 要求 stateText（要判定的原文字符串），不是内置直连的 state 对象
            stateText: renderStateText(request.state),
            questions: request.questions,
          }),
          timeoutMs,
          'autoDecide decode 超时',
        )
        if (outcome?.answers === undefined || typeof outcome.answers !== 'object') {
          throw new Error('autoDecide 返回缺少 answers')
        }
        return outcome.answers as Record<string, { choice?: string; confidence?: number }>
      } catch (error) {
        if (builtin === undefined) {
          // 实测#7：autoDecide 判定失败且无 builtin 兜底——干净降级，不报 "builtin is not a function"
          throw new Error(`autoDecide 判定不可用且未配置 builtin 兜底：${String(error)}`)
        }
        warn(`dsh-bot: autoDecide 不可用，降级 builtin：${String(error)}`)
      }
    } else if (builtin !== undefined) {
      if (!warnedAutoDecideMissing) {
        warnedAutoDecideMissing = true
        warn('dsh-bot: autoDecide 服务未注入，降级 builtin 直连')
      }
    } else {
      throw new Error('无可用决策后端（autoDecide 服务缺失且未配置 builtin）')
    }
    // 走到这里 builtin 必已配置（双双缺失在上方 else 已抛错），早返回 builtin 直连
    return builtin!(request)
  }
}
