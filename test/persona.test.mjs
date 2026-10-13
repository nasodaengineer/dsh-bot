import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { createIdentityStore } from '../lib/identity.js'
import { personaSection } from '../lib/persona.js'

async function setup() {
  const ctx = fakeContext()
  const store = await createIdentityStore(ctx)
  return { ctx, store }
}

test('人格段：Name/Title/Description 拼进提示词文本', async (t) => {
  const { store } = await setup()
  await store.put({ id: 'bot-alice', name: 'Alice', title: '研究员', description: '负责调研' })
  const section = personaSection(store, { selectedId: () => 'bot-alice' })
  const text = section.text({})
  assert.match(text, /Alice/)
  assert.match(text, /研究员/)
  assert.match(text, /负责调研/)
})

test('人格段：未选中 Bot 时不注入 + warn（B7：不再静默回退名册第一个）', async (t) => {
  const { store } = await setup()
  await store.put({ id: 'bot-alice', name: 'Alice', title: '研究员', description: '负责调研' })
  const warns = []
  const section = personaSection(store, { selectedId: () => undefined }, { warn: (m) => warns.push(m) })
  assert.equal(section.text({}), '')
  assert.equal(warns.length, 1)
  // warn 只发一次
  section.text({})
  assert.equal(warns.length, 1)
})

test('人格段：名册为空时文本为空字符串（不产生空段）', async (t) => {
  const { store } = await setup()
  const section = personaSection(store, { selectedId: () => undefined })
  assert.equal(section.text({}), '')
})

test('人格段：order 为 100（在人设前缀 0 与 PLAN_POLICY 500 之间）', async (t) => {
  const { store } = await setup()
  const section = personaSection(store, { selectedId: () => undefined })
  assert.equal(section.order, 100)
  assert.equal(section.name, 'dsh-bot:persona')
})
