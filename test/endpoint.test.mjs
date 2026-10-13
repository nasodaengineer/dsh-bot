// 票 #12·HTTP 端点触达（curl 能触发 Bot 运行）
// 注册路按票 #4 实测结论：connection.fetch.register 独占 /api + 会话 cookie；
// 沿 ds-bot 先例：单条精确路径 POST + body {endpoint, payload} 分发。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const judge = async () => ({ choice: 'a', probability: 0.9 })

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
