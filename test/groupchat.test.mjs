import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

// 组装一个带群聊运行时的完整插件实例（mock agentTeams + jev judge）
async function setup({ judge } = {}) {
  const teamsCalls = []
  const nativeTeams = {
    async membership(c) { teamsCalls.push(['membership', c]); return { teamId: 'root' } },
    async tryMembership(c) { return { teamId: 'root' } },
    async listMembers(c) { return [] },
    async spawnTeammate(o, c) { teamsCalls.push(['spawnTeammate', o, c]); return { id: 'member-1', ...o } },
    async sendMessage(i, c) { teamsCalls.push(['sendMessage', i, c]); return { ok: true } },
    async createTask(s, c) { return { id: 'task-1', status: 'open', ...s } },
    async getTask(r, c) { return undefined },
    async listTasks(f, c) { teamsCalls.push(['listTasks', f, c]); return [] },
    async updateTask(r, c) { return { id: r.id, ...r.patch } },
    async waitForChange(f, o, c) { return { changed: true } },
    async interrupt(t, c) { return { ok: true } },
  }
  const ctx = fakeContext({ services: { agentTeams: nativeTeams } })
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: judge === undefined ? undefined : { judge },
  })
  await flush()
  return { ctx, runtime, nativeTeams }
}

test('群聊：建群落 KV，成员来自名册', async () => {
  const { runtime } = await setup()
  const group = await runtime.groups.createGroup({ name: '发布群', memberIds: ['bot-a', 'bot-b'] })
  assert.equal(group.name, '发布群')
  assert.deepEqual([...group.memberIds], ['bot-a', 'bot-b'])
  const all = await runtime.groups.listGroups()
  assert.equal(all.length, 1)
})

test('群聊：postMessage 记录消息并经 Jev 路由投递给隐藏 root Session', async () => {
  const delivered = []
  let judgeCalls = 0
  const judge = async () => { judgeCalls += 1; return { responder: { type: 'choice', choice: 'bot-b', confidence: 0.9 } } }
  const { runtime } = await setup({ judge })
  runtime.groups.setDeliverer((groupId, msg) => delivered.push([groupId, msg]))
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a', 'bot-b'] })
  const result = await runtime.groups.postMessage({ groupId: group.id, from: 'user', text: '查一下构建日志' })
  assert.equal(judgeCalls, 1)
  assert.equal(result.responder, 'bot-b')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0][0], group.id)
  assert.equal(delivered[0][1].responder, 'bot-b')
  assert.equal(delivered[0][1].sessionId, 'root-session', '投递目标是隐藏 root Session')
  const history = await runtime.groups.history(group.id)
  assert.equal(history.length, 1)
  assert.equal(history[0].text, '查一下构建日志')
})

test('群聊：Jev 不可用 → 降级提示，不投递、不挂死', async () => {
  const delivered = []
  const judge = async () => { throw new Error('jev down') }
  const { runtime } = await setup({ judge })
  runtime.groups.setDeliverer((groupId, msg) => delivered.push([groupId, msg]))
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const result = await runtime.groups.postMessage({ groupId: group.id, from: 'user', text: '在吗' })
  assert.equal(result.responder, 'none')
  assert.equal(result.degraded, true)
  assert.equal(delivered.length, 0, '降级轮不投递给 Session')
  const history = await runtime.groups.history(group.id)
  assert.ok(history.some((m) => m.from === 'system' && m.text.includes('无人响应')), '降级提示应写入群历史')
})

test('群聊：未配置 Jev（judge 缺失）→ 同样降级', async () => {
  const { runtime } = await setup()
  runtime.groups.setDeliverer(() => {})
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const result = await runtime.groups.postMessage({ groupId: group.id, from: 'user', text: 'hi' })
  assert.equal(result.degraded, true)
})

test('审批代答：群 Session 的 approval.request 变成待批卡，人工应答后才 resolve', async () => {
  const { runtime } = await setup()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const pendingPromise = runtime.groups.requestApproval({ groupId: group.id, toolName: 'shell.run', summary: 'rm -rf tmp' })
  const pending = runtime.groups.listPendingApprovals(group.id)
  assert.equal(pending.length, 1, '应有一条待批卡')
  assert.equal(pending[0].status, 'pending')
  await runtime.groups.answerApproval(pending[0].id, 'allowed-once')
  const decided = await pendingPromise
  assert.equal(decided.outcome, 'allowed-once')
  assert.equal(decided.granted, true)
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 0)
})

test('审批代答：reject 不放行（fail-closed）', async () => {
  const { runtime } = await setup()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const p1 = runtime.groups.requestApproval({ groupId: group.id, toolName: 'x' })
  const card1 = runtime.groups.listPendingApprovals(group.id)[0]
  await runtime.groups.answerApproval(card1.id, 'rejected')
  const rejected = await p1
  assert.equal(rejected.granted, false)
  assert.equal(rejected.outcome, 'rejected')
})

// ---- 修复轮 A2：隐藏 root Session 载体 ----

test('A2·载体：有 rootSessionId 时建群绑定隐藏 root Session，sessionReady 为真', async () => {
  const { runtime } = await setup()
  assert.equal(runtime.groups.sessionReady(), true)
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  assert.equal(group.sessionId, 'root-session', '群绑定真实隐藏 root Session，不是兜底字符串')
})

test('A2·载体：无法解析 Session → 建群 fail-visible 拒绝，群聊标记不可用', async () => {
  const ctx = fakeContext()
  const { createGroupChatRuntime, createRootSessionCarrier } = await import('../lib/groupchat.js')
  const store = await (await import('../lib/identity.js')).createIdentityStore(ctx)
  const groups = createGroupChatRuntime(ctx, {
    store,
    ensureSession: createRootSessionCarrier({}), // 无 rootSessionId → undefined
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(groups.sessionReady(), false)
  await assert.rejects(() => groups.createGroup({ name: 'g', memberIds: ['bot-a'] }), /载体 Session 不可用/)
  assert.ok(ctx.warnings.some((w) => w.includes('群聊载体 Session 不可用')), 'warn 降级可见')
})

test('A2·载体：carrier 复用同一 sessionId（ensure 幂等）', async () => {
  const { createRootSessionCarrier } = await import('../lib/groupchat.js')
  const carrier = createRootSessionCarrier({ rootSessionId: 'root-x' })
  assert.equal(await carrier.ensure(), 'root-x')
  assert.equal(await carrier.ensure(), 'root-x')
})

// ---- 修复轮 A6：审批真超时 ----

test('A6·审批超时：超时 fail-closed（granted=false）并清待批卡', async () => {
  const { runtime } = await setup()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const pendingPromise = runtime.groups.requestApproval({ groupId: group.id, toolName: 'slow.thing', timeoutMs: 30 })
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 1)
  const decided = await pendingPromise
  assert.equal(decided.granted, false, '超时不放行')
  assert.equal(decided.outcome, 'unavailable')
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 0, '待批卡已清')
  // 超时后再人工应答 → 未知卡报错（waiter 已清）
  await assert.rejects(() => runtime.groups.answerApproval('apr-timeout', 'allowed-once'), /未知待批卡/)
})
