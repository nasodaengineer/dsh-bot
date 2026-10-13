// 票 #6·Bot 工具 + MCP 接口切片
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'
import { assertMcpServerName, createMcpBridge, isValidMcpServerName, mcpToolName } from '../lib/bot-tools.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('bot_* 工具注册：十五个工具名、可注销', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  assert.ok(runtime.botTools, 'botTools 应已挂载')
  assert.deepEqual([...runtime.botTools.names].sort(), [
    'bot_memory_forget',
    'bot_memory_journal',
    'bot_memory_list',
    'bot_memory_read',
    'bot_memory_search',
    'bot_memory_write',
    'bot_roster_list',
    'bot_schedule_create',
    'bot_schedule_delete',
    'bot_schedule_list',
    'bot_schedule_pause',
    'bot_schedule_resume',
    'bot_template_export',
    'bot_template_import',
    'bot_template_list',
  ])
  runtime.botTools.dispose()
  assert.deepEqual([...runtime.botTools.names], [])
  assert.ok(ctx.calls.filter((c) => c.startsWith('tool dispose ')).length === 15)
})

test('bot_schedule_create：六形态之一（cron）转 schedule.create（root Session）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const tool = ctx.registeredTools.get('bot_schedule_create')
  const result = await tool.execute({ title: '日报', prompt: '写日报', cron: { expression: '0 9 * * 1-5', time_zone: 'Asia/Shanghai' } })
  assert.equal(result.id, 'sch-1')
  assert.ok(ctx.calls.some((c) => c === 'schedule create 日报 session=root-1'), `calls=${ctx.calls}`)
})

test('bot_schedule_create：0 个或多个定时形态 → 折叠为 {error}，不抛错也不调宿主', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const tool = ctx.registeredTools.get('bot_schedule_create')
  const noTiming = await tool.execute({ title: 'x', prompt: 'y' })
  assert.ok(noTiming.error.includes('六种定时形态'))
  const twoTimings = await tool.execute({ title: 'x', prompt: 'y', every_seconds: 60, daily: { time: '09:00', time_zone: 'UTC' } })
  assert.ok(twoTimings.error.includes('every_seconds + daily'))
  assert.equal(ctx.calls.filter((c) => c.startsWith('schedule create')).length, 0)
})

test('bot_schedule_delete / bot_schedule_list / bot_roster_list', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '测试人格' })
  const create = await ctx.registeredTools.get('bot_schedule_create').execute({ title: 't', prompt: 'p', after_seconds: 30 })
  const del = await ctx.registeredTools.get('bot_schedule_delete').execute({ id: create.id })
  assert.deepEqual(del, { deleted: true })
  const list = await ctx.registeredTools.get('bot_schedule_list').execute({})
  assert.deepEqual(list.schedules, [])
  const roster = await ctx.registeredTools.get('bot_roster_list').execute({})
  assert.deepEqual(roster.bots, [{ id: 'b1', name: '小助手', title: '助理', description: '测试人格' }])
})

test('bot_schedule_pause / bot_schedule_resume：暂停记请求+删宿主，恢复重建（A3）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '助理', description: '测试人格' })
  const create = await ctx.registeredTools.get('bot_schedule_create').execute({ title: '日报', prompt: '写日报', every_seconds: 60 })
  const pause = await ctx.registeredTools.get('bot_schedule_pause').execute({ id: create.id })
  assert.deepEqual(pause, { paused: true })
  assert.equal(ctx.schedules.length, 0, '宿主侧已删除')
  const resume = await ctx.registeredTools.get('bot_schedule_resume').execute({ id: create.id })
  assert.ok(resume.record, '恢复返回新 record')
  assert.notEqual(resume.record.id, create.id, 'record id 已变')
  assert.equal(ctx.schedules.length, 1)
  // 不可暂停：未知 id → 折叠为 {error}
  const badPause = await ctx.registeredTools.get('bot_schedule_pause').execute({ id: 'nope' })
  assert.ok(badPause.error.includes('不可暂停'))
  const badResume = await ctx.registeredTools.get('bot_schedule_resume').execute({ id: 'nope' })
  assert.ok(badResume.error.includes('不可恢复'))
  // schedule 未挂载降级
  const ctx2 = fakeContext({ disable: ['schedule'] })
  apply(ctx2, { rootSessionId: 'root-1' })
  await flush()
  const pausedOff = await ctx2.registeredTools.get('bot_schedule_pause').execute({ id: 'x' })
  assert.ok(pausedOff.error.includes('schedule 服务未挂载'))
})

test('schedule 未挂载（宿主没开 Automation）时工具降级为提示', async () => {
  const ctx = fakeContext({ disable: ['schedule'] })
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const result = await ctx.registeredTools.get('bot_schedule_create').execute({ title: 't', prompt: 'p', after_seconds: 5 })
  assert.ok(result.error.includes('schedule 服务未挂载'))
})

test('MCP 切片：server 名文法与公开工具名规则；connect 未接线返回 false', async () => {
  assert.ok(isValidMcpServerName('github'))
  assert.ok(!isValidMcpServerName('bad name'))
  assert.ok(!isValidMcpServerName(''))
  assert.throws(() => assertMcpServerName('不合法!'), /非法 MCP server 名/)
  assert.equal(mcpToolName('github', 'search_issues'), 'mcp__github__search_issues')
  const bridge = createMcpBridge([{ name: 'github', transport: 'http', url: 'https://example.test' }])
  assert.equal(bridge.configured.length, 1)
  assert.equal(await bridge.connect('github'), false, 'P2 才接线')
})
