import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { createMemoryRepo } from '../lib/memory.js'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

// 组装带名册 + 记忆仓库的完整插件实例
async function setup() {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-session' })
  await flush()
  await runtime.roster.create({ id: 'bot-a', name: '阿布', title: '工程师', description: '负责构建' })
  return { ctx, runtime }
}

// ---- createMemoryRepo 的公开接口 ----

test('记忆：write 落 KV，read 按 topic 取回', async () => {
  const repo = await createMemoryRepo(fakeContext())
  const entry = await repo.write('bot-a', { topic: '部署偏好', text: '部署一律用 pnpm，不要用 npm' })
  assert.equal(entry.topic, '部署偏好')
  const list = await repo.read('bot-a', '部署偏好')
  assert.equal(list.length, 1)
  assert.match(list[0].text, /pnpm/)
})

test('记忆：Bot 重启（重新打开同一 KV unit）后仍记得偏好', async () => {
  // 两个 fakeContext 各自独立，所以这里手动共享同一个后端：先写后读
  const ctx = fakeContext()
  const repoA = await createMemoryRepo(ctx)
  await repoA.write('bot-a', { topic: '偏好', text: '永远回复中文' })
  // 同一 ctx（同一 KV 后端）再开一个仓库 = 重启后的新实例
  const repoB = await createMemoryRepo(ctx)
  const found = await repoB.read('bot-a', '偏好')
  assert.equal(found.length, 1)
  assert.match(found[0].text, /中文/)
})

test('记忆：单条体积上限（超限拒绝，不算静默截断）', async () => {
  const repo = await createMemoryRepo(fakeContext())
  await assert.rejects(
    () => repo.write('bot-a', { topic: '大', text: 'x'.repeat(9 * 1024) }),
    /体积/,
  )
})

test('记忆：search 关键词全命中才返回，按命中度排序', async () => {
  const repo = await createMemoryRepo(fakeContext())
  await repo.write('bot-a', { topic: '构建', text: '构建用 pnpm，测试用 node --test' })
  await repo.write('bot-a', { topic: '部署', text: '部署走 pnpm build，产物在 lib' })
  const hits = await repo.search('bot-a', 'pnpm 构建')
  assert.ok(hits.length >= 1)
  assert.match(hits[0].text, /构建用 pnpm/)
  const miss = await repo.search('bot-a', 'kubernetes')
  assert.equal(miss.length, 0)
})

test('记忆：indexText 输出 MEMORY.md 风格的索引（主题分组）', async () => {
  const repo = await createMemoryRepo(fakeContext())
  await repo.write('bot-a', { topic: '构建', text: '构建用 pnpm' })
  await repo.write('bot-a', { topic: '构建', text: '测试用 node --test' })
  const md = await repo.indexText('bot-a')
  assert.match(md, /# 记忆索引/)
  assert.match(md, /## 构建/)
})

test('记忆：journal 记录写/忘动作；forget 删除条目', async () => {
  const repo = await createMemoryRepo(fakeContext())
  const entry = await repo.write('bot-a', { topic: '临时', text: '过期信息' })
  await repo.forget('bot-a', '临时', entry.id)
  assert.equal((await repo.read('bot-a', '临时')).length, 0)
  const journal = await repo.journal('bot-a')
  const actions = journal.map((j) => j.action)
  assert.ok(actions.includes('write'))
  assert.ok(actions.includes('forget'))
})

test('记忆：snapshot 保存索引快照（摘要压缩接缝）', async () => {
  const repo = await createMemoryRepo(fakeContext())
  await repo.write('bot-a', { topic: '偏好', text: '回复中文' })
  const snap = await repo.snapshot('bot-a')
  assert.ok(snap.index.includes('回复中文'))
})

test('记忆：ctx.storage 缺失时降级进程内，不抛错', async () => {
  const repo = await createMemoryRepo(fakeContext({ storage: false }))
  await repo.write('bot-a', { topic: 't', text: '进程内记忆' })
  assert.equal((await repo.read('bot-a', 't')).length, 1)
})

// ---- bot_memory_* 工具 ----

test('bot 工具：注册 bot_memory_write/read/search/list/forget/journal 六件', async () => {
  const { ctx, runtime } = await setup()
  const names = runtime.botTools.names
  for (const name of ['bot_memory_write', 'bot_memory_read', 'bot_memory_search', 'bot_memory_list', 'bot_memory_forget', 'bot_memory_journal']) {
    assert.ok(names.includes(name), `缺工具 ${name}`)
  }
  assert.ok(ctx.registeredTools.has('bot_memory_write'))
})

test('bot 工具：bot_memory_write 以选中 Bot 身份写，bot_memory_search 能搜到', async () => {
  const { ctx, runtime } = await setup()
  await runtime.selection.selectBot('bot-a')
  const write = await ctx_execute(ctx, 'bot_memory_write', { topic: '偏好', text: '部署用 pnpm' })
  assert.equal(write.error, undefined)
  const hits = await ctx_execute(ctx, 'bot_memory_search', { query: 'pnpm' })
  assert.ok(Array.isArray(hits.entries) && hits.entries.length === 1)
  const listed = await ctx_execute(ctx, 'bot_memory_list', {})
  assert.equal(listed.entries.length, 1)
})

// 工具 execute 统一经 ctx.registeredTools 拿
async function ctx_execute(ctx, name, args) {
  const tool = ctx.registeredTools.get(name)
  assert.ok(tool, `工具 ${name} 未注册`)
  return tool.execute(args)
}
