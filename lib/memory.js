//#region src/memory.ts
const BACKEND_NAME = "json";
const UNIT_NAME = "dsh-bot";
const UNIT_VERSION = 1;
const TABLES = [
	"memory",
	"memory_journal",
	"memory_snapshots"
];
/** 单条记忆体积上限（K 体积上限策略：超限拒绝，摘要压缩走 snapshot 接缝） */
const MAX_ENTRY_CHARS = 8192;
/** 每 Bot 条目数上限 */
const MAX_ENTRIES_PER_BOT = 500;
/** 快照保留数（旧的淘汰） */
const SNAPSHOT_KEEP = 20;
/** 解析 KV unit；失败返回 undefined（调用方降级进程内）。 */
async function openUnit(ctx) {
	const backend = ctx.storage?.backend;
	if (backend === void 0) return void 0;
	try {
		const kv = backend.get(BACKEND_NAME)?.kv;
		if (kv === void 0) return void 0;
		return await kv.open({
			name: UNIT_NAME,
			version: UNIT_VERSION,
			tables: [...TABLES],
			hasGlobal: false
		});
	} catch {
		return;
	}
}
async function createMemoryRepo(ctx) {
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	let kv;
	try {
		kv = await openUnit(ctx);
	} catch (error) {
		kv = void 0;
		warn(`记忆仓库打开 KV unit 失败，降级为进程内存储：${String(error)}`);
	}
	if (kv === void 0 && ctx.storage !== void 0) warn("记忆仓库打开 KV unit 失败，降级为进程内存储，重启即丢");
	const entries = /* @__PURE__ */ new Map();
	const journalRows = /* @__PURE__ */ new Map();
	const snapshots = /* @__PURE__ */ new Map();
	let seq = 0;
	if (kv !== void 0) {
		const snapshot = await kv.loadAll();
		for (const value of Object.values(snapshot.tables["memory"] ?? {})) {
			const entry = value;
			entries.set(`${entry.botId}:${entry.id}`, entry);
		}
		for (const [key, value] of Object.entries(snapshot.tables["memory_journal"] ?? {})) {
			journalRows.set(key, value);
			const n = Number(key);
			if (Number.isFinite(n) && n > seq) seq = n;
		}
		for (const [key, value] of Object.entries(snapshot.tables["memory_snapshots"] ?? {})) snapshots.set(key, value);
	}
	const keyOf = (botId, id) => `${botId}:${id}`;
	function listEntries(botId) {
		return [...entries.values()].filter((e) => e.botId === botId).sort((a, b) => a.topic.localeCompare(b.topic) || a.createdAt.localeCompare(b.createdAt));
	}
	function buildIndex(botId, mine) {
		const topics = /* @__PURE__ */ new Map();
		for (const entry of mine) {
			const list = topics.get(entry.topic) ?? [];
			list.push(entry);
			topics.set(entry.topic, list);
		}
		const lines = [`# 记忆索引（${botId}）`, ""];
		for (const [topic, list] of topics) {
			lines.push(`## ${topic}`);
			for (const entry of list) lines.push(`- ${entry.text}`);
			lines.push("");
		}
		return lines.join("\n").trimEnd();
	}
	async function persistPut(entry) {
		if (kv !== void 0) await kv.putRecord("memory", keyOf(entry.botId, entry.id), entry);
	}
	async function appendJournal(action, entry) {
		seq += 1;
		const record = {
			seq,
			botId: entry.botId,
			action,
			entryId: entry.id,
			topic: entry.topic,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		journalRows.set(String(record.seq), record);
		if (kv !== void 0) await kv.putRecord("memory_journal", String(record.seq), record);
	}
	return {
		async write(botId, input) {
			const topic = input.topic.trim();
			if (topic === "") throw new Error("dsh-bot: 记忆 topic 不能为空");
			const text = input.text;
			if (text.length > 8192) throw new Error(`dsh-bot: 单条记忆体积超上限（${text.length} > ${MAX_ENTRY_CHARS} 字符），请先摘要压缩`);
			const mine = [...entries.values()].filter((e) => e.botId === botId);
			if (mine.length >= 500) throw new Error(`dsh-bot: Bot '${botId}' 记忆条目数已达上限 500，请先整理（snapshot + forget）`);
			const now = (/* @__PURE__ */ new Date()).toISOString();
			const existing = mine.find((e) => e.topic === topic && e.text === text);
			const entry = {
				id: existing?.id ?? `mem-${Date.now().toString(36)}-${seq + 1}-${Math.random().toString(36).slice(2, 6)}`,
				botId,
				topic,
				text,
				size: text.length,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now
			};
			entries.set(keyOf(botId, entry.id), entry);
			await persistPut(entry);
			await appendJournal("write", entry);
			return entry;
		},
		async read(botId, topic) {
			return [...entries.values()].filter((e) => e.botId === botId && e.topic === topic).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		async search(botId, query) {
			const tokens = query.split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t !== "");
			if (tokens.length === 0) return [];
			const scored = [];
			for (const entry of entries.values()) {
				if (entry.botId !== botId) continue;
				const haystack = `${entry.topic} ${entry.text}`.toLowerCase();
				let hits = 0;
				let all = true;
				for (const token of tokens) if (haystack.includes(token)) hits += 1;
				else all = false;
				if (all) scored.push({
					entry,
					hits
				});
			}
			return scored.sort((a, b) => b.hits - a.hits).map((s) => s.entry);
		},
		async list(botId) {
			return listEntries(botId);
		},
		async forget(botId, topic, entryId) {
			const key = keyOf(botId, entryId);
			const entry = entries.get(key);
			if (entry === void 0 || entry.topic !== topic) return false;
			entries.delete(key);
			if (kv !== void 0) await kv.deleteRecord("memory", key);
			await appendJournal("forget", entry);
			return true;
		},
		async indexText(botId) {
			return buildIndex(botId, listEntries(botId));
		},
		async journal(botId, limit = 50) {
			return [...journalRows.values()].filter((r) => r.botId === botId).sort((a, b) => b.seq - a.seq).slice(0, limit);
		},
		async snapshot(botId) {
			const index = buildIndex(botId, listEntries(botId));
			seq += 1;
			const record = {
				id: `snap-${seq}`,
				botId,
				index,
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			const key = keyOf(botId, record.id);
			snapshots.set(key, record);
			if (kv !== void 0) await kv.putRecord("memory_snapshots", key, record);
			const mine = [...snapshots.entries()].filter(([k, v]) => v.botId === botId).sort((a, b) => b[1].at.localeCompare(a[1].at));
			for (const [k] of mine.slice(SNAPSHOT_KEEP)) {
				snapshots.delete(k);
				if (kv !== void 0) kv.deleteRecord("memory_snapshots", k);
			}
			return record;
		}
	};
}
//#endregion
export { MAX_ENTRIES_PER_BOT, MAX_ENTRY_CHARS, createMemoryRepo };
