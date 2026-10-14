/**
 * 票 #12·HTTP 端点触达（票 #9 裁决范围：外部触达只做 HTTP 端点）。
 *
 * 注册路（票 #4 实测结论，research/probe-assembly-facts.md §3）：
 * `connection.fetch.register` 独占唯一 /api 通道 + 浏览器会话 cookie 认证；
 * webServer 是另一命名空间，本票不用。
 *
 * 沿 ds-bot 先例（research/ds-bot-architecture.md §E7）：单条精确路径
 * `POST /api/dsh-bot`，body `{ endpoint, payload }` 分发——比开多条通配路径稳。
 *
 * 路由（endpoint 取值）：
 * - group.message  群聊消息投递（curl 触发一次 Bot 运行的验收面）
 * - group.list     群列表（只读）
 * - task.list / task.get  任务板查询（只读）
 * - bot.list       Bot 名册只读（不含任何凭据字段）
 *
 * 服务未就绪 → 逐端点 503 JSON 降级，不抛穿；只挂 POST。
 */
import type { HostContext } from './types.js'
import { trace } from './diag.js'
import type { BotRoster } from './roster.js'
import type { GroupChatRuntime } from './groupchat.js'
import type { TaskBoard } from './taskboard.js'

export const ENDPOINT_PATH = '/api/dsh-bot'

export interface HttpEndpointDeps {
  readonly getGroups: () => GroupChatRuntime | undefined
  readonly getTasks: () => TaskBoard | undefined
  readonly getRoster: () => BotRoster | undefined
}

export interface HttpEndpointRuntime {
  readonly path: string
  /** 注销路由 */
  dispose(): void
}

interface FetchRoute {
  readonly path: string
  readonly methods: readonly string[]
  readonly requestBody: string
  fetch(request: Request): Promise<Response>
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

const caller = 'http-endpoint'

/** A4·from 白名单：1–64 个字符，仅限字母/数字/中文/空格和 - _ . · @ */
const FROM_PATTERN = /^[\p{Script=Han}a-zA-Z0-9\s\-_.·@]{1,64}$/u

export function isValidFrom(from: unknown): from is string {
  return typeof from === 'string' && FROM_PATTERN.test(from)
}

export function attachHttpEndpoint(ctx: HostContext, deps: HttpEndpointDeps): HttpEndpointRuntime {
  let disposeRoute: (() => void) | undefined
  // 实测#2 根因修复：此前在异步装配里裸读 ctx.connection——在未提供该服务的
  // cordis 树上会抛 `cannot get property "connection" without inject`，炸穿整个
  // 异步装配（人格段、工具注册全部中断）。改走运行期 ctx.inject(['connection'])：
  // 服务到齐即注册路由，缺失/后到由 cordis 重触发；端点缺席只降级自身，不影响装配。
  ctx.inject(['connection'], (services) => {
    const connection = (services as { connection?: { fetch: { register(route: FetchRoute): () => void } } }).connection
    if (connection === undefined) {
      trace('endpoint: inject(connection) 触发但服务缺失')
      ctx.logger?.warn(`dsh-bot: ctx.connection 服务缺失，${ENDPOINT_PATH} 端点不注册`)
      return
    }
    disposeRoute = connection.fetch.register(buildRoute())
    trace('endpoint: /api/dsh-bot 路由注册成功')
  })

  async function dispatch(endpoint: string, payload: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
    switch (endpoint) {
      case 'group.message': {
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        // 实测#7：创建路径晚到可 await 重试（A2：仍不可用则拒绝服务，不假装在工作）
        if (!(await groups.ensureReady())) return { status: 503, body: { ok: false, error: '群聊载体 Session 不可用' } }
        const p = payload as { groupId?: unknown; from?: unknown; text?: unknown } | undefined
        if (typeof p?.groupId !== 'string' || typeof p?.text !== 'string') {
          return { status: 400, body: { ok: false, error: 'groupId 与 text 必填' } }
        }
        // A4·from 白名单校验：非法直接 400，不入群史
        if (!isValidFrom(p.from)) {
          return { status: 400, body: { ok: false, error: 'from 非法（1–64 字符，仅字母/数字/中文/空格/-_·.@）' } }
        }
        const result = await groups.postMessage({
          groupId: p.groupId,
          from: p.from,
          text: p.text,
        })
        return { status: 200, body: { ok: true, result } }
      }
      case 'group.messages': {
        // C12·群面板消息读取（只读）
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        const groupId = (payload as { groupId?: unknown } | undefined)?.groupId
        if (typeof groupId !== 'string') return { status: 400, body: { ok: false, error: 'groupId 必填' } }
        const exists = (await groups.listGroups()).some((g) => g.id === groupId)
        if (!exists) return { status: 404, body: { ok: false, error: `群 '${groupId}' 不存在` } }
        return { status: 200, body: { ok: true, result: { messages: await groups.history(groupId) } } }
      }
      case 'group.approvals': {
        // C12·待批卡读取（只读）。修复轮·autoVerdict 闭环：这里消费 listApprovalCards
        // （待批卡 + full 档已自动判定的卡），群面板因此能看到「已自动判定 allowed/rejected」
        // 的完整结果——判定入口在 groupchat.requestApproval（full 档）→ listApprovalCards
        // → 本路由 → 宿主面板，闭环成立。
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        const groupId = (payload as { groupId?: unknown } | undefined)?.groupId
        if (typeof groupId !== 'string') return { status: 400, body: { ok: false, error: 'groupId 必填' } }
        return { status: 200, body: { ok: true, result: { approvals: groups.listApprovalCards(groupId) } } }
      }
      case 'group.approve':
      case 'group.reject': {
        // C12·宿主代答（人工批准/拒绝 → answerApproval）
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        const id = (payload as { id?: unknown } | undefined)?.id
        if (typeof id !== 'string' || id === '') return { status: 400, body: { ok: false, error: 'id 必填' } }
        try {
          await groups.answerApproval(id, endpoint === 'group.approve' ? 'allowed-once' : 'rejected')
        } catch (error) {
          return { status: 404, body: { ok: false, error: String(error instanceof Error ? error.message : error) } }
        }
        return { status: 200, body: { ok: true, result: { id, granted: endpoint === 'group.approve' } } }
      }
      case 'group.list': {
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        return { status: 200, body: { ok: true, result: { groups: await groups.listGroups() } } }
      }
      case 'group.create': {
        // 实测#6：此前建群只有 facade 入口，端点补上闭环（name/memberIds 必填）
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        if (!(await groups.ensureReady())) return { status: 503, body: { ok: false, error: '群聊载体 Session 不可用' } }
        const p = payload as { name?: unknown; memberIds?: unknown } | undefined
        if (typeof p?.name !== 'string' || p.name.trim() === '') {
          return { status: 400, body: { ok: false, error: 'name 必填' } }
        }
        if (!Array.isArray(p.memberIds) || p.memberIds.length === 0 || !p.memberIds.every((m) => typeof m === 'string' && m.trim() !== '')) {
          return { status: 400, body: { ok: false, error: 'memberIds 必填（非空字符串数组）' } }
        }
        const group = await groups.createGroup({ name: p.name.trim(), memberIds: p.memberIds.map((m) => (m as string).trim()) })
        return { status: 200, body: { ok: true, result: { group } } }
      }
      case 'task.list': {
        const tasks = deps.getTasks()
        if (tasks === undefined) return { status: 503, body: { ok: false, error: '任务板未就绪' } }
        const filter = (payload as { filter?: Record<string, unknown> } | undefined)?.filter
        return { status: 200, body: { ok: true, result: { tasks: await tasks.listTasks(filter, caller) } } }
      }
      case 'task.get': {
        const tasks = deps.getTasks()
        if (tasks === undefined) return { status: 503, body: { ok: false, error: '任务板未就绪' } }
        const id = (payload as { id?: unknown } | undefined)?.id
        if (typeof id !== 'string') return { status: 400, body: { ok: false, error: 'id 必填' } }
        const task = await tasks.getTask({ id }, caller)
        if (task === undefined) return { status: 404, body: { ok: false, error: `任务 '${id}' 不存在` } }
        return { status: 200, body: { ok: true, result: { task } } }
      }
      case 'bot.list': {
        const roster = deps.getRoster()
        if (roster === undefined) return { status: 503, body: { ok: false, error: '名册未就绪' } }
        // 只读投影：id/name/title/description/color，绝不携带凭据
        const bots = (await roster.list()).map((b) => ({
          id: b.id, name: b.name, title: b.title, description: b.description, ...(b.color !== undefined ? { color: b.color } : {}),
        }))
        return { status: 200, body: { ok: true, result: { bots } } }
      }
      default:
        return undefined
    }
  }

  function buildRoute(): FetchRoute {
    return {
    path: ENDPOINT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      trace(`endpoint.fetch: 收到请求 ${request.method} ${request.url}`)
      let raw: unknown
      try {
        raw = JSON.parse(await request.text())
      } catch {
        return json(400, { ok: false, error: '请求体必须是 JSON' })
      }
      const body = raw as { endpoint?: unknown; payload?: Record<string, unknown> }
      if (typeof body?.endpoint !== 'string') {
        return json(400, { ok: false, error: 'endpoint 字段必填' })
      }
      try {
        const handled = await dispatch(body.endpoint, body.payload)
        if (handled === undefined) return json(404, { ok: false, error: `未知 endpoint '${body.endpoint}'` })
        return json(handled.status, handled.body)
      } catch (error) {
        trace(`endpoint.fetch: '${body.endpoint}' 处理失败 ${String(error instanceof Error ? error.stack : error)}`)
        ctx.logger?.warn(`dsh-bot: 端点 '${body.endpoint}' 处理失败：${String(error)}`)
        return json(500, { ok: false, error: '端点处理失败' })
      }
    },
  }
  }
  return { path: ENDPOINT_PATH, dispose: () => { disposeRoute?.(); disposeRoute = undefined } }
}
