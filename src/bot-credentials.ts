/**
 * 票 #6·凭据：不自建 secrets，全部透传 ctx.credentials。
 *
 * 签名来源（0.2.1-alpha.2，dsh-credentials index.d.ts:129-191）：
 * resolve(ref)/describe(ref)/set(ref, value)/unset(ref)/listRecords()。
 * 纪律：ref 必须是 CredentialRef 文法（POSIX shell 标识符，可 'scope/id'）；
 * set 空值在宿主侧被拒，这里前置同样校验（空值请用 unset）。
 */
import type { CredentialsService, HostContext } from './types.js'

/** CredentialRef 文法：POSIX shell 标识符段，段内 [A-Za-z0-9_][A-Za-z0-9_-]*，可 'scope/id'（至多一层 scope） */
const CRED_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)?$/

export function isValidCredentialRef(ref: string): boolean {
  return CRED_REF_RE.test(ref)
}

export function assertCredentialRef(ref: string): void {
  if (!isValidCredentialRef(ref)) {
    throw new Error(`dsh-bot: 非法凭据引用 '${ref}'（应为 POSIX shell 标识符，可含一个 '/' 分隔 scope/id）`)
  }
}

export interface BotCredentialsRuntime {
  resolve(ref: string): Promise<{ value: string; source: string } | undefined>
  describe(ref: string): Promise<{ configured: boolean; source?: string }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
  listRecords(): Promise<readonly unknown[]>
}

export function attachBotCredentials(ctx: HostContext, credentials: CredentialsService): BotCredentialsRuntime {
  const warn = (message: string) => ctx.logger?.warn(`dsh-bot: ${message}`)

  return {
    async resolve(ref) {
      assertCredentialRef(ref)
      const resolved = await credentials.resolve(ref)
      if (resolved === undefined) return undefined
      return { value: resolved.value, source: resolved.source }
    },
    async describe(ref) {
      assertCredentialRef(ref)
      const info = await credentials.describe(ref)
      return { configured: info.configured, source: info.source }
    },
    async set(ref, value) {
      assertCredentialRef(ref)
      if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('dsh-bot: 凭据值不能为空；要清除请用 unset')
      }
      await credentials.set(ref, value)
    },
    async unset(ref) {
      assertCredentialRef(ref)
      await credentials.unset(ref)
    },
    async listRecords() {
      try {
        return await credentials.listRecords()
      } catch (error) {
        warn(`列凭据记录失败：${String(error)}`)
        return []
      }
    },
  }
}
