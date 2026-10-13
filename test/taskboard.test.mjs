import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canClaim, createTaskBoard } from '../lib/taskboard.js'

test('taskboard：依赖全 completed 才可 claim（DAG 守卫）', () => {
  const tasks = [
    { id: 't1', status: 'completed' },
    { id: 't2', status: 'completed' },
    { id: 't3', status: 'open', dependsOn: ['t1', 't2'] },
    { id: 't4', status: 'open', dependsOn: ['t3'] },
    { id: 't5', status: 'open' },
  ]
  assert.equal(canClaim(tasks[2], tasks), true, '两个依赖都完成 → 可 claim')
  assert.equal(canClaim(tasks[3], tasks), false, '依赖 t3 未完成 → 不可 claim')
  assert.equal(canClaim(tasks[4], tasks), true, '无依赖 → 可 claim')
  assert.equal(canClaim(undefined, tasks), false, '未知任务 → 不可 claim')
})

function fakeNative() {
  const tasks = new Map()
  let seq = 0
  return {
    tasks,
    async createTask(spec, caller) {
      seq += 1
      const task = { id: `task-${seq}`, status: 'open', ...spec }
      tasks.set(task.id, task)
      return task
    },
    async getTask({ id }) {
      return tasks.get(id)
    },
    async listTasks() {
      return [...tasks.values()]
    },
    async updateTask({ id, patch }) {
      const task = tasks.get(id)
      if (task === undefined) throw new Error(`unknown task ${id}`)
      Object.assign(task, patch)
      return task
    },
    async waitForChange(_filter, _options, _caller) {
      return { changed: true }
    },
  }
}

const CALLER = { live: true }

test('taskboard：claimTask 在依赖未全完成时拒绝并说明原因', async () => {
  const board = createTaskBoard(fakeNative())
  const a = await board.createTask({ title: 'A' }, CALLER)
  const b = await board.createTask({ title: 'B', dependsOn: [a.id] }, CALLER)
  const refusal = await board.claimTask(b.id, CALLER)
  assert.equal(refusal.ok, false)
  assert.match(refusal.reason, /依赖/)
  const ok = await board.claimTask(a.id, CALLER)
  assert.equal(ok.ok, true)
  // A 完成后 B 可 claim
  await board.updateTask({ id: a.id, patch: { status: 'completed' } }, CALLER)
  const after = await board.claimTask(b.id, CALLER)
  assert.equal(after.ok, true)
})

test('taskboard：claim 成功即把任务标记 claimed 并记 owner', async () => {
  const native = fakeNative()
  const board = createTaskBoard(native)
  const t = await board.createTask({ title: 'T' }, CALLER)
  const res = await board.claimTask(t.id, CALLER)
  assert.equal(res.ok, true)
  const stored = native.tasks.get(t.id)
  assert.equal(stored.status, 'claimed')
  assert.equal(stored.owner, 'live-caller')
  assert.ok(stored.claimedBy !== undefined, '应记录 claim 来源（caller 标识）')
})

test('taskboard：waitForChange 透传 caller', async () => {
  const native = fakeNative()
  const calls = []
  const wrapped = { ...native, async waitForChange(f, o, c) { calls.push([f, o, c]); return native.waitForChange(f, o, c) } }
  const board = createTaskBoard(wrapped)
  await board.waitForChange({}, { timeoutMs: 50 }, CALLER)
  assert.equal(calls[0][2], CALLER)
})
