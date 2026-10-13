// 修复轮 B5/B10：openKvUnit 共享 helper + 统一表清单
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { DSH_BOT_TABLES, DSH_BOT_UNIT_NAME, DSH_BOT_UNIT_VERSION, openKvUnit } from '../lib/kv.js'

test('B5·openKvUnit：打开统一 unit + 共享表清单', async () => {
  const ctx = fakeContext()
  const { kv, descriptor } = await openKvUnit(ctx)
  assert.ok(kv, 'storage 就绪时打开成功')
  assert.deepEqual(descriptor, {
    name: DSH_BOT_UNIT_NAME,
    version: DSH_BOT_UNIT_VERSION,
    tables: [...DSH_BOT_TABLES],
    hasGlobal: false,
  })
  assert.deepEqual(ctx.openedUnits[0], descriptor)
  // 打开可用：写读一条
  await kv.putRecord('bots', 'b1', { id: 'b1' })
  assert.equal((await kv.loadAll()).tables.bots.b1.id, 'b1')
})

test('B5·openKvUnit：无 storage 服务 → 降级（kv=undefined），不抛错', async () => {
  const ctx = fakeContext({ storage: false })
  const { kv } = await openKvUnit(ctx)
  assert.equal(kv, undefined)
})

test('B10·表清单集中：包含全部模块需要的表，单一来源', async () => {
  assert.ok(DSH_BOT_TABLES.includes('bots'))
  assert.ok(DSH_BOT_TABLES.includes('selection'))
  assert.ok(DSH_BOT_TABLES.includes('groups'))
  assert.ok(DSH_BOT_TABLES.includes('messages'))
  assert.ok(DSH_BOT_TABLES.includes('approvals'))
  assert.ok(DSH_BOT_TABLES.includes('memory'))
  assert.ok(DSH_BOT_TABLES.includes('memory_journal'))
  assert.ok(DSH_BOT_TABLES.includes('memory_snapshots'))
  assert.ok(DSH_BOT_TABLES.includes('templates'))
  assert.equal(new Set(DSH_BOT_TABLES).size, DSH_BOT_TABLES.length, '无重复表')
})
