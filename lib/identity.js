//#region src/identity.ts
const BACKEND_NAME = "json";
const UNIT_NAME = "dsh-bot";
const TABLE_NAME = "bots";
const UNIT_VERSION = 1;
/** 解析 KV unit；失败返回 undefined 并 warn 一次。 */
async function openUnit(backend) {
	if (backend === void 0) return void 0;
	let medium;
	try {
		medium = backend.get(BACKEND_NAME);
	} catch {
		return;
	}
	const kv = medium?.kv;
	if (kv === void 0) return void 0;
	return kv.open({
		name: UNIT_NAME,
		version: UNIT_VERSION,
		tables: [TABLE_NAME],
		hasGlobal: false
	});
}
async function createIdentityStore(ctx) {
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	let unit;
	try {
		unit = await openUnit(ctx.storage?.backend);
	} catch (error) {
		unit = void 0;
		warn(`打开 KV unit 失败，降级为进程内存储：${String(error)}`);
	}
	const memory = /* @__PURE__ */ new Map();
	let degraded = false;
	if (unit === void 0) {
		degraded = true;
		if (ctx.storage === void 0) warn("ctx.storage 服务缺失，Bot 身份降级为进程内存储，重启即丢");
	}
	if (unit !== void 0) {
		const records = (await unit.loadAll()).tables[TABLE_NAME] ?? {};
		for (const [key, value] of Object.entries(records)) memory.set(key, value);
	}
	return {
		async put(identity) {
			memory.set(identity.id, identity);
			if (!degraded) await unit.putRecord(TABLE_NAME, identity.id, identity);
		},
		async get(id) {
			return memory.get(id);
		},
		async list() {
			return [...memory.values()];
		},
		listSync() {
			return [...memory.values()];
		},
		async remove(id) {
			memory.delete(id);
			if (!degraded) await unit.deleteRecord(TABLE_NAME, id);
		}
	};
}
//#endregion
export { createIdentityStore };
