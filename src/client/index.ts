/**
 * dsh-bot client 入口（票 #8 P2）。
 *
 * 纪律（research/dsh-plugin-skeleton.md，dsh-mmaping 验证过的形状）：
 * - bundle 从不 import @deepseek-ai/* 客户端包；运行时由 loader 的 module table 提供，
 *   react 统一通过 require()（ModuleLoader 协议的 factory(require) 参数）拿。
 * - 只挂真正用到的 inject：slots / locale / sidebarRight（三件）。
 * - 只注册已声明的 slot：conversation.view（群聊面板）、plugins.detail.section
 *   （Bot 详情页最小版）。注册进未声明 slot 会 throw（probe-assembly-facts §2）。
 * - sidebarRight.openTab 用 try/catch 包住：kind 未在宿主声明时降级为 warn，不抛穿。
 * - locale.register 双语（zh/en），NS = 'dsh-bot'。
 *
 * 数据通道（P3 接缝）：群聊/任务板数据经宿主 HTTP 通道接线后替换 loadGroups 的实现；
 * 当前面板渲染本地骨架与双语文案。
 */

interface SlotsService {
  inject(slot: string, effect: () => unknown): void
  register(row: unknown, component: unknown): unknown
}

interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): unknown
  bind(ns: string): (key: string) => string
}

interface SidebarRightService {
  openTab(kind: string, options?: { params?: Record<string, unknown> }): void
}

interface LoggerService {
  warn(message: string): unknown
}

interface ReactLike {
  createElement: (...args: unknown[]) => unknown
  useState?: <S>(initial: S) => [S, (value: S) => void]
  useEffect?: (effect: () => void | (() => void), deps?: readonly unknown[]) => void
}

export interface ClientContext {
  readonly logger?: LoggerService
  readonly slots?: SlotsService
  readonly locale?: LocaleService
  readonly sidebarRight?: SidebarRightService
  /** ModuleLoader 协议提供的平台模块表（react 等），由宿主 factory(require) 注入 */
  require?(name: string): unknown
}

export const inject = ['slots', 'locale', 'sidebarRight']

const NS = 'dsh-bot'

const DICTS = {
  zh: {
    'groups.title': 'Bot 团队群聊',
    'groups.empty': '还没有群聊。让 Lead Bot 建群，或在这里发起协作。',
    'groups.notice': '群聊面板：消息与审批卡每 5 秒轮询 dsh-bot 宿主端点。',
    'groups.messages': '消息',
    'groups.approvals': '待审批',
    'groups.approve': '批准',
    'groups.reject': '拒绝',
    'groups.noMessages': '暂无消息',
    'groups.noApprovals': '没有待审批卡',
    'groups.actionFailed': '审批操作失败（可能已被处理）',
    'detail.title': 'Bot 详情',
    'detail.openTab': '在右侧打开详情',
    'detail.unavailable': '右侧栏详情页不可用',
  },
  en: {
    'groups.title': 'Bot Team Group Chat',
    'groups.empty': 'No groups yet. Ask the Lead Bot to create one.',
    'groups.notice': 'Group panel: messages and approval cards poll the dsh-bot host endpoint every 5s.',
    'groups.messages': 'Messages',
    'groups.approvals': 'Pending approvals',
    'groups.approve': 'Approve',
    'groups.reject': 'Reject',
    'groups.noMessages': 'No messages',
    'groups.noApprovals': 'No pending approvals',
    'groups.actionFailed': 'Approval action failed (maybe already answered)',
    'detail.title': 'Bot Details',
    'detail.openTab': 'Open in right sidebar',
    'detail.unavailable': 'Right-sidebar detail tab unavailable',
  },
}

/** 群聊面板行（conversation.view 的 SlotRow 契约，照 dsh-mmaping 形状） */
interface ConversationViewRow {
  name: 'conversation.view'
  id: string
  label: () => string
  inject: (sessionId: string) => unknown
}

export interface GroupMessageView {
  readonly groupId: string
  readonly seq: number
  readonly from: string
  readonly text: string
  readonly at: string
}

export interface ApprovalView {
  readonly id: string
  readonly groupId: string
  readonly toolName: string
  readonly summary?: string
}

export interface GroupLoader {
  /** 票 #12 接线：走 POST /api/dsh-bot {endpoint:'group.list'}（会话 cookie 由浏览器自动带） */
  load(): Promise<Array<{ id: string; name: string; members: number }>>
  /** C12·群面板接线：轮询某群消息（group.messages 只读路由） */
  loadMessages(groupId: string): Promise<GroupMessageView[]>
  /** C12·群面板接线：轮询某群待批卡（group.approvals 只读路由） */
  loadApprovals(groupId: string): Promise<ApprovalView[]>
  /** C12·审批卡按钮：宿主代答（group.approve / group.reject） */
  answerApproval(id: string, approve: boolean): Promise<boolean>
}

/** 单条 /api/dsh-bot 通道调用：非 2xx / ok!==true 返回 undefined */
async function callEndpoint(endpoint: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetch('/api/dsh-bot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })
    if (!res.ok) return undefined
    const body = (await res.json()) as { ok?: boolean; result?: Record<string, unknown> }
    if (body?.ok !== true) return undefined
    return body.result
  } catch {
    return undefined
  }
}

/** 票 #12：数据通道接线——失败/未登录时降级空列表，面板不挂 */
export function createGroupLoader(_ctx: ClientContext): GroupLoader {
  return {
    async load() {
      const result = await callEndpoint('group.list', {})
      const groups = (result?.groups ?? []) as Array<{ id: string; name: string; memberIds?: readonly string[] }>
      return groups.map((g) => ({ id: g.id, name: g.name, members: g.memberIds?.length ?? 0 }))
    },
    async loadMessages(groupId) {
      const result = await callEndpoint('group.messages', { groupId })
      return ((result?.messages ?? []) as GroupMessageView[]).slice(-30)
    },
    async loadApprovals(groupId) {
      const result = await callEndpoint('group.approvals', { groupId })
      return (result?.approvals ?? []) as ApprovalView[]
    },
    async answerApproval(id, approve) {
      const result = await callEndpoint(approve ? 'group.approve' : 'group.reject', { id })
      return result !== undefined
    },
  }
}

export function apply(ctx: ClientContext): void {
  if (ctx.slots === undefined || ctx.locale === undefined) {
    ctx.logger?.warn('dsh-bot: client 缺少 slots/locale 服务，面板不注册')
    return
  }

  ctx.locale.register(NS, DICTS)
  const t = ctx.locale.bind(NS)

  // ---- conversation.view：群聊面板（minimal 版，数据通道 P3 接） ----
  const GroupPanel = createGroupPanelComponent(t, (message) => ctx.logger?.warn(message))
  const groupRow: ConversationViewRow = {
    name: 'conversation.view',
    id: 'dsh-bot-groups',
    label: () => t('groups.title'),
    inject: (sessionId: string) => ({ loader: createGroupLoader(ctx), sessionId }),
  }
  ctx.slots.inject('conversation.view', () => ctx.slots!.register(groupRow, GroupPanel))

  // ---- plugins.detail.section：Bot 详情页最小版 ----
  const BotDetailSection = createBotDetailComponent(ctx, t)
  const detailRow = { name: 'plugins.detail.section', id: 'dsh-bot-detail', label: () => t('detail.title') }
  ctx.slots.inject('plugins.detail.section', () => ctx.slots!.register(detailRow, BotDetailSection))
}

/** 群面板轮询周期（C12） */
const PANEL_POLL_MS = 5000

/** 群聊面板组件：react 从 module table require，不 import */
function createGroupPanelComponent(t: (key: string) => string, ctxWarn: (message: string) => void) {
  type GroupSummary = { id: string; name: string; members: number }
  return function GroupPanel(props: Record<string, unknown>, require?: (name: string) => unknown) {
    const react = (require ?? globalThisRequire)('react') as ReactLike
    const h = react.createElement
    const loader = (props as { loader?: Partial<GroupLoader> }).loader
    const groupsState = react.useState?.([] as GroupSummary[]) ?? [[], () => {}] as unknown as [GroupSummary[], (value: GroupSummary[]) => void]
    const messagesState = react.useState?.([] as GroupMessageView[]) ?? [[], () => {}] as unknown as [GroupMessageView[], (value: GroupMessageView[]) => void]
    const approvalsState = react.useState?.([] as ApprovalView[]) ?? [[], () => {}] as unknown as [ApprovalView[], (value: ApprovalView[]) => void]
    const [groups, setGroups] = groupsState
    const [messages, setMessages] = messagesState
    const [approvals, setApprovals] = approvalsState
    // C12：选中第一个群轮询其消息与待批卡（最小版；多群切换留接缝）
    const activeGroup = groups[0]
    react.useEffect?.(() => {
      let active = true
      const poll = async () => {
        const loaded = await loader?.load?.().catch(() => [] as GroupSummary[])
        if (!active || loaded === undefined || loaded.length === 0) return
        setGroups(loaded)
        const groupId = loaded[0].id
        const [msgs, aprs] = await Promise.all([
          loader?.loadMessages?.(groupId).catch(() => [] as GroupMessageView[]) ?? Promise.resolve([] as GroupMessageView[]),
          loader?.loadApprovals?.(groupId).catch(() => [] as ApprovalView[]) ?? Promise.resolve([] as ApprovalView[]),
        ])
        if (!active) return
        setMessages(msgs)
        setApprovals(aprs)
      }
      poll()
      const timer = setInterval(poll, PANEL_POLL_MS)
      return () => { active = false; clearInterval(timer) }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    const answer = (id: string, approve: boolean) => {
      void loader?.answerApproval?.(id, approve).then((ok) => {
        if (!ok) ctxWarn(`dsh-bot: ${t('groups.actionFailed')}`)
      })
    }
    return h('div', { className: 'dsh-bot-group-panel' },
      h('h3', null, t('groups.title')),
      groups.length === 0
        ? h('p', null, t('groups.empty'))
        : h('div', null,
            h('h4', null, `${activeGroup?.name ?? ''}`),
            h('h4', null, t('groups.messages')),
            messages.length === 0
              ? h('p', null, t('groups.noMessages'))
              : h('ul', null, messages.map((m) => h('li', { key: `${m.groupId}:${m.seq}` }, `${m.from}: ${m.text}`))),
            h('h4', null, t('groups.approvals')),
            approvals.length === 0
              ? h('p', null, t('groups.noApprovals'))
              : h('ul', null, approvals.map((a) => h('li', { key: a.id },
                  `${a.toolName}${a.summary !== undefined ? `：${a.summary}` : ''} `,
                  h('button', { type: 'button', onClick: () => answer(a.id, true) }, t('groups.approve')),
                  ' ',
                  h('button', { type: 'button', onClick: () => answer(a.id, false) }, t('groups.reject')),
                ))),
          ),
      h('p', null, t('groups.notice')),
    )
  }
}

/** Bot 详情页 section：最小版（openTab 按钮，宿主未声明 kind 时降级 warn） */
function createBotDetailComponent(ctx: ClientContext, t: (key: string) => string) {
  return function BotDetailSection(_props: Record<string, unknown>, require?: (name: string) => unknown) {
    const react = (require ?? globalThisRequire)('react') as ReactLike
    const h = react.createElement
    const openDetail = () => {
      try {
        ctx.sidebarRight?.openTab('dsh-bot-detail', {})
      } catch (error) {
        ctx.logger?.warn(`dsh-bot: ${t('detail.unavailable')}：${String(error)}`)
      }
    }
    return h('div', { className: 'dsh-bot-detail-section' },
      h('h3', null, t('detail.title')),
      h('button', { onClick: openDetail, type: 'button' }, t('detail.openTab')),
    )
  }
}

/** 无 loader 注入时的兜底（bundle 环境外不应走到这里） */
function globalThisRequire(name: string): unknown {
  const loader = (globalThis as { __ModuleLoader__?: { require?: (n: string) => unknown } }).__ModuleLoader__
  const mod = loader?.require?.(name)
  if (mod === undefined) throw new Error(`dsh-bot client: module '${name}' not in loader table`)
  return mod
}
