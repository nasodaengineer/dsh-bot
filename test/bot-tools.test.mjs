// 票 #6·Bot 工具 + MCP 接口切片
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'
import { assertMcpServerName, createMcpBridge, isValidMcpServerName, mcpToolName } from '../lib/bot-tools.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('bot_* 工具注册：二十四个工具名、可注销', async () => {  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  assert.ok(runtime.botTools, 'botTools 应已挂载')
  assert.deepEqual([...runtime.botTools.names].sort(), [
    'bot_group_answer',
    'bot_group_approvals',
    'bot_group_create',
    'bot_group_message',
    'bot_group_messages',
    'bot_memory_forget',
    'bot_memory_journal',
    'bot_memory_list',
    'bot_memory_read',
    'bot_memory_search',
    'bot_memory_write',
    'bot_roster_create',
    'bot_roster_list',
    'bot_roster_remove',
    'bot_schedule_create',
    'bot_schedule_delete',
    'bot_schedule_list',
    'bot_schedule_pause',
    'bot_schedule_resume',
    'bot_select',
    'bot_selected',
    'bot_template_export',
    'bot_template_import',
    'bot_template_list',
  ])
  runtime.botTools.dispose()
  assert.deepEqual([...runtime.botTools.names], [])
  assert.ok(ctx.calls.filter((c) => c.startsWith('tool dispose ')).length === 24)
})

test('实测回归：宿主强制 output 字段——每个注册定义都带 output.schema+render（dsh-tools index.d.ts:115）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  assert.ok(ctx.registeredTools.size === 24, `应注册 24 个工具，实际 ${ctx.registeredTools.size}`)
  for (const [name, tool] of ctx.registeredTools) {
    assert.ok(tool.output, `${name} 缺 output`)
    assert.ok(tool.output.schema !== undefined, `${name} output.schema 缺失`)
    const blocks = tool.output.render({}, { ok: true })
    assert.ok(Array.isArray(blocks) && blocks.length === 1, `${name} render 应返回单块`)
    assert.equal(blocks[0].type, 'text')
    assert.equal(blocks[0].text, '{"ok":true}')
  }
  runtime.botTools.dispose()
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

test('实测#5：bot_select 校验存在并调 selection.selectBot；bot_selected 返回当前选中', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await runtime.roster.create({ id: 'b1', name: '小助手', title: '', description: '' })
  const select = ctx.registeredTools.get('bot_select')
  const missing = await select.execute({ id: 'nope' })
  assert.ok(missing.error && missing.error.includes('not found'), `missing=${JSON.stringify(missing)}`)
  const ok = await select.execute({ id: 'b1' })
  assert.deepEqual(ok, { ok: true, selected: 'b1' })
  assert.equal(runtime.selection.selectedBotId(), 'b1')
  const selected = await ctx.registeredTools.get('bot_selected').execute({})
  assert.deepEqual(selected, { selected: 'b1' })
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

// ---- 实测#3：缺「创建/移除 Bot」工具面 ----

test('实测#3·bot_roster_create：创建进名册（id 自动生成、缺 name 折叠为 error）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const tool = ctx.registeredTools.get('bot_roster_create')
  const created = await tool.execute({ name: '实测小助手', title: '测试', description: '一句话人格' })
  assert.equal(created.ok, true)
  assert.ok(created.bot.id.startsWith('bot-'))
  const list = await ctx.registeredTools.get('bot_roster_list').execute({})
  assert.equal(list.bots.length, 1)
  assert.equal(list.bots[0].name, '实测小助手')
  const noName = await tool.execute({})
  assert.ok(noName.error.includes('name 必填'))
})

test('实测#3·bot_roster_remove：按 id 移除，名册为空', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const created = await ctx.registeredTools.get('bot_roster_create').execute({ name: '临时' })
  const removed = await ctx.registeredTools.get('bot_roster_remove').execute({ id: created.bot.id })
  assert.deepEqual(removed, { ok: true, id: created.bot.id })
  const list = await ctx.registeredTools.get('bot_roster_list').execute({})
  assert.deepEqual(list.bots, [])
  const bad = await ctx.registeredTools.get('bot_roster_remove').execute({})
  assert.ok(bad.error.includes('id 必填'))
})

test('实测#11·bot_group_create/message/messages：建群→发消息（Jev 路由+投递）→读历史', async () => {
  const ctx = fakeContext({
    services: {
      agentTeams: { async membership() { return { teamId: 'root' } } },
      sessionController: {
        async selectModel() { return {} },
        async prompt() { return { accepted: true } },
      },
    },
  })
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { type: 'choice', choice: 'bot-a', confidence: 0.8 } }) },
  })
  await flush()
  await ctx.registeredTools.get('bot_roster_create').execute({ name: 'bot-a', id: 'bot-a' })
  const created = await ctx.registeredTools.get('bot_group_create').execute({ name: '实测群', memberIds: ['bot-a'] })
  assert.ok(created.group.id, '应返回群记录')
  const missing = await ctx.registeredTools.get('bot_group_create').execute({ name: 'x' })
  assert.ok(missing.error.includes('memberIds'))
  const sent = await ctx.registeredTools.get('bot_group_message').execute({ groupId: created.group.id, text: '请报到' })
  assert.equal(sent.responder, 'bot-a')
  assert.equal(sent.degraded, undefined)
  const history = await ctx.registeredTools.get('bot_group_messages').execute({ groupId: created.group.id })
  assert.equal(history.messages.length, 1)
  assert.equal(history.messages[0].text, '请报到')
  const badText = await ctx.registeredTools.get('bot_group_message').execute({ groupId: created.group.id })
  assert.ok(badText.error.includes('必填'))
})

test('实测#11·bot_group_approvals/answer：待批卡列出、人工拒绝 fail-closed', async () => {
  const ctx = fakeContext({ services: { agentTeams: { async membership() { return { teamId: 'root' } } } } })
  const runtime = apply(ctx, { rootSessionId: 'root-session' })
  await flush()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const pendingPromise = runtime.groups.requestApproval({ groupId: group.id, toolName: 'pwsh', summary: '危险操作' })
  const cards = await ctx.registeredTools.get('bot_group_approvals').execute({ groupId: group.id })
  assert.equal(cards.pending.length, 1)
  assert.equal(cards.pending[0].toolName, 'pwsh')
  const answered = await ctx.registeredTools.get('bot_group_answer').execute({ approvalId: cards.pending[0].id, outcome: 'rejected' })
  assert.deepEqual(answered, { ok: true, approvalId: cards.pending[0].id, outcome: 'rejected' })
  const decided = await pendingPromise
  assert.equal(decided.granted, false)
  const bad = await ctx.registeredTools.get('bot_group_answer').execute({ approvalId: 'x', outcome: 'allow' })
  assert.ok(bad.error.includes('outcome'))
})
