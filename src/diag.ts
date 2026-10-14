/** 实测诊断：把装配路径关键节点追加写盘，仅实测期使用（不随正式版发布语义）。 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const dir = join('.dsh-test-dsh-bot')
let ready: Promise<unknown> | undefined

export function trace(message: string): void {
  ready ??= mkdir(dir, { recursive: true }).catch(() => undefined)
  void ready.then(() =>
    appendFile(join(dir, 'apply-trace.log'), `${new Date().toISOString()} ${message}\n`).catch(() => undefined),
  )
}
