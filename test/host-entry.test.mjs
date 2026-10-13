import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('host 入口：name/inject 三件套契约', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'dsh-bot')
  // 只 inject 本票真正用到的三个服务
  assert.deepEqual([...mod.inject].sort(), ['agentPresets', 'storage', 'systemPrompt'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply：注册人格段，不抛错；storage 可用时用 KV', async () => {
  const mod = await import('../lib/index.js')
  const ctx = fakeContext()
  mod.apply(ctx)
  await flush()
  const section = ctx.sections.get('dsh-bot:persona')
  assert.ok(section, '应注册 dsh-bot:persona 段')
  assert.equal(typeof section.text, 'function', '人格段应是 provider 函数')
})

test('apply：storage 缺失时降级为内存并 warn，不抛错', async () => {
  const mod = await import('../lib/index.js')
  const ctx = fakeContext({ storage: false })
  mod.apply(ctx)
  await flush()
  assert.ok(ctx.warnings.some((w) => w.includes('storage')), '应有降级 warning')
  const section = ctx.sections.get('dsh-bot:persona')
  assert.ok(section)
})
