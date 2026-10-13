/**
 * 票 #8·Jev 决策客户端：TypeSafe System One HTTP API 的最小封装 + 群聊路由判定。
 *
 * 裁决（票 #7 裁决 2）：群聊投递决策「谁说话/要不要说话」用 Jev 做类型化路由——
 * choice 判定，候选 = 群成员 + 'none'（无人响应）。Jev 不可用/超时/返回未知选项
 * 一律走降级：responder='none' + degraded=true + reason，出提示文案，绝不挂死。
 *
 * API 形状（docs.typesafe.ai/api.md，2026-10 实读）：
 * POST https://api.typesafe.ai/v1/systemone
 *   Authorization: Bearer <key>；body { state, model: 'jev-latest', questions }
 *   → { answers: { [qid]: { type, choice, confidence, probabilities } } }
 */

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
