import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRouteQuestion, createJevJudge, resolveJevBackend, routeTurn } from '../lib/jev.js'

const MEMBERS = [
  { id: 'bot-alice', name: 'Alice', description: '前端工程师' },
  { id: 'bot-bob', name: 'Bob', description: '后端工程师' },
]

test('jev：路由问题构造是 choice，候选含全部成员与 none', () => {
  const { state, questions } = buildRouteQuestion({
    members: MEMBERS,
    transcript: [
      { from: 'user', text: '帮我看看登录页的 bug' },
      { from: 'bot-alice', text: '我看看' },
    ],
  })
  assert.equal(questions.responder.type, 'choice')
  const criteria = questions.responder.criteria
  assert.ok('bot-alice' in criteria && 'bot-bob' in criteria, '每个成员都是一个选项')
  assert.ok('none' in criteria, '必须有「无人响应」选项')
  assert.ok(JSON.stringify(state).includes('登录页'), 'state 携带群消息文本')
  assert.ok(JSON.stringify(criteria['bot-alice']).includes('Alice'))
})

function fetchOk(answers) {
  return async (url, init) => {
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: 'jev-test', answers }),
    }
  }
}

test('jev：judge 走 HTTP API，返回 answers', async () => {
  const judge = createJevJudge({ apiKey: 'sk-test', fetchImpl: fetchOk({ responder: { type: 'choice', choice: 'bot-alice', confidence: 0.8, probabilities: { 'bot-alice': 0.8, none: 0.2 } } }) })
  const answers = await judge({ state: 'x', questions: {} })
  assert.equal(answers.responder.choice, 'bot-alice')
})

test('jev：routeTurn 选出响应者', async () => {
  const judge = async (req) => ({ responder: { type: 'choice', choice: 'bot-bob', confidence: 0.9 } })
  const result = await routeTurn({ members: MEMBERS, transcript: [] }, judge)
  assert.equal(result.responder, 'bot-bob')
  assert.equal(result.degraded, undefined)
})

test('jev：routeTurn 支持无人响应', async () => {
  const judge = async () => ({ responder: { type: 'choice', choice: 'none', confidence: 0.7 } })
  const result = await routeTurn({ members: MEMBERS, transcript: [] }, judge)
  assert.equal(result.responder, 'none')
})

test('jev：judge 抛错/超时 → 降级不挂死（degraded + 原因）', async () => {
  const boom = async () => { throw new Error('network down') }
  const result = await routeTurn({ members: MEMBERS, transcript: [] }, boom, { timeoutMs: 50 })
  assert.equal(result.responder, 'none')
  assert.equal(result.degraded, true)
  assert.ok(result.reason)
})

test('jev：judge 返回未知选项 → 当作降级处理', async () => {
  const weird = async () => ({ responder: { type: 'choice', choice: 'bot-ghost', confidence: 0.5 } })
  const result = await routeTurn({ members: MEMBERS, transcript: [] }, weird, { timeoutMs: 50 })
  assert.equal(result.degraded, true)
  assert.equal(result.responder, 'none')
})

// ---- 票 #14：决策层双后端（autoDecide 优先，builtin 兜底）----

function fakeAutoDecide(answers, hooks = {}) {
  return {
    decodeCalls: 0,
    async decode(request) {
      this.decodeCalls += 1
      hooks.onDecode?.(request)
      if (typeof answers === 'function') return answers(request)
      return { answers }
    },
  }
}

test('双后端：默认 autoDecide 优先，decode 结果透传为 judge answers', async () => {
  const auto = fakeAutoDecide({ responder: { type: 'choice', choice: 'bot-alice', confidence: 0.8, probabilities: { 'bot-alice': 0.8, none: 0.2 } } })
  let builtinCalls = 0
  const builtin = async () => { builtinCalls += 1; return {} }
  const judge = resolveJevBackend({ getAutoDecide: () => auto, builtin })
  const answers = await judge({ state: 's', questions: {} })
  assert.equal(answers.responder.choice, 'bot-alice')
  assert.equal(auto.decodeCalls, 1)
  assert.equal(builtinCalls, 0, 'autoDecide 可用时不得走 builtin')
})

test('双后端：autoDecide 服务缺失 → 降级 builtin', async () => {
  let builtinCalls = 0
  const builtin = async () => { builtinCalls += 1; return { responder: { choice: 'bot-bob', confidence: 0.9 } } }
  const judge = resolveJevBackend({ getAutoDecide: () => undefined, builtin })
  const answers = await judge({ state: 's', questions: {} })
  assert.equal(answers.responder.choice, 'bot-bob')
  assert.equal(builtinCalls, 1)
})

test('双后端：decode 抛错 → 降级 builtin + warn', async () => {
  const warnings = []
  const auto = fakeAutoDecide(async () => { throw new Error('decode boom') })
  const builtin = async () => ({ responder: { choice: 'none', confidence: 0.5 } })
  const judge = resolveJevBackend({ getAutoDecide: () => auto, builtin, warn: (m) => warnings.push(m) })
  const answers = await judge({ state: 's', questions: {} })
  assert.equal(answers.responder.choice, 'none')
  assert.equal(warnings.length, 1, '降级必须有 warn')
  assert.ok(warnings[0].includes('decode boom'))
})

test('双后端：decode 超时 → 降级 builtin', async () => {
  const auto = fakeAutoDecide(() => new Promise(() => {}))
  const builtin = async () => ({ responder: { choice: 'bot-alice', confidence: 0.6 } })
  const judge = resolveJevBackend({ getAutoDecide: () => auto, builtin, timeoutMs: 30 })
  const answers = await judge({ state: 's', questions: {} })
  assert.equal(answers.responder.choice, 'bot-alice')
})

test('双后端：decision=builtin 时直连 builtin，不碰 autoDecide', async () => {
  const auto = fakeAutoDecide({ responder: { type: 'choice', choice: 'bot-alice' } })
  const builtin = async () => ({ responder: { choice: 'bot-bob', confidence: 0.9 } })
  const judge = resolveJevBackend({ decision: 'builtin', getAutoDecide: () => auto, builtin })
  const answers = await judge({ state: 's', questions: {} })
  assert.equal(answers.responder.choice, 'bot-bob')
  assert.equal(auto.decodeCalls, 0)
})

test('双后端：autoDecide 与 builtin 双双缺失 → 抛错由 routeTurn 降级；完全无后端 → resolve 返回 undefined', async () => {
  const judge = resolveJevBackend({ getAutoDecide: () => undefined, builtin: undefined })
  await assert.rejects(() => judge({ state: 's', questions: {} }))
  assert.equal(resolveJevBackend({}), undefined)
})

test('双后端：routeTurn 端到端——autoDecide 抛错时整体仍降级不挂死', async () => {
  const auto = fakeAutoDecide(async () => { throw new Error('402 quota') })
  const judge = resolveJevBackend({ getAutoDecide: () => auto, builtin: undefined })
  const result = await routeTurn({ members: MEMBERS, transcript: [] }, judge)
  assert.equal(result.responder, 'none')
  assert.equal(result.degraded, true)
})
