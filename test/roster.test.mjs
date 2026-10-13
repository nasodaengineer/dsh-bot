import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { createRoster } from '../lib/roster.js'
import { createIdentityStore } from '../lib/identity.js'

async function setup() {
  const ctx = fakeContext()
  const store = await createIdentityStore(ctx)
  const roster = await createRoster(ctx, store)
  return { ctx, store, roster }
}

const BOT = { id: 'bot-alice', name: 'Alice', title: '研究员', description: '负责调研' }

test('名册：create 落 KV 并向 agentPresets 注册（plugins 为空数组）', async (t) => {
  const { ctx, store, roster } = await setup()
  await roster.create(BOT)
  assert.deepEqual(await store.get('bot-alice'), BOT)
  assert.ok(ctx.presets.has('dsh-bot:bot-alice'), '应注册 preset，id 带插件前缀')
  assert.deepEqual(ctx.presets.get('dsh-bot:bot-alice').plugins, [])
  assert.equal(ctx.presets.get('dsh-bot:bot-alice').name, 'Alice')
})

test('名册：list 返回自有身份', async (t) => {
  const { roster } = await setup()
  await roster.create(BOT)
  assert.deepEqual(await roster.list(), [BOT])
})

test('名册：remove 注销 preset 并删除 KV 记录', async (t) => {
  const { ctx, store, roster } = await setup()
  await roster.create(BOT)
  await roster.remove('bot-alice')
  assert.ok(!ctx.presets.has('dsh-bot:bot-alice'))
  assert.equal(await store.get('bot-alice'), undefined)
})

test('名册：mount/select 透传到 agentPresets（bot id 映射为 dsh-bot:<id> preset id）', async (t) => {
  const { ctx, roster } = await setup()
  await roster.create(BOT)
  await roster.mount({}, 'bot-alice')
  await roster.select({}, 'bot-alice')
  assert.ok(ctx.calls.includes('preset mount dsh-bot:bot-alice'))
  assert.ok(ctx.calls.includes('preset select dsh-bot:bot-alice'))
})

test('名册：agentPresets 缺失时降级内存名册 + warn', async (t) => {
  const ctx = fakeContext()
  delete ctx.agentPresets
  const store = await createIdentityStore(ctx)
  const roster = await createRoster(ctx, store)
  await roster.create(BOT)
  assert.deepEqual(await roster.list(), [BOT])
  assert.ok(ctx.warnings.some((w) => w.includes('agentPresets')))
})
