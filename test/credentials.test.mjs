// 票 #6·凭据：透传 ctx.credentials，不自建 secrets
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'
import { assertCredentialRef, isValidCredentialRef } from '../lib/bot-credentials.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

test('凭据引用文法：POSIX shell 标识符，可 scope/id', () => {
  assert.ok(isValidCredentialRef('api_key'))
  assert.ok(isValidCredentialRef('github/token'))
  assert.ok(!isValidCredentialRef(''))
  assert.ok(!isValidCredentialRef('has space'))
  assert.ok(!isValidCredentialRef('-leading-dash'))
  assert.ok(!isValidCredentialRef('a/b/c'))
  assert.throws(() => assertCredentialRef('bad ref'), /非法凭据引用/)
})

test('set/resolve/unset/listRecords 透传且生效', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await runtime.credentials.set('github/token', 'secret-value')
  assert.ok(ctx.calls.includes('cred set github/token'))
  const resolved = await runtime.credentials.resolve('github/token')
  assert.deepEqual(resolved, { value: 'secret-value', source: 'test' })
  assert.equal((await runtime.credentials.describe('github/token')).configured, true)
  assert.equal((await runtime.credentials.listRecords()).length, 1)
  await runtime.credentials.unset('github/token')
  assert.equal(await runtime.credentials.resolve('github/token'), undefined)
})

test('set 空值前置拒绝（宿主同样拒绝，提示用 unset）', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await assert.rejects(() => runtime.credentials.set('k', ''), /不能为空/)
  await assert.rejects(() => runtime.credentials.set('k', '   '), /不能为空/)
})

test('非法引用在任何操作前被拒绝', async () => {
  const ctx = fakeContext()
  const runtime = apply(ctx, { rootSessionId: 'root-1' })
  await flush()
  await assert.rejects(() => runtime.credentials.resolve('bad ref'), /非法凭据引用/)
  await assert.rejects(() => runtime.credentials.set('bad ref', 'v'), /非法凭据引用/)
})
