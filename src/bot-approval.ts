/**
 * 票 #6·审批：包装 ctx.approval（fail-closed）+ ctx.permissionPresets（三档预设）。
 *
 * 签名来源（0.2.1-alpha.2）：
 * - dsh-user-approval index.d.ts:116,135：request(req): Promise<ApprovalOutcome>；
 *   ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'。
 *   fail-closed：策略 'ask' 且无 answerer → 'unavailable'；唯一授权值 'allowed-once'。
 * - dsh-permission-presets index.d.ts:138,162,186：catalog()/current(session)/set(session, name)。
 */
import type { ApprovalOutcome, ApprovalService, HostContext, PermissionPresetsService } from './types.js'

/** fail-closed 判定：只有宿主显式给的一次性授权算「通过」 */
export function isGranted(outcome: ApprovalOutcome): boolean {
  return outcome === 'allowed-once'
}

export interface ApprovalDecision {
  readonly granted: boolean
  readonly outcome: ApprovalOutcome
}

export interface BotApprovalRuntime {
  /** 走宿主审批；unavailable（无 answerer）一律 granted=false，绝不放行 */
  request(input: { toolName: string; [key: string]: unknown }): Promise<ApprovalDecision>
  /** 三档预设目录（宿主 permissionPresets.catalog 的 name 列表） */
  listPresets(): Promise<string[]>
  currentPreset(session: unknown): Promise<string | undefined>
  /** 按目录校验后 set；未知档位抛错（不静默改权限） */
  applyPreset(session: unknown, name: string): Promise<string>
}

export function attachBotApproval(
  ctx: HostContext,
  opts: { approval: ApprovalService; permissionPresets?: PermissionPresetsService },
): BotApprovalRuntime {
  const { approval, permissionPresets } = opts

  return {
    async request(input) {
      const outcome = await approval.request({ tool: 'dsh-bot', ...input })
      // 'unavailable' 不是错误也不是放行：fail-closed，调用方应中止受保护动作。
      return { granted: isGranted(outcome), outcome }
    },
    async listPresets() {
      if (permissionPresets === undefined) {
        ctx.logger?.warn('dsh-bot: ctx.permissionPresets 服务缺失，预设目录不可用')
        return []
      }
      const catalog = await permissionPresets.catalog()
      return catalog.map((entry) => entry.name)
    },
    async currentPreset(session) {
      if (permissionPresets === undefined) return undefined
      const current = await permissionPresets.current(session)
      return current?.name
    },
    async applyPreset(session, name) {
      if (permissionPresets === undefined) {
        throw new Error('dsh-bot: ctx.permissionPresets 服务缺失，无法切换权限档位')
      }
      const names = await this.listPresets()
      if (!names.includes(name)) {
        throw new Error(`dsh-bot: 未知权限档位 '${name}'（可选：${names.join(', ')}）`)
      }
      return permissionPresets.set(session, name)
    },
  }
}
