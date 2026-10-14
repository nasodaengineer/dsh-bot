import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './fake-ctx.mjs'
import { createMemoryRepo, MAX_ENTRIES_PER_BOT } from '../lib/memory.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

// 填满一个 Bot 的记忆到上限
async function fill(repo, botId, n = MAX_ENTRIES_PER_BOT) {
  for (let i = 0; i < n; i += 1) {
    await repo.write(botId, { topic: `t${i % 10}`, text: `第 ${i} 条内容。补充说明 ${i}` })
  }
}

test('压缩：500 条到顶后 write 触发 compact，最旧一批合成 1 条摘要并腾出空间', async () => {
  const repo = await createMemoryRepo(fakeContext())
  await fill(repo, 'bot-a')
  assert.equal((await repo.list('bot-a')).length, MAX_ENTRIES_PER_BOT)
  // 第 501 条写入：不应抛错，而是先压缩腾空间再写入
  await repo.write('bot-a', { topic: '新', text: '到顶后的新记忆' })
  const list = await repo.list('bot-a')
  assert.equal(list.length, 252, '250 条最旧被合成 1 条摘要：250 - 250 + 1 + 1 = 252')
  const summaries = list.filter((e) => e.topic === '摘要')
  assert.equal(summaries.length, 1)
  assert.match(summaries[0].text, /压缩摘要/)
  assert.match(summaries[0].text, /250 条/)
  // 最旧一批确实没了，新记忆和最新一半还在
  assert.equal(await repo.read('bot-a', '新').then((l) => l.length), 1)
  assert.ok(list.some((e) => e.text.includes('第 499 条内容')))
  assert.ok(!list.some((e) => e.text.includes('补充说明 0')), '最旧一批原文已被合并删除')
})

test('压缩：摘要保留各条首句（最简拼接算法，标注可替换）', async () => {
  const ctx = fakeContext()
  const repo = await createMemoryRepo(ctx, { compactThreshold: 2, compactBatch: 2 })
  await repo.write('bot-a', { topic: '部署', text: '部署一律用 pnpm。环境变量见文档' })
  await repo.write('bot-a', { topic: '测试', text: '测试用 node --test。不装额外依赖' })
  await repo.write('bot-a', { topic: '触发', text: '第三条触发压缩' })
  const summaries = (await repo.list('bot-a')).filter((e) => e.topic === '摘要')
  assert.equal(summaries.length, 1)
  assert.match(summaries[0].text, /部署一律用 pnpm/)
  assert.match(summaries[0].text, /测试用 node --test/)
  assert.ok(!summaries[0].text.includes('环境变量见文档'), '只保留首句，不带后续句子')
})

test('压缩：journal 落 compact 记录（entryId 指向摘要条目）', async () => {
  const ctx = fakeContext()
  const repo = await createMemoryRepo(ctx, { compactThreshold: 2, compactBatch: 2 })
  await repo.write('bot-a', { topic: 'a', text: '一' })
  await repo.write('bot-a', { topic: 'a', text: '二' })
  await repo.write('bot-a', { topic: 'a', text: '三' })
  const journal = await repo.journal('bot-a', 100)
  const compactRecord = journal.find((r) => r.action === 'compact')
  assert.ok(compactRecord, 'journal 里要有 compact 记录')
  const summaries = (await repo.list('bot-a')).filter((e) => e.topic === '摘要')
  assert.equal(compactRecord.entryId, summaries[0].id)
})

test('压缩：摘要产物镜像写入注入的 tmp 目录（JSON 文件，含 botId 与摘要文本）', async () => {
  const mirrorDir = await mkdtemp(join(tmpdir(), 'dsh-test-dsh-bot-mirror-'))
  try {
    const ctx = fakeContext()
    const repo = await createMemoryRepo(ctx, { compactThreshold: 2, compactBatch: 2, mirrorDir })
    await repo.write('bot-a', { topic: 'a', text: '一' })
    await repo.write('bot-a', { topic: 'a', text: '二' })
    await repo.write('bot-a', { topic: 'a', text: '三' })
    const botDir = join(mirrorDir, 'dsh-bot', 'bot-a')
    const files = (await readdirSafe(botDir)).filter((f) => f.endsWith('.json'))
    assert.equal(files.length, 1, '压缩一次镜像一个 JSON 文件')
    const payload = JSON.parse(await readFile(join(botDir, files[0]), 'utf8'))
    assert.equal(payload.plugin, 'dsh-bot')
    assert.equal(payload.botId, 'bot-a')
    assert.match(payload.summary, /压缩摘要/)
    assert.equal(payload.mergedCount, 2)
  } finally {
    await rm(mirrorDir, { recursive: true, force: true })
  }
})

test('压缩：镜像目录不可写时 warn 降级跳过，不崩溃', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-test-dsh-bot-bad-'))
  // 用一个「文件」充当镜像目录：mkdir/readdir 会失败
  const blockFile = join(root, 'not-a-dir')
  await writeFile(blockFile, 'x', 'utf8')
  try {
    const ctx = fakeContext()
    const repo = await createMemoryRepo(ctx, { compactThreshold: 2, compactBatch: 2, mirrorDir: blockFile })
    await repo.write('bot-a', { topic: 'a', text: '一' })
    await repo.write('bot-a', { topic: 'a', text: '二' })
    await repo.write('bot-a', { topic: 'a', text: '三' })
    assert.equal(ctx.warnings.some((w) => w.includes('镜像')), true, 'warn 里要提到镜像降级')
    assert.ok((await repo.list('bot-a')).some((e) => e.topic === '摘要'), '压缩本身仍然成功')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function readdirSafe(dir) {
  try {
    return await (await import('node:fs/promises')).readdir(dir)
  } catch {
    return []
  }
}

test('压缩：未到顶时 write 不触发压缩', async () => {
  const ctx = fakeContext()
  const repo = await createMemoryRepo(ctx)
  await repo.write('bot-a', { topic: 'a', text: '日常一条' })
  const journal = await repo.journal('bot-a', 100)
  assert.equal(journal.some((r) => r.action === 'compact'), false)
})

test('压缩：显式 compact(botId) 也可手动调用', async () => {
  const repo = await createMemoryRepo(fakeContext(), { compactThreshold: 3, compactBatch: 3 })
  await repo.write('bot-a', { topic: 'a', text: '一' })
  await repo.write('bot-a', { topic: 'a', text: '二' })
  await repo.write('bot-a', { topic: 'a', text: '三' })
  const summary = await repo.compact('bot-a')
  assert.ok(summary.text.includes('压缩摘要'))
  assert.equal((await repo.list('bot-a')).filter((e) => e.topic === '摘要').length, 1)
})

void mkdir // 保持 import（部分用例经 mkdtemp 已覆盖）
void fileURLToPath
void flush
