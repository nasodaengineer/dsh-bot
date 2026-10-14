import { openKvUnit } from "./kv.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
//#region src/memory.ts
/** journal 流水条数上限（C13：超出裁掉最旧；摘要压缩仍留接缝不做） */
const MAX_JOURNAL_RECORDS = 1e3;
/** 单条记忆体积上限（K 体积上限策略：超限拒绝，摘要压缩走 snapshot 接缝） */
const MAX_ENTRY_CHARS = 8192;
/** 每 Bot 条目数上限 */
const MAX_ENTRIES_PER_BOT = 500;
/** 快照保留数（旧的淘汰） */
const SNAPSHOT_KEEP = 20;
/**
* 摘要产物镜像目录（票 #15：用户指定的本地 mnemon 数据目录，绝不外发）。
* 这是固定目录锚点，不适用 agent.session.cwd 的路径纪律；写入必须 try/catch + warn 降级。
*/
const DEFAULT_MIRROR_DIR = "E:\\data\\my-work\\dsh\\mem-space";
/** 默认压缩批次（到顶时一次合并的最旧条数） */
const DEFAULT_COMPACT_BATCH = Math.floor(250);
/** 解析 KV unit（B5：走共享 openKvUnit）；失败返回 undefined（调用方降级进程内）。 */
async function openUnit(ctx) {
	return (await openKvUnit(ctx)).kv;
}
async function createMemoryRepo(ctx, options = {}) {
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	const compactBatch = Math.max(1, options.compactBatch ?? DEFAULT_COMPACT_BATCH);
	const compactThreshold = Math.max(compactBatch, options.compactThreshold ?? 500);
	const mirrorDir = options.mirrorDir ?? "E:\\data\\my-work\\dsh\\mem-space";
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
	async function appendJournal(action, fields) {
		seq += 1;
		const record = {
			seq,
			botId: fields.botId,
			action,
			entryId: fields.entryId,
			topic: fields.topic,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		journalRows.set(String(record.seq), record);
		if (kv !== void 0) await kv.putRecord("memory_journal", String(record.seq), record);
		if (journalRows.size > 1e3) {
			let oldestKey;
			let oldestSeq = Number.POSITIVE_INFINITY;
			for (const [key, row] of journalRows) if (row.seq < oldestSeq) {
				oldestSeq = row.seq;
				oldestKey = key;
			}
			if (oldestKey !== void 0) {
				journalRows.delete(oldestKey);
				if (kv !== void 0) await kv.deleteRecord("memory_journal", oldestKey);
			}
		}
	}
	/** 摘要产物镜像（票 #15）：JSON 落盘到本地 mnemon 数据目录；任何失败 warn 降级，不崩溃 */
	async function mirrorSummary(botId, summary, mergedCount) {
		try {
			const dir = join(mirrorDir, "dsh-bot", botId);
			await mkdir(dir, { recursive: true });
			const payload = {
				plugin: "dsh-bot",
				botId,
				summaryEntryId: summary.id,
				mergedCount,
				at: summary.createdAt,
				summary: summary.text
			};
			const file = join(dir, `${summary.createdAt.replace(/[:.]/g, "-")}-${summary.id}.json`);
			await writeFile(file, JSON.stringify(payload, null, 2), "utf8");
		} catch (error) {
			warn(`摘要镜像写入失败（目录 ${mirrorDir} 不可写？），降级跳过不崩溃：${String(error)}`);
		}
	}
	/** 最简摘要算法：首句拼接 + 计数（标注可替换为 LLM 通道） */
	function buildSummaryText(merged) {
		const header = `[压缩摘要] 合并 ${merged.length} 条最旧记忆（算法：首句拼接，可替换为 LLM 摘要）`;
		const lines = [];
		let size = header.length;
		for (const entry of merged) {
			const firstSentence = entry.text.split(/(?<=[。！？!?\n])/)[0]?.trim() ?? entry.text;
			const line = `- ${entry.topic}：${firstSentence}`;
			if (size + line.length + 1 > 8192) {
				lines.push("- …（更多已省略）");
				break;
			}
			lines.push(line);
			size += line.length + 1;
		}
		return [header, ...lines].join("\n");
	}
	async function newEntry(botId, topic, text) {
		const now = (/* @__PURE__ */ new Date()).toISOString();
		const entry = {
			id: `mem-${Date.now().toString(36)}-${seq + 1}-${Math.random().toString(36).slice(2, 6)}`,
			botId,
			topic,
			text,
			size: text.length,
			createdAt: now,
			updatedAt: now
		};
		entries.set(keyOf(botId, entry.id), entry);
		await persistPut(entry);
		return entry;
	}
	/** 摘要压缩核心：合并最旧一批为一条「摘要」条目，journal 落 compact 记录，镜像降级写盘 */
	async function compactEntries(botId) {
		const mine = [...entries.values()].filter((e) => e.botId === botId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		if (mine.length === 0) return void 0;
		const merged = mine.slice(0, Math.min(compactBatch, mine.length));
		const summary = await newEntry(botId, "摘要", buildSummaryText(merged));
		for (const entry of merged) {
			const key = keyOf(botId, entry.id);
			entries.delete(key);
			if (kv !== void 0) await kv.deleteRecord("memory", key);
		}
		await appendJournal("compact", {
			entryId: summary.id,
			topic: summary.topic,
			botId
		});
		await mirrorSummary(botId, summary, merged.length);
		return summary;
	}
	return {
		async write(botId, input) {
			const topic = input.topic.trim();
			if (topic === "") throw new Error("dsh-bot: 记忆 topic 不能为空");
			const text = input.text;
			if (text.length > 8192) throw new Error(`dsh-bot: 单条记忆体积超上限（${text.length} > ${MAX_ENTRY_CHARS} 字符），请先摘要压缩`);
			const mine = [...entries.values()].filter((e) => e.botId === botId);
			if (mine.length + 1 > compactThreshold) {
				await compactEntries(botId);
				if ([...entries.values()].filter((e) => e.botId === botId).length + 1 > compactThreshold) throw new Error(`dsh-bot: Bot '${botId}' 记忆条目数已达上限 ${compactThreshold}，压缩后仍满，请先整理（snapshot + forget）`);
			}
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
			await appendJournal("write", {
				entryId: entry.id,
				topic: entry.topic,
				botId: entry.botId
			});
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
			await appendJournal("forget", {
				entryId: entry.id,
				topic: entry.topic,
				botId: entry.botId
			});
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
		},
		async compact(botId) {
			return compactEntries(botId);
		}
	};
}
//#endregion
export { DEFAULT_COMPACT_BATCH, DEFAULT_MIRROR_DIR, MAX_ENTRIES_PER_BOT, MAX_ENTRY_CHARS, MAX_JOURNAL_RECORDS, createMemoryRepo };
