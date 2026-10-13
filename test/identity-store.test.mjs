import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { createIdentityStore } from '../lib/identity.js'

const BOT = { id: 'bot-alice', name: 'Alice', title: '研究员', description: '负责调研', color: 'blue' }

test('身份存储：put/get/list 走 KV unit（表名 bots，单元名 dsh-bot）', async () => {
  const ctx = fakeContext()
  const store = await createIdentityStore(ctx)
  await store.put(BOT)
  assert.deepEqual(await store.get('bot-alice'), BOT)
  assert.deepEqual(await store.list(), [BOT])
  // B5/B10：全部模块打开同一张共享表清单（src/kv.ts 集中声明）
  assert.deepEqual(ctx.openedUnits[0], {
    name: 'dsh-bot',
    version: 1,
    tables: ['bots', 'selection', 'groups', 'messages', 'approvals', 'memory', 'memory_journal', 'memory_snapshots', 'templates'],
    hasGlobal: false,
  })
})

test('身份存储：remove 后 get 返回 undefined', async () => {
  const ctx = fakeContext()
  const store = await createIdentityStore(ctx)
  await store.put(BOT)
  await store.remove('bot-alice')
  assert.equal(await store.get('bot-alice'), undefined)
  assert.deepEqual(await store.list(), [])
})

test('身份存储：重启后从 KV 重新读出（loadAll 路径）', async () => {
  const ctx = fakeContext()
  const first = await createIdentityStore(ctx)
  await first.put(BOT)
  // 同一 fake 后端再开一次，模拟插件重启
  const second = await createIdentityStore(ctx)
  assert.deepEqual(await second.list(), [BOT])
})

test('身份存储：无 storage 服务时降级内存 + warn', async () => {
  const ctx = fakeContext({ storage: false })
  const store = await createIdentityStore(ctx)
  await store.put(BOT)
  assert.deepEqual(await store.list(), [BOT])
  assert.ok(ctx.warnings.some((w) => w.includes('storage')))
})
