import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
//#region src/diag.ts
/** 实测诊断：把装配/调用路径关键节点追加写盘，仅实测期使用（定位后移除）。 */
const dir = "E:\\data\\my-work\\dsh\\my-plugins\\dsh-bot\\.dsh-test-dsh-bot";
let ready;
function trace(message) {
	ready ??= mkdir(dir, { recursive: true }).catch(() => void 0);
	const where = `pid=${process.pid} cwd=${process.cwd()}`;
	ready.then(() => appendFile(join(dir, "apply-trace.log"), `${(/* @__PURE__ */ new Date()).toISOString()} [${where}] ${message}\n`).catch(() => void 0));
}
//#endregion
export { trace as t };
