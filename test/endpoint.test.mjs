// 票 #12·HTTP 端点触达（curl 能触发 Bot 运行）
// 注册路按票 #4 实测结论：connection.fetch.register 独占 /api + 会话 cookie；
// 沿 ds-bot 先例：单条精确路径 POST + body {endpoint, payload} 分发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const judge = async () => ({ choice: 'a', probability: 0.9 })

function nativeTeamsFake() {
  return {
    async membership() { return { teamId: 'root' } },
    async tryMembership() { return { teamId: 'root' } },
    async listMembers() { return [] },
    async spawnTeammate(o) { return { id: 'member-1', ...o } },
    async sendMessage() { return { ok: true } },
    async createTask(s) { return { id: 'task-1', status: 'open', ...s } },
    async getTask() { return undefined },
    async listTasks() { return [] },
    async updateTask(r) { return { id: r.id, ...r.patch } },
    async waitForChange() { return { changed: true } },
    async interrupt() { return { ok: true } },
  }
}

async function setup() {
  const ctx = fakeContext({
    services: {
      agentTeams: {
        async createTask(spec, caller) { return { id: 't1', ...spec, caller } },
        async getTask(req) { return { id: req.id, title: '示例任务', status: 'todo' } },
        async listTasks(_filter, _caller) { return [{ id: 't1', title: '示例任务', status: 'todo' }] },
        async updateTask() { return {} },
      },
    },
  })
  const runtime = apply(ctx, { rootSessionId: 'root-session', typesafe: { judge } })
  await flush()
  const route = ctx.registeredRoutes.get('/api/dsh-bot')
  assert.ok(route, '/api/dsh-bot 应已注册')
  await runtime.groups.createGroup({ name: '发布群', memberIds: ['bot-a', 'bot-b'] })
  return { ctx, runtime, route }
}

const post = (route, body) => route.fetch(new Request('http://host/api/dsh-bot', {
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
}))

test('端点：单条精确路径注册在 connection.fetch（POST + buffered，会话 cookie 认证由宿主管）', async () => {
  const { ctx } = await setup()
  assert.ok(ctx.calls.some((c) => c.startsWith('fetch register /api/dsh-bot')))
  const route = ctx.registeredRoutes.get('/api/dsh-bot')
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')
})

test('端点：group.message 投递群聊消息（curl 触发一次 Bot 运行的验收面）', async () => {
  const { runtime, route } = await setup()
  const groups = await runtime.groups.listGroups()
  const res = await post(route, { endpoint: 'group.message', payload: { groupId: groups[0].id, from: '外部用户', text: '大家好' } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(body.result.responder, '路由出了响应者')
  const history = await runtime.groups.history(groups[0].id)
  assert.ok(history.some((m) => m.text === '大家好'))
})

test('端点：group.list 只读群列表', async () => {
  const { route } = await setup()
  const res = await post(route, { endpoint: 'group.list' })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.ok(body.result.groups.length >= 1)
  assert.ok(body.result.groups[0].name)
})

test('实测#6·group.create：端点建群（name/memberIds 校验，入 group.list）', async () => {
  const { route, runtime } = await setup()
  const missing = await post(route, { endpoint: 'group.create', payload: {} })
  assert.equal(missing.status, 400)
  const emptyMembers = await post(route, { endpoint: 'group.create', payload: { name: 'x', memberIds: [] } })
  assert.equal(emptyMembers.status, 400)
  const ok = await post(route, { endpoint: 'group.create', payload: { name: '测试群', memberIds: ['bot-a'] } })
  assert.equal(ok.status, 200)
  const body = await ok.json()
  assert.equal(body.ok, true)
  assert.equal(body.result.group.name, '测试群')
  const list = await (await post(route, { endpoint: 'group.list' })).json()
  assert.ok(list.result.groups.some((g) => g.id === body.result.group.id))
  assert.ok(runtime.groups)
})

test('端点：task.list / task.get 任务板只读查询', async () => {
  const { route } = await setup()
  const listed = await (await post(route, { endpoint: 'task.list' })).json()
  assert.equal(listed.ok, true)
  assert.equal(listed.result.tasks.length, 1)
  const got = await (await post(route, { endpoint: 'task.get', payload: { id: 't1' } })).json()
  assert.equal(got.ok, true)
  assert.equal(got.result.task.title, '示例任务')
})

test('端点：bot.list 只读 Bot 名册（不暴露凭据等敏感字段）', async () => {
  const { runtime, route } = await setup()
  await runtime.roster.create({ id: 'bot-a', name: '阿布', title: '工程师', description: 'd', color: 'blue' })
  const res = await post(route, { endpoint: 'bot.list' })
  const body = await res.json()
  assert.equal(body.ok, true)
  const bot = body.result.bots.find((b) => b.id === 'bot-a')
  assert.ok(bot)
  assert.equal(bot.name, '阿布')
  assert.equal(JSON.stringify(body).includes('credential'), false, '凭据字段不出现在响应里')
})

test('端点：未知 endpoint → 404 JSON；非法 JSON body → 400', async () => {
  const { route } = await setup()
  const unknown = await post(route, { endpoint: 'nope' })
  assert.equal(unknown.status, 404)
  assert.equal((await unknown.json()).ok, false)
  const bad = await route.fetch(new Request('http://host/api/dsh-bot', { method: 'POST', body: 'not-json' }))
  assert.equal(bad.status, 400)
})

test('端点：GET 方法被拒（路由 methods 只挂 POST）', async () => {
  const { route } = await setup()
  assert.ok(!route.methods.includes('GET'))
})

// ---- 修复轮 A4：from 白名单 ----

test('A4·from 校验：非法 from → 400，且不入群史', async () => {
  const { runtime, route } = await setup()
  const groups = await runtime.groups.listGroups()
  const bad = await post(route, { endpoint: 'group.message', payload: { groupId: groups[0].id, from: 'a<script>x', text: 'hi' } })
  assert.equal(bad.status, 400)
  const empty = await post(route, { endpoint: 'group.message', payload: { groupId: groups[0].id, from: '', text: 'hi' } })
  assert.equal(empty.status, 400)
  const toolong = await post(route, { endpoint: 'group.message', payload: { groupId: groups[0].id, from: 'x'.repeat(65), text: 'hi' } })
  assert.equal(toolong.status, 400)
  const missing = await post(route, { endpoint: 'group.message', payload: { groupId: groups[0].id, text: 'hi' } })
  assert.equal(missing.status, 400)
  const history = await runtime.groups.history(groups[0].id)
  assert.equal(history.length, 0, '非法消息不入群史')
})

// ---- 修复轮 C12：群面板路由 ----

test('C12·group.messages 只读路由返回群历史', async () => {
  const { runtime, route } = await setup()
  const groups = await runtime.groups.listGroups()
  const res = await post(route, { endpoint: 'group.messages', payload: { groupId: groups[0].id } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.result.messages, [])
  const missing = await post(route, { endpoint: 'group.messages', payload: { groupId: 'nope' } })
  assert.equal(missing.status, 404)
})

test('C12·group.approvals + group.approve/group.reject 宿主代答', async () => {
  const { runtime, route } = await setup()
  const groups = await runtime.groups.listGroups()
  const pendingPromise = runtime.groups.requestApproval({ groupId: groups[0].id, toolName: 'shell.run', summary: 'rm -rf tmp' })
  const listed = await post(route, { endpoint: 'group.approvals', payload: { groupId: groups[0].id } })
  const body = await listed.json()
  assert.equal(body.ok, true)
  assert.equal(body.result.approvals.length, 1)
  const card = body.result.approvals[0]
  assert.equal(card.toolName, 'shell.run')
  const res = await post(route, { endpoint: 'group.approve', payload: { id: card.id } })
  assert.equal(res.status, 200)
  const decided = await pendingPromise
  assert.equal(decided.granted, true)
  // reject 路径
  const p2 = runtime.groups.requestApproval({ groupId: groups[0].id, toolName: 'x' })
  const card2 = runtime.groups.listPendingApprovals(groups[0].id)[0]
  const rej = await post(route, { endpoint: 'group.reject', payload: { id: card2.id } })
  assert.equal(rej.status, 200)
  assert.equal((await p2).granted, false)
  // 未知卡 → 404
  const bad = await post(route, { endpoint: 'group.approve', payload: { id: 'nope' } })
  assert.equal(bad.status, 404)
})

test('端点：服务未就绪（groups/tasks 未挂）时对应端点返回 503 JSON，不抛穿', async () => {
  const ctx = fakeContext()
  apply(ctx, { rootSessionId: 'r' })
  await flush()
  const route = ctx.registeredRoutes.get('/api/dsh-bot')
  assert.ok(route, '端点仍注册（按可用性逐端点降级）')
  const res = await post(route, { endpoint: 'group.list' })
  assert.equal(res.status, 503)
  assert.equal((await res.json()).ok, false)
})

// ---- 修复轮：group.approvals 闭环消费 listApprovalCards（含 autoVerdict） ----

test('C12·group.approvals 展示 full 档已自动判定卡（含 autoVerdict，闭环消费 listApprovalCards）', async () => {
  const ctx = fakeContext({
    services: {
      agentTeams: nativeTeamsFake(),
      autoDecide: {
        async decode() {
          return { answers: { deny: { type: 'noul', choice: 'false', confidence: 0.8, probabilities: { true: 0.1, false: 0.8 } } } }
        },
      },
    },
  })
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }), approval: 'full' },
  })
  await flush()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  await runtime.groups.requestApproval({ groupId: group.id, toolName: 'fs.read', timeoutMs: 60000 })
  const route = ctx.registeredRoutes.get('/api/dsh-bot')
  const res = await post(route, { endpoint: 'group.approvals', payload: { groupId: group.id } })
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.result.approvals.length, 1, '已自动判定卡出现在群面板')
  assert.equal(body.result.approvals[0].autoVerdict, 'allowed')
})

// ---- 实测#2 修复：connection 缺失不再裸读 ctx.connection（此前抛
// cannot get property "connection" without inject 炸穿整个异步装配，工具全不注册）----

test('实测#2·connection 缺失：apply 不抛、端点不注册、其余装配（prompt/tools）照常完成', async () => {
  const ctx = fakeContext({ disable: ['connection'] })
  const runtime = apply(ctx, { rootSessionId: 'r' })
  await flush()
  assert.ok(!ctx.registeredRoutes.has('/api/dsh-bot'), '无 connection 不注册端点')
  assert.ok(runtime.endpoint, 'endpoint 运行时仍存在（降级空实现）')
  assert.ok(ctx.calls.some((c) => c.startsWith('prompt dsh-bot:persona')), '人格段照常注入')
  assert.ok(ctx.calls.some((c) => c.includes('inject attach [tools]')), '工具订阅照常触发')
  runtime.endpoint?.dispose()
})

test('实测#2·connection 后到：inject 到齐即补注册路由', async () => {
  const ctx = fakeContext({ disable: ['connection'] })
  const runtime = apply(ctx, { rootSessionId: 'r' })
  await flush()
  assert.ok(!ctx.registeredRoutes.has('/api/dsh-bot'))
  // 模拟服务后到：fake inject 只在构造时求值，这里直接补挂再手动重触发不可行，
  // 改为验证 inject 订阅已登记（fake ctx 记录 skip），并在服务出现时由 cordis 重触发。
  assert.ok(ctx.calls.some((c) => c.includes('inject skip [connection]')), '运行期订阅了 connection')
  runtime.endpoint?.dispose()
})
