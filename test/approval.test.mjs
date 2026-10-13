// 票 #6·审批：fail-closed 语义 + 三档预设
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'
import { isGranted } from '../lib/bot-approval.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('fail-closed：只有 allowed-once 算授权', () => {
  assert.equal(isGranted('allowed-once'), true)
  assert.equal(isGranted('rejected'), false)
  assert.equal(isGranted('cancelled'), false)
  assert.equal(isGranted('unavailable'), false)
})

test('有 answerer：request → granted=true, outcome=allowed-once', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  const decision = await runtime.approval.request({ toolName: 'fs.read', title: '读受保护文件' })
  assert.deepEqual(decision, { granted: true, outcome: 'allowed-once' })
  assert.ok(ctx.calls.includes('approval request fs.read'))
})

test('无 answerer（策略 ask）：outcome=unavailable → granted=false，绝不放行', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  ctx.setAnswererAvailable(false)
  const decision = await runtime.approval.request({ toolName: 'fs.read' })
  assert.equal(decision.granted, false)
  assert.equal(decision.outcome, 'unavailable')
})

test('三档预设：目录/当前/切换；未知档位抛错', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  assert.deepEqual(await runtime.approval.listPresets(), ['default', 'safe', 'trusted'])
  assert.equal(await runtime.approval.currentPreset({}), 'default')
  assert.equal(await runtime.approval.applyPreset({}, 'safe'), 'safe')
  assert.ok(ctx.calls.includes('preset set safe'))
  await assert.rejects(() => runtime.approval.applyPreset({}, 'nope'), /未知权限档位/)
})
