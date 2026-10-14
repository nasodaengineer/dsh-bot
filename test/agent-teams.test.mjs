import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentTeamsFacade } from '../lib/agent-teams.js'

// 假 TeamService：签名与宿主原生一致（caller 第一位），记录调用参数验证重排
function fakeTeamService() {
  const calls = []
  let memberSeq = 0
  let taskSeq = 0
  const members = new Map()
  const tasks = new Map()
  const svc = {
    calls,
    async membership(caller) {
      calls.push(['membership', caller])
      return { teamId: 'team-1', role: 'lead' }
    },
    async listMembers(caller) {
      calls.push(['listMembers', caller])
      return [...members.values()]
    },
    async tryMembership(caller) {
      calls.push(['tryMembership', caller])
      return { teamId: 'team-1' }
    },
    async spawnTeammate(caller, request) {
      calls.push(['spawnTeammate', caller, request])
      memberSeq += 1
      const member = { id: `member-${memberSeq}`, ...request }
      members.set(member.id, member)
      return member
    },
    async sendMessage(caller, request) {
      calls.push(['sendMessage', caller, request])
      return { ok: true }
    },
    async createTask(caller, request) {
      calls.push(['createTask', caller, request])
      taskSeq += 1
      const task = { id: `task-${taskSeq}`, status: 'open', ...request }
      tasks.set(task.id, task)
      return task
    },
    async getTask(caller, id) {
      calls.push(['getTask', caller, id])
      return tasks.get(id)
    },
    // 原生 listTasks 只收 caller，不收 filter
    async listTasks(caller) {
      calls.push(['listTasks', caller])
      return [...tasks.values()]
    },
    async updateTask(caller, request) {
      calls.push(['updateTask', caller, request])
      const task = tasks.get(request.id)
      if (task === undefined) throw new Error(`unknown task ${request.id}`)
      Object.assign(task, request.patch)
      return task
    },
    async waitForChange(caller, timeoutMs, signal) {
      calls.push(['waitForChange', caller, timeoutMs, signal])
      return { changed: true }
    },
    async interrupt(caller, targetName) {
      calls.push(['interrupt', caller, targetName])
      return { ok: true }
    },
  }
  return svc
}

const CALLER = { agent: 'live-caller-stub' }

test('agent-teams：门面把 caller 重排到原生第一位（实测#9 签名修复）', async () => {
  const native = fakeTeamService()
  const facade = createAgentTeamsFacade(native)

  const member = await facade.spawnTeammate({ name: 'alice' }, CALLER)
  assert.equal(member.id, 'member-1')
  assert.equal(native.calls[0][1], CALLER, 'caller 必须落在原生第一位')
  assert.equal(native.calls[0][2].name, 'alice')

  await facade.sendMessage({ to: 'member-1', text: 'hi' }, CALLER)
  assert.equal(native.calls[1][1], CALLER)
  assert.equal(native.calls[1][2].text, 'hi')

  await facade.listMembers(CALLER)
  assert.equal(native.calls[2][1], CALLER)

  await facade.membership(CALLER)
  await facade.tryMembership(CALLER)
  await facade.interrupt('member-1', CALLER)
  assert.equal(native.calls.at(-1)[1], CALLER)
  assert.equal(native.calls.at(-1)[2], 'member-1')

  await facade.waitForChange({}, { timeoutMs: 100 }, CALLER)
  assert.equal(native.calls.at(-1)[1], CALLER)
  assert.equal(native.calls.at(-1)[2], 100)
})

test('agent-teams：caller 缺失时抛错，绝不合成权限凭据', async () => {
  const facade = createAgentTeamsFacade(fakeTeamService())
  await assert.rejects(() => facade.spawnTeammate({ name: 'x' }, undefined), /caller/)
  await assert.rejects(() => facade.sendMessage({ to: 'a', text: 'b' }, undefined), /caller/)
  await assert.rejects(() => facade.listTasks({}, undefined), /caller/)
})

test('agent-teams：任务方法走原生 caller-first 签名，filter 客户端等值过滤', async () => {
  const native = fakeTeamService()
  const facade = createAgentTeamsFacade(native)
  const task = await facade.createTask({ title: '写文档', dependsOn: [] }, CALLER)
  assert.equal(task.status, 'open')
  assert.equal(native.calls[0][1], CALLER, 'createTask caller 第一位')

  const got = await facade.getTask({ id: task.id }, CALLER)
  assert.equal(got.title, '写文档')
  assert.equal(native.calls.at(-1)[2], task.id, 'getTask 调原生 (caller, id)')

  const updated = await facade.updateTask({ id: task.id, patch: { status: 'completed' } }, CALLER)
  assert.equal(updated.status, 'completed')

  const all = await facade.listTasks({}, CALLER)
  assert.equal(all.length, 1)
  assert.equal(native.calls.at(-1).length, 2, '原生 listTasks 只收 caller')
  const byStatus = await facade.listTasks({ status: 'completed' }, CALLER)
  assert.equal(byStatus.length, 1)
  const none = await facade.listTasks({ status: 'open' }, CALLER)
  assert.equal(none.length, 0)
})
