// 票 #6·例程：六形态封装 + pause/resume/delete + sessionId 纪律（实测#4：执行期取 exec.agent.session.id）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('六形态：每种恰好转一个 timing 字段到 schedule.create（preferredSessionId 优先）', async () => {
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
    const record = await runtime.schedules.create('exec-session', req)
    assert.ok(record.id.startsWith('sch-'))
    assert.ok(ctx.calls.some((c) => c === `schedule create ${req.title} session=root-1`), `calls=${ctx.calls}`)
  }
  assert.equal(ctx.calls.filter((c) => c.startsWith('schedule create')).length, cases.length)
})

test('校验：0/2 个形态、空 title、>120 title、空 prompt 都拒绝且不触宿主', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await assert.rejects(() => runtime.schedules.create('s', { title: 't', prompt: 'p' }), /必须且只能给一种/)
  await assert.rejects(
    () => runtime.schedules.create('s', { title: 't', prompt: 'p', after_seconds: 1, at: '2026-01-01T00:00:00Z' }),
    /after_seconds \+ at/,
  )
  await assert.rejects(() => runtime.schedules.create('s', { title: '', prompt: 'p', after_seconds: 1 }), /1-120 字符/)
  await assert.rejects(() => runtime.schedules.create('s', { title: 'x'.repeat(121), prompt: 'p', after_seconds: 1 }), /1-120 字符/)
  await assert.rejects(() => runtime.schedules.create('s', { title: 't', prompt: ' ', after_seconds: 1 }), /prompt 不能为空/)
  assert.equal(ctx.calls.filter((c) => c.startsWith('schedule create')).length, 0)
})

test('pause → resume：宿主 delete 后按原请求重建（新 id）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const created = await runtime.schedules.create('s', { title: '日报', prompt: '写日报', cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' } })
  assert.equal(await runtime.schedules.pause('s', created.id), true)
  assert.ok(ctx.calls.includes(`schedule delete ${created.id}`))
  assert.equal(ctx.schedules.length, 0)
  // 未知 id：pause 返回 false
  assert.equal(await runtime.schedules.pause('s', 'nope'), false)

  const resumed = await runtime.schedules.resume('s', created.id)
  assert.ok(resumed)
  assert.equal(resumed.title, '日报')
  assert.notEqual(resumed.id, created.id, '重建后 id 会变')
  assert.equal(await runtime.schedules.resume('s', created.id), undefined, '重复 resume 返回 undefined')
})

test('delete：走宿主且移除本地登记', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const created = await runtime.schedules.create('s', { title: 't', prompt: 'p', every_seconds: 60 })
  assert.equal(await runtime.schedules.delete('s', created.id), true)
  assert.equal(ctx.schedules.length, 0)
  assert.equal(await runtime.schedules.list('s').then((l) => l.length), 0)
})

test('无 preferredSessionId 时用调用方 sessionId；都缺失则抛错', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx) // 未配置 rootSessionId → 现在也照常挂载
  await flush()
  assert.ok(runtime.schedules, 'schedules 始终挂载（sessionId 执行期取）')
  const created = await runtime.schedules.create('chat-7', { title: 't', prompt: 'p', every_seconds: 60 })
  assert.ok(created.id.startsWith('sch-'))
  assert.ok(ctx.calls.some((c) => c === 'schedule create t session=chat-7'), `calls=${ctx.calls}`)
  await assert.rejects(() => runtime.schedules.create('', { title: 't', prompt: 'p', every_seconds: 60 }), /无法确定目标 Session/)
})

test('attachBotSchedules 直接调用：缺 sessionId 的调用期抛错（subagent_session 纪律）', async () => {
  const { attachBotSchedules } = await import('../lib/schedules.js')
  const runtime = attachBotSchedules(fakeContext(), { schedule: {} })
  await assert.rejects(() => runtime.create('', { title: 't', prompt: 'p', every_seconds: 60 }), /无法确定目标 Session/)
})
