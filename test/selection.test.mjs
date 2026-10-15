// 票 #6·P0 接缝：selectedId 落 KV、agent/created 绑 preset、重启读回
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply, onAgentCreated } from '../lib/index.js'
import { createIdentityStore } from '../lib/identity.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('selectBot 持久化：同一 ctx 重开 store 读回；清除写 undefined', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx)
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '人格' })
  await runtime.selection.selectBot('b1')
  const store2 = await createIdentityStore(ctx)
  assert.equal(await store2.getSelectedId(), 'b1')
  assert.equal(await runtime.selection.selectedBotId(), 'b1')
  assert.equal((await runtime.selection.selectedBot())?.name, '小助手')
  await runtime.selection.selectBot(undefined)
  assert.equal(await (await createIdentityStore(ctx)).getSelectedId(), undefined)
})

test('agent/created：把选中 Bot 绑到它的 preset', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx)
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '认真负责' })
  await runtime.selection.selectBot('b1')

  // agentPresets.select 只接受尚未开始回合的会话（注册表 :351，lastTurn > 0 抛
  // agent-preset/locked），故 agent/created 赶在首个 turn 前绑定；fake-ctx 记调用而非抛错。
  const selected = []
  const agent = { session: { header: { cwd: 'C:\\tmp' } } }
  const roster = runtime.roster
  const originalSelect = roster.select.bind(roster)
  roster.select = async (agentArg, id) => {
    selected.push({ agent: agentArg, id })
    return originalSelect(agentArg, id)
  }
  ctx.listeners.get('agent/created')[0]({ agent })
  await flush()
  await flush()
  assert.equal(selected.length, 1)
  assert.equal(selected[0].id, 'b1')
  assert.equal(selected[0].agent, agent)
})

test('agent/created：未选中 Bot 时不绑 preset（不静默回退名册第一个）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx)
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '认真负责' })

  const selected = []
  const roster = runtime.roster
  roster.select = async (_agent, id) => { selected.push(id) }
  ctx.listeners.get('agent/created')[0]({ agent: { session: { header: { cwd: 'C:\\tmp' } } } })
  await flush()
  await flush()
  assert.equal(selected.length, 0)
})

test('agent/created：绑 preset 抛错被吞掉（只 warn），不影响宿主', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx)
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '认真负责' })
  await runtime.selection.selectBot('b1')
  const roster = runtime.roster
  roster.select = async () => { throw new Error('agent-preset/locked') }
  ctx.listeners.get('agent/created')[0]({ agent: { session: { header: { cwd: 'C:\\tmp' } } } })
  await flush()
  await flush()
  assert.ok(ctx.warnings.some((w) => w.includes('会话启动绑定 preset 失败')))
})

test('onAgentCreated：handler 抛错被吞掉（只 warn），不影响宿主', () => {
  const ctx = fakeContext()
  apply(ctx)
  onAgentCreated(ctx, () => {
    throw new Error('boom')
  })
  ctx.listeners.get('agent/created').forEach((listener) => listener({ agent: undefined }))
  assert.ok(ctx.warnings.some((w) => w.includes('agent/created 注入失败')))
})
