import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDshBotMemorySource } from '../lib/memory-source.js'

// 离线 fake repo：实现 MemoryRepo 接口的最小子集（进程内，不碰 KV）
function fakeRepo() {
  const entries = []
  let seq = 0
  return {
    async write(botId, input) {
      seq += 1
      const entry = {
        id: `mem-${seq}`,
        botId,
        topic: input.topic,
        text: input.text,
        size: input.text.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      entries.push(entry)
      return entry
    },
    async read(botId, topic) {
      return entries.filter((e) => e.botId === botId && e.topic === topic)
    },
    async search(botId, query) {
      const tokens = query.split(/\s+/).filter(Boolean)
      return entries.filter((e) => e.botId === botId && tokens.every((t) => `${e.topic} ${e.text}`.includes(t)))
    },
    async list(botId) {
      return entries.filter((e) => e.botId === botId)
    },
    async indexText(botId) {
      return entries.filter((e) => e.botId === botId).map((e) => `- [${e.topic}] ${e.text}`).join('\n')
    },
  }
}

const FAKE_SCOPE = { storage: 'workspace', workspaceId: 'ws-test' }

function makeRuntime() {
  const repo = fakeRepo()
  const definition = createDshBotMemorySource(repo, { instanceKey: 'dsh-bot/test', defaultBotId: 'bot-a' })
  const runtime = definition.create({
    sourceInstanceKey: 'dsh-bot/test',
    provenance: { packageName: 'dsh-bot', entryId: 'dsh-bot' },
  })
  return { repo, definition, runtime }
}

test('MemorySource：manifest 形状符合贡献契约（kind=source / apiVersion / capabilities / routes / actions）', () => {
  const { definition } = makeRuntime()
  const m = definition.manifest
  assert.equal(m.kind, 'source')
  assert.equal(m.apiVersion, 'dsh-mnemon/v1')
  assert.equal(m.typeId, 'dsh-bot/memory')
  assert.equal(m.packageName, 'dsh-bot')
  assert.ok(m.capabilities.includes('project'))
  assert.ok(m.capabilities.includes('search'))
  assert.ok(m.capabilities.includes('write'))
  assert.equal(m.consistency, 'namespace-pinned-live-read')
  const routeIds = m.routes.map((r) => r.id)
  const actionIds = m.actions.map((a) => a.id)
  assert.deepEqual(routeIds, ['search'])
  assert.deepEqual(actionIds, ['write'])
  assert.equal(m.routes[0].capability, 'search')
  assert.equal(m.actions[0].capability, 'write')
})

test('MemorySource：facts 返回 ready 状态与 route/action 清单（不写入）', async () => {
  const { runtime } = makeRuntime()
  const facts = await runtime.facts({ scope: FAKE_SCOPE, scenario: 'test', budget: {} })
  assert.equal(facts.sourceInstanceKey, 'dsh-bot/test')
  assert.equal(facts.sourceTypeId, 'dsh-bot/memory')
  assert.equal(facts.availability, 'ready')
  assert.equal(facts.role, 'bot-facts')
  assert.deepEqual(facts.routeIds, ['search'])
  assert.deepEqual(facts.actionIds, ['write'])
  assert.equal(typeof facts.revision, 'string')
})

test('MemorySource：project 贡献记忆索引片段（尊重 maxCharacters 上限）', async () => {
  const { repo, runtime } = makeRuntime()
  await repo.write('bot-a', { topic: '偏好', text: '部署用 pnpm' })
  const full = await runtime.project({ scope: FAKE_SCOPE, sourceInstanceKey: 'dsh-bot/test', expectedRevision: 'rev-1', includeProjection: true, mode: 'eager', maxCharacters: 4096 })
  assert.equal(full.fragments.length, 1)
  assert.match(full.fragments[0].text, /部署用 pnpm/)
  assert.equal(full.fragments[0].sourceInstanceKey, 'dsh-bot/test')
  // maxCharacters=10 时截断，不超限
  const tiny = await runtime.project({ scope: FAKE_SCOPE, sourceInstanceKey: 'dsh-bot/test', expectedRevision: 'rev-1', includeProjection: true, mode: 'eager', maxCharacters: 10 })
  assert.ok(tiny.fragments[0].text.length <= 10)
})

test('MemorySource：query 走 search 路由返回 Evidence 形状', async () => {
  const { repo, runtime } = makeRuntime()
  await repo.write('bot-a', { topic: '构建', text: '构建用 pnpm 打包' })
  const evidence = await runtime.query({
    view: { id: 'view-1', scope: FAKE_SCOPE },
    route: { id: 'route-1', sourceInstanceKey: 'dsh-bot/test', sourceRouteId: 'search', description: '', capability: 'search', inputSchema: {} },
    grant: { id: 'grant-1', sourceInstanceKey: 'dsh-bot/test', schema: 'test', value: { botId: 'bot-a' }, revision: 'rev-1', consistency: 'namespace-pinned-live-read' },
    input: { query: 'pnpm' },
  })
  assert.equal(evidence.routeId, 'route-1')
  assert.equal(evidence.sourceInstanceKey, 'dsh-bot/test')
  assert.equal(evidence.truncated, false)
  assert.equal(evidence.items.length, 1)
  assert.match(evidence.items[0].text, /构建用 pnpm/)
  assert.ok(evidence.items[0].provenance.topic === '构建')
})

test('MemorySource：mutate 走 write 动作落 repo，返回 succeeded/committed 收据', async () => {
  const { repo, runtime } = makeRuntime()
  const receipt = await runtime.mutate({
    view: { id: 'view-1', scope: FAKE_SCOPE },
    offer: { id: 'offer-1', sourceInstanceKey: 'dsh-bot/test', sourceActionId: 'write', description: '', capability: 'write', inputSchema: {} },
    input: { botId: 'bot-a', topic: '偏好', text: '永远回复中文' },
  })
  assert.equal(receipt.status, 'succeeded')
  assert.equal(receipt.completion, 'committed')
  assert.ok(typeof receipt.committedAt === 'string')
  const found = await repo.read('bot-a', '偏好')
  assert.equal(found.length, 1)
  assert.match(found[0].text, /中文/)
})

test('MemorySource：mutate 缺 botId/topic/text 时返回 failed 收据而非抛错', async () => {
  const { runtime } = makeRuntime()
  const receipt = await runtime.mutate({
    view: { id: 'view-1', scope: FAKE_SCOPE },
    offer: { id: 'offer-1', sourceInstanceKey: 'dsh-bot/test', sourceActionId: 'write', description: '', capability: 'write', inputSchema: {} },
    input: { botId: 'bot-a' },
  })
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.completion, 'failed')
})

test('MemorySource：dispose 可调用且幂等', async () => {
  const { runtime } = makeRuntime()
  await runtime.dispose()
  await runtime.dispose()
})
