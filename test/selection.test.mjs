// 票 #6·P0 接缝：selectedId 落 KV、agent/created 人格注入、重启读回
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

test('agent/created：把选中 Bot 的人格注入新 Agent', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx)
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '认真负责' })
  await runtime.selection.selectBot('b1')

  const injected = []
  const agent = { inject: (message) => injected.push(message), session: { header: { cwd: 'C:\\tmp' } } }
  ctx.listeners.get('agent/created')[0]({ agent })
  await flush()
  assert.equal(injected.length, 1)
  assert.ok(injected[0].includes('小助手'))
  assert.ok(injected[0].includes('认真负责'))
})

test('agent/created：注入抛错被吞掉（只 warn），不影响宿主', () => {
  const ctx = fakeContext()
  apply(ctx)
  onAgentCreated(ctx, () => {
    throw new Error('boom')
  })
  ctx.listeners.get('agent/created').forEach((listener) => listener({ agent: undefined }))
  assert.ok(ctx.warnings.some((w) => w.includes('agent/created 注入失败')))
})
