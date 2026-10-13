// 票 #6·模型选择：目录聚合 / selectModel 转发与持久化 / 服务缺失降级
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'
import { createIdentityStore } from '../lib/identity.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('模型目录：聚合 llm.listProviders × listModels', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const catalog = await runtime.models.listCatalog()
  assert.deepEqual(catalog, [
    { provider: 'openai', models: ['openai-a', 'openai-b'] },
    { provider: 'deepseek', models: ['deepseek-a', 'deepseek-b'] },
  ])
})

test('selectModel：转发 sessionController 并持久化（selection 表 key=model）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const selected = await runtime.models.selectModel('s1', { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(selected.provider, 'deepseek')
  assert.equal(selected.model, 'deepseek-chat')
  assert.ok(ctx.calls.some((c) => c === 'selectModel provider=deepseek model=deepseek-chat session=s1'))
  assert.equal(runtime.models.currentSelection()?.model, 'deepseek-chat')
  // KV 事实源：新开一个 store 读回同一选择
  const store2 = await createIdentityStore(ctx)
  assert.deepEqual(await store2.getMeta('model'), selected)
})

test('selectModel 带 reasoningEffort 也透传', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const selected = await runtime.models.selectModel('s1', { provider: 'openai', model: 'gpt-x', reasoningEffort: 'high' })
  assert.equal(selected.reasoningEffort, 'high')
})

test('llm/sessionController 缺失：inject 跳过、models 保持 undefined、不抛错', async () => {
  const ctx = fakeContext({ disable: ['llm', 'sessionController'] })
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  assert.equal(runtime.models, undefined)
  assert.ok(ctx.calls.some((c) => c.includes('inject skip [llm,sessionController]')))
})
