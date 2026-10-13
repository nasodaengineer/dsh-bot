// 票 #6·例程：六形态封装 + pause/resume/delete + root Session 纪律
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('六形态：每种恰好转一个 timing 字段到 schedule.create（root Session）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()

  const cases = [
    [{ title: 't1', prompt: 'p', after_seconds: 30 }, 'after_seconds'],
    [{ title: 't2', prompt: 'p', at: '2026-11-01T09:00:00+08:00' }, 'at'],
    [{ title: 't3', prompt: 'p', every_seconds: 3600 }, 'every_seconds'],
    [{ title: 't4', prompt: 'p', daily: { time: '09:00', time_zone: 'Asia/Shanghai' } }, 'daily'],
    [{ title: 't5', prompt: 'p', weekly: { time: '09:00', time_zone: 'UTC', weekdays: [1, 3, 5] } }, 'weekly'],
    [{ title: 't6', prompt: 'p', cron: { expression: '*/5 * * * *', time_zone: 'UTC' } }, 'cron'],
  ]
  for (const [req] of cases) {
    const record = await runtime.schedules.create(req)
    assert.ok(record.id.startsWith('sch-'))
    assert.ok(ctx.calls.some((c) => c === `schedule create ${req.title} session=root-1`), `calls=${ctx.calls}`)
  }
  assert.equal(ctx.calls.filter((c) => c.startsWith('schedule create')).length, cases.length)
})

test('校验：0/2 个形态、空 title、>120 title、空 prompt 都拒绝且不触宿主', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await assert.rejects(() => runtime.schedules.create({ title: 't', prompt: 'p' }), /必须且只能给一种/)
  await assert.rejects(
    () => runtime.schedules.create({ title: 't', prompt: 'p', after_seconds: 1, at: '2026-01-01T00:00:00Z' }),
    /after_seconds \+ at/,
  )
  await assert.rejects(() => runtime.schedules.create({ title: '', prompt: 'p', after_seconds: 1 }), /1-120 字符/)
  await assert.rejects(() => runtime.schedules.create({ title: 'x'.repeat(121), prompt: 'p', after_seconds: 1 }), /1-120 字符/)
  await assert.rejects(() => runtime.schedules.create({ title: 't', prompt: ' ', after_seconds: 1 }), /prompt 不能为空/)
  assert.equal(ctx.calls.filter((c) => c.startsWith('schedule create')).length, 0)
})

test('pause → resume：宿主 delete 后按原请求重建（新 id）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const created = await runtime.schedules.create({ title: '日报', prompt: '写日报', cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' } })
  assert.equal(await runtime.schedules.pause(created.id), true)
  assert.ok(ctx.calls.includes(`schedule delete ${created.id}`))
  assert.equal(ctx.schedules.length, 0)
  // 未知 id：pause 返回 false
  assert.equal(await runtime.schedules.pause('nope'), false)

  const resumed = await runtime.schedules.resume(created.id)
  assert.ok(resumed)
  assert.equal(resumed.title, '日报')
  assert.notEqual(resumed.id, created.id, '重建后 id 会变')
  assert.equal(await runtime.schedules.resume(created.id), undefined, '重复 resume 返回 undefined')
})

test('delete：走宿主且移除本地登记', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const created = await runtime.schedules.create({ title: 't', prompt: 'p', every_seconds: 60 })
  assert.equal(await runtime.schedules.delete(created.id), true)
  assert.equal(ctx.schedules.length, 0)
  assert.equal(await runtime.schedules.list().then((l) => l.length), 0)
})

test('rootSessionId 缺失：schedule inject 跳过挂载并 warn（例程必须绑 root Session）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx) // 未给 rootSessionId
  await flush()
  assert.equal(runtime.schedules, undefined)
  assert.ok(ctx.warnings.some((w) => w.includes('rootSessionId')), `warnings=${ctx.warnings}`)
})

test('attachBotSchedules 直接调用时空 sessionId 抛错（subagent_session 纪律）', async () => {
  const { attachBotSchedules } = await import('../lib/schedules.js')
  assert.throws(() => attachBotSchedules(fakeContext(), { schedule: {}, rootSessionId: '  ' }), /root Session/)
})
