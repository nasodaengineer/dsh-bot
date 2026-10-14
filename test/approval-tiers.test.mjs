// 票 #16·审批三档（manual/limited/full）+ fail-closed 回退 + 审计落表
// 全离线：autoDecide 用内存 fake，绝不发网络请求。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './fake-ctx.mjs'
import { apply } from '../lib/index.js'

const flush = () => new Promise((resolve) => setImmediate(resolve))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function nativeTeams() {
  return {
    async membership() { return { teamId: 'root' } },
    async tryMembership() { return { teamId: 'root' } },
    async listMembers() { return [] },
    async spawnTeammate(o) { return { id: 'member-1', ...o } },
    async sendMessage() { return { ok: true } },
    async createTask(s) { return { id: 'task-1', status: 'open', ...s } },
    async getTask() { return undefined },
    async listTasks() { return [] },
    async updateTask(r) { return { id: r.id, ...r.patch } },
    async waitForChange() { return { changed: true } },
    async interrupt() { return { ok: true } },
  }
}

// autoDecide fake：decode 计数可断言「是否真的判过」
function fakeDecide(answer) {
  let decodeCalls = 0
  return {
    get decodeCalls() { return decodeCalls },
    async decode(request) {
      decodeCalls += 1
      if (typeof answer === 'function') return answer(request)
      return { answers: { deny: answer } }
    },
  }
}

const DENY = { type: 'noul', choice: 'true', confidence: 0.9, probabilities: { true: 0.9, false: 0.1 } }
const ALLOW = { type: 'noul', choice: 'false', confidence: 0.8, probabilities: { true: 0.1, false: 0.8 } }

async function setup({ approval, autoDecide } = {}) {
  const services = { agentTeams: nativeTeams() }
  if (autoDecide !== undefined) services.autoDecide = autoDecide
  const ctx = fakeContext({ services })
  // 捕获打开的 KV unit（fake-ctx 的 tables 不外露，从 open 返回值拿）
  const kvUnits = []
  const rawOpen = ctx.kvBackend.kv.open.bind(ctx.kvBackend.kv)
  ctx.kvBackend.kv.open = async (d) => {
    const unit = await rawOpen(d)
    kvUnits.push(unit)
    return unit
  }
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }), approval },
  })
  await flush()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  return { ctx, runtime, group, kvUnits }
}

const kvApprovals = async (kvUnits) => {
  const unit = kvUnits[kvUnits.length - 1]
  const snapshot = await unit.loadAll()
  return snapshot.tables.approvals ?? {}
}

// ---------- manual（默认档）：现状不变，绝不碰 autoDecide ----------

test('manual（默认档）：人工应答照旧，autoDecide 不被调用', async () => {
  const decide = fakeDecide(ALLOW)
  const { runtime, group } = await setup({ autoDecide: decide }) // 不传 approval → 默认 manual
  const p = runtime.groups.requestApproval({ groupId: group.id, toolName: 'shell.run', timeoutMs: 200 })
  const pending = runtime.groups.listPendingApprovals(group.id)
  assert.equal(pending.length, 1)
  await runtime.groups.answerApproval(pending[0].id, 'allowed-once')
  const decided = await p
  assert.equal(decided.granted, true)
  assert.equal(decide.decodeCalls, 0, 'manual 档不做自动判定')
  const audits = runtime.groups.listApprovalAudits()
  assert.equal(audits.length, 1)
  assert.equal(audits[0].source, 'human')
  assert.equal(audits[0].tier, 'manual')
})

test('manual（默认档）：超时 fail-closed，autoDecide 不被调用', async () => {
  const decide = fakeDecide(ALLOW)
  const { runtime, group } = await setup({ autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 30 })
  assert.equal(decided.granted, false)
  assert.equal(decided.outcome, 'unavailable')
  assert.equal(decide.decodeCalls, 0)
})

// ---------- limited：超时前判一次，拒/不确定→reject；允许→仍等人工 ----------

test('limited：超时前 autoDecide 判拒绝 → 直接 reject，出「自动建议：拒绝」提示，落 auto 审计', async () => {
  const decide = fakeDecide(DENY)
  const { runtime, group } = await setup({ approval: 'limited', autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'rm.rf', summary: '删库', timeoutMs: 200 })
  assert.equal(decided.granted, false)
  assert.equal(decided.outcome, 'rejected')
  assert.equal(decide.decodeCalls, 1, 'limited 档超时前判一次')
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 0)
  const history = await runtime.groups.history(group.id)
  assert.ok(history.some((m) => m.text.includes('自动建议：拒绝')), '应写「自动建议：拒绝」群提示')
  const audits = runtime.groups.listApprovalAudits()
  const auto = audits.find((a) => a.source === 'auto')
  assert.ok(auto, '应有 auto 审计')
  assert.equal(auto.tier, 'limited')
  assert.equal(auto.judgment, 'deny')
  assert.deepEqual(auto.probabilities, { true: 0.9, false: 0.1 })
  assert.ok(typeof auto.basis === 'string' && auto.basis.length > 0, '应带判定依据摘要')
})

test('limited：autoDecide 判允许 → 仍等人工；人工放行后 granted=true；auto+human 双审计', async () => {
  const decide = fakeDecide(ALLOW)
  const { runtime, group } = await setup({ approval: 'limited', autoDecide: decide })
  const p = runtime.groups.requestApproval({ groupId: group.id, toolName: 'fs.write', timeoutMs: 200 })
  await sleep(120) // 等 limited 自动判定跑完（timeout 200 → leadAt 100ms）
  assert.equal(decide.decodeCalls, 1)
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 1, '判允许仍等人工，待批卡保留')
  const card = runtime.groups.listPendingApprovals(group.id)[0]
  await runtime.groups.answerApproval(card.id, 'allowed-once')
  const decided = await p
  assert.equal(decided.granted, true)
  const audits = runtime.groups.listApprovalAudits()
  assert.deepEqual(audits.map((a) => a.source).sort(), ['auto', 'human'])
  const auto = audits.find((a) => a.source === 'auto')
  assert.equal(auto.judgment, 'allow')
})

test('limited：不确定/低置信 → 按 fail-closed 自动 reject', async () => {
  const decide = fakeDecide({ type: 'noul', confidence: 0.5, probabilities: { true: 0.5, false: 0.5 } })
  const { runtime, group } = await setup({ approval: 'limited', autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 200 })
  assert.equal(decided.granted, false)
  assert.equal(decided.outcome, 'rejected')
  const auto = runtime.groups.listApprovalAudits().find((a) => a.source === 'auto')
  assert.equal(auto.judgment, 'uncertain')
})

// ---------- full：收到即判，允许→直接代答 allowed-once ----------

test('full：autoDecide 判允许 → 直接代答 allowed-once，不等待人工；卡片展示已自动判定', async () => {
  const decide = fakeDecide(ALLOW)
  const { runtime, group } = await setup({ approval: 'full', autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'fs.read', timeoutMs: 60000 })
  assert.equal(decided.granted, true)
  assert.equal(decided.outcome, 'allowed-once')
  assert.equal(decide.decodeCalls, 1)
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 0)
  const cards = runtime.groups.listApprovalCards(group.id)
  assert.equal(cards.length, 1, 'full 档卡片保留展示')
  assert.equal(cards[0].status, 'answered')
  assert.equal(cards[0].autoVerdict, 'allowed')
  const auto = runtime.groups.listApprovalAudits().find((a) => a.source === 'auto')
  assert.equal(auto.tier, 'full')
  assert.equal(auto.outcome, 'allowed-once')
  assert.equal(auto.judgment, 'allow')
})

test('full：autoDecide 判拒绝 → 直接 reject，卡片展示已自动拒绝', async () => {
  const decide = fakeDecide(DENY)
  const { runtime, group } = await setup({ approval: 'full', autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'rm.rf', timeoutMs: 60000 })
  assert.equal(decided.granted, false)
  assert.equal(decided.outcome, 'rejected')
  const cards = runtime.groups.listApprovalCards(group.id)
  assert.equal(cards[0].autoVerdict, 'rejected')
  const auto = runtime.groups.listApprovalAudits().find((a) => a.source === 'auto')
  assert.equal(auto.outcome, 'rejected')
})

// ---------- fail-closed 回退：autoDecide 缺失/抛错 → manual 语义，绝不自动放行 ----------

test('fail-closed：full 档 autoDecide 服务缺失 → 回退人工等待，绝不自动放行', async () => {
  const { runtime, group, ctx } = await setup({ approval: 'full' }) // 未注入 autoDecide
  const p = runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 100 })
  await flush() // full 分支注册待批卡前有一次 await，让微任务跑完
  assert.equal(runtime.groups.listPendingApprovals(group.id).length, 1, '回退 manual：出待批卡等人工')
  const card = runtime.groups.listPendingApprovals(group.id)[0]
  await runtime.groups.answerApproval(card.id, 'allowed-once')
  const decided = await p
  assert.equal(decided.granted, true)
  assert.equal(decided.outcome, 'allowed-once', '放行只能来自人工')
  const autoAudits = runtime.groups.listApprovalAudits().filter((a) => a.source === 'auto')
  assert.equal(autoAudits.length, 1, '服务缺失的判定本身落审计（fail-closed 证据）')
  assert.equal(autoAudits[0].judgment, 'unavailable')
  assert.equal(autoAudits[0].outcome, undefined, '服务缺失绝不产生 auto 放行')
  assert.ok(ctx.warnings.some((w) => w.includes('回退人工等待')), 'warn 可见')
})

test('fail-closed：full 档 decode 抛错 → 回退人工；超时仍 fail-closed', async () => {
  const decide = fakeDecide(async () => { throw new Error('decode down') })
  const { runtime, group } = await setup({ approval: 'full', autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 60 })
  assert.equal(decided.granted, false, 'decode 抛错绝不自动放行')
  assert.equal(decided.outcome, 'unavailable')
  assert.equal(decide.decodeCalls, 1)
})

test('fail-closed：limited 档 autoDecide 超时 → 什么都不做，走人工，超时 fail-closed', async () => {
  const decide = {
    decodeCalls: 0,
    decode() { this.decodeCalls += 1; return new Promise(() => {}) }, // 永不 resolve
  }
  const { runtime, group } = await setup({ approval: 'limited', autoDecide: decide })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 150 })
  assert.equal(decided.granted, false)
  assert.equal(decided.outcome, 'unavailable', '自动判定挂起 → 原有超时 fail-closed 兜底')
  assert.equal(decide.decodeCalls, 1)
})

// ---------- 审计落 KV approvals 表 ----------

test('审计：auto/human 记录双写进 KV approvals 表（含 tier/source/judgment/basis/probabilities）', async () => {
  const decide = fakeDecide(ALLOW)
  const { runtime, group, kvUnits } = await setup({ approval: 'full', autoDecide: decide })
  await runtime.groups.requestApproval({ groupId: group.id, toolName: 'fs.read', timeoutMs: 60000 })
  const table = await kvApprovals(kvUnits)
  const records = Object.values(table)
  assert.ok(records.length >= 1, 'KV approvals 表应有记录')
  const record = records[0]
  assert.equal(record.tier, 'full')
  assert.equal(record.source, 'auto')
  assert.equal(record.judgment, 'allow')
  assert.equal(record.outcome, 'allowed-once')
  assert.deepEqual(record.probabilities, { true: 0.1, false: 0.8 })
  assert.ok(typeof record.basis === 'string' && record.basis.length > 0)
  assert.equal(record.approvalId.startsWith('apr-'), true)
  assert.ok(typeof record.at === 'string')
})

test('审计：KV 打不开时降级内存记录，审批路径不抛错', async () => {
  const services = { agentTeams: nativeTeams(), autoDecide: fakeDecide(ALLOW) }
  const ctx = fakeContext({ services, storage: false }) // 无 storage → KV 降级
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }), approval: 'full' },
  })
  await flush()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 60000 })
  assert.equal(decided.granted, true)
  assert.equal(runtime.groups.listApprovalAudits().length, 1, '内存审计仍在')
  assert.ok(ctx.warnings.some((w) => w.includes('审计降级内存')), 'KV 不可用要有「审计降级内存」warn（不静默）')
})

test('审计：单次 KV 写失败也要 warn「审计降级内存」，审批路径不抛错', async () => {
  const services = { agentTeams: nativeTeams(), autoDecide: fakeDecide(ALLOW) }
  const ctx = fakeContext({ services })
  // 在 apply 之前装好 hook，让 approvals 表的 putRecord 必炸（模拟 KV 单次写失败）
  const rawOpen = ctx.kvBackend.kv.open.bind(ctx.kvBackend.kv)
  ctx.kvBackend.kv.open = async (d) => {
    const unit = await rawOpen(d)
    const rawPut = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      if (table === 'approvals') throw new Error('kv write boom')
      return rawPut(table, key, value)
    }
    return unit
  }
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }), approval: 'full' },
  })
  await flush()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const decided = await runtime.groups.requestApproval({ groupId: group.id, toolName: 'x', timeoutMs: 60000 })
  assert.equal(decided.granted, true, 'KV 写失败不阻断审批')
  assert.ok(ctx.warnings.some((w) => w.includes('审计降级内存')), '写失败要有「审计降级内存」warn')
  assert.equal(runtime.groups.listApprovalAudits().length, 1, '内存审计仍在')
})

// ---------- 修复轮：decidedCards 落 KV 持久化 ----------

test('full 档已判定卡持久化：重启（新 runtime 载回同一 KV）后 listApprovalCards 仍展示', async () => {
  const services = { agentTeams: nativeTeams(), autoDecide: fakeDecide(ALLOW) }
  const ctx = fakeContext({ services })
  const first = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }), approval: 'full' },
  })
  await flush()
  const group = await first.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  await first.groups.requestApproval({ groupId: group.id, toolName: 'fs.read', timeoutMs: 60000 })
  assert.equal(first.groups.listApprovalCards(group.id).length, 1)
  // 「重启」：同一 ctx 再 apply 一次，新 runtime 从 KV 载回
  const second = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }), approval: 'full' },
  })
  await flush()
  const cards = second.groups.listApprovalCards(group.id)
  assert.equal(cards.length, 1, '重启后已判定卡从 KV 载回，仍可展示')
  assert.equal(cards[0].status, 'answered')
  assert.equal(cards[0].autoVerdict, 'allowed')
  assert.equal(cards[0].toolName, 'fs.read')
})

test('answerApproval：未知卡直接抛错（fail-closed），不写空字段审计', async () => {
  const services = { agentTeams: nativeTeams() }
  const ctx = fakeContext({ services })
  const runtime = apply(ctx, {
    rootSessionId: 'root-session',
    typesafe: { judge: async () => ({ responder: { choice: 'none' } }) },
  })
  await flush()
  const group = await runtime.groups.createGroup({ name: 'g', memberIds: ['bot-a'] })
  const before = runtime.groups.listApprovalAudits().length
  await assert.rejects(() => runtime.groups.answerApproval('apr-nope', 'allowed-once'))
  assert.equal(runtime.groups.listApprovalAudits().length, before, '未知卡不产生审计记录')
})
