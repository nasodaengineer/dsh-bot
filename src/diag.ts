/** 实测诊断：把装配/调用路径关键节点追加写盘，仅实测期使用（定位后移除）。 */
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

// 绝对路径：工具可能在 cwd 不同的子进程里执行，相对路径会写到别处
const dir = 'E:\\data\\my-work\\dsh\\my-plugins\\dsh-bot\\.dsh-test-dsh-bot'
let ready: Promise<unknown> | undefined

export function trace(message: string): void {
  ready ??= mkdir(dir, { recursive: true }).catch(() => undefined)
  const where = `pid=${process.pid} cwd=${process.cwd()}`
  void ready.then(() =>
    appendFile(join(dir, 'apply-trace.log'), `${new Date().toISOString()} [${where}] ${message}\n`).catch(() => undefined),
  )
}
