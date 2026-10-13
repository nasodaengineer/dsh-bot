/**
 * dsh-bot client 占位入口（票 #5 · P0）。
 *
 * 本票只做 host 侧；客户端面板（Bot 详情页、名册 UI）是 P2 的事。
 * 这个文件只保证 `./client` 导出能编译、能被 dsh client bundle 流程加载，
 * 不注册任何 slot——写错 slot 名会静默不出现，P0 不冒险。
 *
 * 类型策略：本 bundle 从不 import @deepseek-ai/* 客户端包，运行时由
 * loader 的 module table 提供服务，所有 interface 是文档化契约的精确切片
 * （dsh-mmaping/src/client/types.ts 验证过的做法）。
 */

interface ClientContext {
  readonly logger?: { warn(message: string): unknown }
}

export const inject: string[] = []

export function apply(ctx: ClientContext): void {
  ctx.logger?.warn('dsh-bot: client 占位入口被加载（P2 之前不应有任何面板）')
}
