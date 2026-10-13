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
    'groups.notice': '群聊面板：投递与审批卡由 dsh-bot 宿主侧驱动。',
    'detail.title': 'Bot 详情',
    'detail.openTab': '在右侧打开详情',
    'detail.unavailable': '右侧栏详情页不可用',
  },
  en: {
    'groups.title': 'Bot Team Group Chat',
    'groups.empty': 'No groups yet. Ask the Lead Bot to create one.',
    'groups.notice': 'Group panel: delivery and approval cards are driven host-side by dsh-bot.',
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

/** P3 接缝：数据通道接线后替换本函数（当前返回本地骨架） */
export function createGroupLoader(_ctx: ClientContext): {
  groups: Array<{ id: string; name: string; members: number }>
} {
  return { groups: [] }
}

export function apply(ctx: ClientContext): void {
  if (ctx.slots === undefined || ctx.locale === undefined) {
    ctx.logger?.warn('dsh-bot: client 缺少 slots/locale 服务，面板不注册')
    return
  }

  ctx.locale.register(NS, DICTS)
  const t = ctx.locale.bind(NS)

  // ---- conversation.view：群聊面板（minimal 版，数据通道 P3 接） ----
  const GroupPanel = createGroupPanelComponent(t)
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

/** 群聊面板组件：react 从 module table require，不 import */
function createGroupPanelComponent(t: (key: string) => string) {
  return function GroupPanel(props: Record<string, unknown>, require?: (name: string) => unknown) {
    const react = (require ?? globalThisRequire)('react') as ReactLike
    const h = react.createElement
    const loader = (props as { loader?: { groups: Array<{ id: string; name: string; members: number }> } }).loader
    const groups = loader?.groups ?? []
    return h('div', { className: 'dsh-bot-group-panel' },
      h('h3', null, t('groups.title')),
      groups.length === 0
        ? h('p', null, t('groups.empty'))
        : h('ul', null, groups.map((g) => h('li', { key: g.id }, `${g.name}（${g.members}）`))),
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
