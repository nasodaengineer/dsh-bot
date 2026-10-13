/**
 * 人格注入：ctx.systemPrompt.section(...) 把 Name/Title/Description 拼进提示词段。
 * order 100：在人设前缀（DEPLOYMENT_PERSONA_PREFIX = 0）之后、PLAN_POLICY（500）之前。
 * section 注册返回的是 Cordis effect disposer（dsh-system-prompt/index.d.ts），dispose 生命周期
 * 交给注册方；名册为空时 provider 返回空文本，渲染层会丢弃空段。
 */
import type { BotIdentity, PromptSection } from './types.js'
import type { IdentityStore } from './identity.js'

export const PERSONA_SECTION_NAME = 'dsh-bot:persona'
export const PERSONA_SECTION_ORDER = 100

export interface PersonaSelection {
  /** 当前选中的 Bot id；undefined 时回退到名册第一个 Bot */
  selectedId(): string | undefined
}

function renderBot(identity: BotIdentity): string {
  const lines = [`Name: ${identity.name}`]
  if (identity.title) lines.push(`Title: ${identity.title}`)
  if (identity.description) lines.push(`Description: ${identity.description}`)
  return lines.join('\n')
}

export function personaSection(store: IdentityStore, selection: PersonaSelection): PromptSection {
  return {
    name: PERSONA_SECTION_NAME,
    order: PERSONA_SECTION_ORDER,
    text: () => {
      // section provider 是同步求值的（AssembleContext），所以读同步缓存 listSync
      const bots = store.listSync()
      const picked = bots.find((bot) => bot.id === selection.selectedId()) ?? bots[0]
      return picked === undefined ? '' : renderBot(picked)
    },
  }
}
