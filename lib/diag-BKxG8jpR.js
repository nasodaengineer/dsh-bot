import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
//#region src/diag.ts
/** 实测诊断：把装配路径关键节点追加写盘，仅实测期使用（不随正式版发布语义）。 */
const dir = join(".dsh-test-dsh-bot");
let ready;
function trace(message) {
	ready ??= mkdir(dir, { recursive: true }).catch(() => void 0);
	ready.then(() => appendFile(join(dir, "apply-trace.log"), `${(/* @__PURE__ */ new Date()).toISOString()} ${message}\n`).catch(() => void 0));
}
//#endregion
export { trace as t };
