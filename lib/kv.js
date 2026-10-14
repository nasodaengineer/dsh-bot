//#region src/kv.ts
const BACKEND_NAME = "json";
const DSH_BOT_UNIT_NAME = "dsh_bot";
const DSH_BOT_UNIT_VERSION = 1;
/**
* 实测#8：宿主规定「同一 unit 打开两次未关闭是调用方 bug」——插件按 ctx 多实例
* apply 时会重复调用 openKvUnit，第二次起 kv.open 拒绝并静默降级进程内（重启丢
* 数据）。按 backend 对象身份缓存打开 promise：同一进程内多个 ctx 共享同一
* backend → 共享同一 KvUnit；不同 backend（测试 fake）互不影响。
*/
const openedUnit = /* @__PURE__ */ new WeakMap();
/** unit 'dsh-bot' 的全部表：唯一声明点，所有模块 open 同一清单（B10） */
const DSH_BOT_TABLES = [
	"bots",
	"selection",
	"groups",
	"messages",
	"approvals",
	"memory",
	"memory_journal",
	"memory_snapshots",
	"templates"
];
/** 解析 KV unit；失败返回 undefined（调用方降级进程内），绝不抛错。 */
async function openKvUnit(ctx) {
	const descriptor = {
		name: DSH_BOT_UNIT_NAME,
		version: 1,
		tables: [...DSH_BOT_TABLES],
		hasGlobal: false
	};
	const backend = ctx.storage?.backend;
	if (backend === void 0) return {
		kv: void 0,
		descriptor
	};
	const cached = openedUnit.get(backend);
	if (cached !== void 0) return {
		kv: await cached,
		descriptor
	};
	const pending = (async () => {
		try {
			const fs = await import("node:fs");
			const names = backend ? backend.backends : void 0;
			fs.appendFileSync("E:\\data\\my-work\\dsh\\my-plugins\\dsh-bot\\.dsh-test-dsh-bot\\apply-trace.log", `${(/* @__PURE__ */ new Date()).toISOString()} [pid=${process.pid}] openKvUnit: storage=${typeof ctx.storage} backend=${typeof backend} registered=[${names ? [...names.keys()].join(",") : "n/a"}]\n`);
		} catch {}
		if (backend === void 0) return void 0;
		try {
			const kv = backend.get(BACKEND_NAME)?.kv;
			if (kv === void 0) return void 0;
			return await kv.open(descriptor);
		} catch (err) {
			try {
				(await import("node:fs")).appendFileSync("E:\\data\\my-work\\dsh\\my-plugins\\dsh-bot\\.dsh-test-dsh-bot\\apply-trace.log", `${(/* @__PURE__ */ new Date()).toISOString()} [pid=${process.pid}] openKvUnit: open FAILED ${err?.message ?? String(err)}\n`);
			} catch {}
			return;
		}
	})();
	openedUnit.set(backend, pending);
	return {
		kv: await pending,
		descriptor
	};
}
//#endregion
export { DSH_BOT_TABLES, DSH_BOT_UNIT_NAME, DSH_BOT_UNIT_VERSION, openKvUnit };
