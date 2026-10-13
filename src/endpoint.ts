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

export function attachHttpEndpoint(ctx: HostContext, deps: HttpEndpointDeps): HttpEndpointRuntime {
  const connection = (ctx as HostContext & { connection?: { fetch: { register(route: FetchRoute): () => void } } }).connection
  if (connection === undefined) {
    ctx.logger?.warn(`dsh-bot: ctx.connection 服务缺失，${ENDPOINT_PATH} 端点不注册`)
    return { path: ENDPOINT_PATH, dispose() {} }
  }

  async function dispatch(endpoint: string, payload: Record<string, unknown> | undefined): Promise<{ status: number; body: unknown } | undefined> {
    switch (endpoint) {
      case 'group.message': {
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        const p = payload as { groupId?: unknown; from?: unknown; text?: unknown } | undefined
        if (typeof p?.groupId !== 'string' || typeof p?.text !== 'string') {
          return { status: 400, body: { ok: false, error: 'groupId 与 text 必填' } }
        }
        const result = await groups.postMessage({
          groupId: p.groupId,
          from: typeof p.from === 'string' ? p.from : '外部调用',
          text: p.text,
        })
        return { status: 200, body: { ok: true, result } }
      }
      case 'group.list': {
        const groups = deps.getGroups()
        if (groups === undefined) return { status: 503, body: { ok: false, error: '群聊运行时未就绪' } }
        return { status: 200, body: { ok: true, result: { groups: await groups.listGroups() } } }
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

  const route: FetchRoute = {
    path: ENDPOINT_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
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
        ctx.logger?.warn(`dsh-bot: 端点 '${body.endpoint}' 处理失败：${String(error)}`)
        return json(500, { ok: false, error: '端点处理失败' })
      }
    },
  }

  const dispose = connection.fetch.register(route)
  return { path: ENDPOINT_PATH, dispose: () => dispose() }
}
