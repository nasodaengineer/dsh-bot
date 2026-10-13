//#region src/kv.ts
const BACKEND_NAME = "json";
const DSH_BOT_UNIT_NAME = "dsh-bot";
const DSH_BOT_UNIT_VERSION = 1;
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
	try {
		const kv = backend.get(BACKEND_NAME)?.kv;
		if (kv === void 0) return {
			kv: void 0,
			descriptor
		};
		return {
			kv: await kv.open(descriptor),
			descriptor
		};
	} catch {
		return {
			kv: void 0,
			descriptor
		};
	}
}
//#endregion
export { DSH_BOT_TABLES, DSH_BOT_UNIT_NAME, DSH_BOT_UNIT_VERSION, openKvUnit };
