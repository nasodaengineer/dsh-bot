import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgentTeamsFacade } from '../lib/agent-teams.js'

// 假 TeamService：记录每次调用的参数顺序，验证 caller 原样透传
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
    async spawnTeammate(options, caller) {
      calls.push(['spawnTeammate', options, caller])
      memberSeq += 1
      const member = { id: `member-${memberSeq}`, ...options }
      members.set(member.id, member)
      return member
    },
    async sendMessage(input, caller) {
      calls.push(['sendMessage', input, caller])
      return { ok: true }
    },
    async createTask(spec, caller) {
      calls.push(['createTask', spec, caller])
      taskSeq += 1
      const task = { id: `task-${taskSeq}`, status: 'open', ...spec }
      tasks.set(task.id, task)
      return task
    },
    async getTask(request, caller) {
      calls.push(['getTask', request, caller])
      return tasks.get(request.id)
    },
    async listTasks(filter, caller) {
      calls.push(['listTasks', filter, caller])
      return [...tasks.values()]
    },
    async updateTask(request, caller) {
      calls.push(['updateTask', request, caller])
      const task = tasks.get(request.id)
      if (task === undefined) throw new Error(`unknown task ${request.id}`)
      Object.assign(task, request.patch)
      return task
    },
    async waitForChange(filter, options, caller) {
      calls.push(['waitForChange', filter, options, caller])
      return { changed: true }
    },
    async interrupt(target, caller) {
      calls.push(['interrupt', target, caller])
      return { ok: true }
    },
  }
  return svc
}

const CALLER = { agent: 'live-caller-stub' }

test('agent-teams：每个方法都要求 caller 且原样透传（原生安全模型）', async () => {
  const native = fakeTeamService()
  const facade = createAgentTeamsFacade(native)

  const member = await facade.spawnTeammate({ name: 'alice' }, CALLER)
  assert.equal(member.id, 'member-1')
  assert.equal(native.calls[0][2], CALLER, 'caller 必须原样传给原生 spawnTeammate')

  await facade.sendMessage({ to: 'member-1', text: 'hi' }, CALLER)
  assert.equal(native.calls[1][2], CALLER)
  assert.equal(native.calls[1][1].text, 'hi')

  await facade.listMembers(CALLER)
  assert.equal(native.calls[2][1], CALLER)

  await facade.membership(CALLER)
  await facade.tryMembership(CALLER)
  await facade.interrupt('member-1', CALLER)
  await facade.waitForChange({}, { timeoutMs: 100 }, CALLER)
})

test('agent-teams：caller 缺失时抛错，绝不合成权限凭据', async () => {
  const facade = createAgentTeamsFacade(fakeTeamService())
  await assert.rejects(() => facade.spawnTeammate({ name: 'x' }, undefined), /caller/)
  await assert.rejects(() => facade.sendMessage({ to: 'a', text: 'b' }, undefined), /caller/)
  await assert.rejects(() => facade.listTasks({}, undefined), /caller/)
})

test('agent-teams：任务方法透传 spec/patch，返回原生记录', async () => {
  const native = fakeTeamService()
  const facade = createAgentTeamsFacade(native)
  const task = await facade.createTask({ title: '写文档', dependsOn: [] }, CALLER)
  assert.equal(task.status, 'open')
  const got = await facade.getTask({ id: task.id }, CALLER)
  assert.equal(got.title, '写文档')
  const updated = await facade.updateTask({ id: task.id, patch: { status: 'completed' } }, CALLER)
  assert.equal(updated.status, 'completed')
  const all = await facade.listTasks({}, CALLER)
  assert.equal(all.length, 1)
})
