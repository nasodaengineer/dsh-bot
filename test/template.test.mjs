// 票 #11·模板分发（人格+记忆+技能打包）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

async function setup() {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-session' })
  await flush()
  await runtime.roster.create({ id: 'bot-a', name: '阿布', title: '工程师', description: '负责构建与部署', color: 'blue' })
  await runtime.selection.selectBot('bot-a')
  // 记忆两条
  await runtime.memory.write('bot-a', { topic: '偏好', text: '回复一律中文' })
  await runtime.memory.write('bot-a', { topic: '构建', text: '构建用 pnpm' })
  return { ctx, runtime }
}

test('模板：exportTemplate 打包人格 + 记忆（带）+ 技能，落 KV templates 表', async () => {
  const { runtime } = await setup()
  const tpl = await runtime.templates.exportTemplate('bot-a', { includeMemory: true, name: '工程师模板' })
  assert.equal(tpl.name, '工程师模板')
  assert.equal(tpl.persona.name, '阿布')
  assert.equal(tpl.persona.title, '工程师')
  assert.equal(tpl.includeMemory, true)
  assert.equal(tpl.memory.length, 2, '记忆两条都要带')
  const list = await runtime.templates.list()
  assert.equal(list.length, 1)
})

test('模板：includeMemory=false 时不带记忆（验收：记忆按选择带或不带）', async () => {
  const { runtime } = await setup()
  const tpl = await runtime.templates.exportTemplate('bot-a', { includeMemory: false })
  assert.equal(tpl.includeMemory, false)
  assert.equal(tpl.memory.length, 0)
})

test('模板：importTemplate 派生新 Bot，人格在、记忆按模板还原', async () => {
  const { runtime } = await setup()
  const tpl = await runtime.templates.exportTemplate('bot-a', { includeMemory: true })
  const result = await runtime.templates.importTemplate(tpl.id, { name: '小布' })
  const bots = await runtime.roster.list()
  const derived = bots.find((b) => b.id === result.botId)
  assert.ok(derived, '新 Bot 已入名册')
  assert.equal(derived.name, '小布')
  assert.equal(derived.title, '工程师', '人格随模板')
  const memories = await runtime.memory.list(result.botId)
  assert.equal(memories.length, 2, '记忆随模板还原到新 Bot')
  assert.ok(memories.some((m) => m.text.includes('中文')))
})

test('模板：导入不带记忆的模板，新 Bot 无记忆', async () => {
  const { runtime } = await setup()
  const tpl = await runtime.templates.exportTemplate('bot-a', { includeMemory: false })
  const result = await runtime.templates.importTemplate(tpl.id, {})
  assert.equal((await runtime.memory.list(result.botId)).length, 0)
})

test('模板：技能随模板（例程标题清单在模板里），导入后例程重建', async () => {
  const { runtime } = await setup()
  const created = await runtime.schedules.create({ title: '日报', prompt: '写日报', every_seconds: 3600 })
  const tpl = await runtime.templates.exportTemplate('bot-a', { includeMemory: false })
  assert.deepEqual(tpl.skills.scheduleTitles, ['日报'], '例程技能打包进模板')
  const result = await runtime.templates.importTemplate(tpl.id, {})
  assert.ok(result.restoredSchedules >= 1, '导入时例程重建')
  const list = await runtime.schedules.list()
  assert.ok(list.some((s) => s.title === '日报'), '重建后例程存在')
  void created
})

test('模板：未知 Bot 导出、未知模板导入都报错不抛穿由工具层折叠', async () => {
  const { runtime } = await setup()
  await assert.rejects(() => runtime.templates.exportTemplate('nope', {}), /未知 Bot/)
  await assert.rejects(() => runtime.templates.importTemplate('nope', {}), /未知模板/)
})

test('模板：重启（同一 KV 后端重开）后模板还在', async () => {
  const { ctx, runtime } = await setup()
  const tpl = await runtime.templates.exportTemplate('bot-a', { includeMemory: true })
  // ctx 共享即 KV 后端共享；模板 store 重开
  const runtime2 = apply(ctx, { rootSessionId: 'root-session' })
  await flush()
  const list = await runtime2.templates.list()
  assert.ok(list.some((t) => t.id === tpl.id))
})

test('bot 工具：bot_template_export/import/list 三件注册且可用', async () => {
  const { ctx, runtime } = await setup()
  for (const name of ['bot_template_export', 'bot_template_import', 'bot_template_list']) {
    assert.ok(ctx.registeredTools.has(name), `缺工具 ${name}`)
  }
  const exported = await ctx.registeredTools.get('bot_template_export').execute({ botId: 'bot-a', includeMemory: false })
  assert.equal(exported.error, undefined)
  const imported = await ctx.registeredTools.get('bot_template_import').execute({ templateId: exported.template.id, name: '工具导入' })
  assert.ok(imported.botId)
  const listed = await ctx.registeredTools.get('bot_template_list').execute({})
  assert.ok(listed.templates.length >= 1)
})
