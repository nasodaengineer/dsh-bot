import { openKvUnit } from "./kv.js";
//#region src/template.ts
const TABLE_NAME = "templates";
/** C11：例程 prompt 序列化上限（超长截断并标记，导入按原样重建截断版） */
const MAX_SCHEDULE_PROMPT_CHARS = 2e3;
/** C11：ScheduleCreateRequest → 可序列化例程（完整 timing+prompt；超长 prompt 截断并标记） */
function serializeScheduleRequest(request) {
	const prompt = request.prompt.length > 2e3 ? request.prompt.slice(0, MAX_SCHEDULE_PROMPT_CHARS) : request.prompt;
	return {
		title: request.title,
		prompt,
		...request.prompt.length > 2e3 ? { promptTruncated: true } : {},
		...request.after_seconds !== void 0 ? { after_seconds: request.after_seconds } : {},
		...request.at !== void 0 ? { at: request.at } : {},
		...request.every_seconds !== void 0 ? { every_seconds: request.every_seconds } : {},
		...request.daily !== void 0 ? { daily: request.daily } : {},
		...request.weekly !== void 0 ? { weekly: request.weekly } : {},
		...request.cron !== void 0 ? { cron: request.cron } : {}
	};
}
async function openTables(ctx) {
	return (await openKvUnit(ctx)).kv;
}
function slugOf(name) {
	return name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-+|-+$/g, "") || "bot";
}
async function createTemplateStore(ctx, deps) {
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	let kv;
	try {
		kv = await openTables(ctx);
	} catch {
		kv = void 0;
	}
	if (kv === void 0 && ctx.storage !== void 0) warn("模板表打开 KV unit 失败，降级为进程内存储，重启即丢");
	const templates = /* @__PURE__ */ new Map();
	if (kv !== void 0) {
		const snapshot = await kv.loadAll();
		for (const [key, value] of Object.entries(snapshot.tables[TABLE_NAME] ?? {})) templates.set(key, value);
	}
	let importSeq = 0;
	let tplSeq = 0;
	async function persist(record) {
		if (kv !== void 0) await kv.putRecord(TABLE_NAME, record.id, record);
	}
	return {
		async exportTemplate(botId, options) {
			const bot = (await deps.roster.list()).find((b) => b.id === botId);
			if (bot === void 0) throw new Error(`dsh-bot: 未知 Bot '${botId}'，无法导出模板`);
			tplSeq += 1;
			const memoryEntries = [];
			if (options.includeMemory) {
				const repo = deps.getMemory();
				if (repo === void 0) warn("记忆仓库未就绪，模板不带记忆");
				else for (const entry of await repo.list(botId)) memoryEntries.push({
					topic: entry.topic,
					text: entry.text
				});
			}
			const scheduleTitles = [];
			const scheduleRequests = [];
			const schedules = deps.getSchedules();
			if (schedules !== void 0) for (const request of schedules.requests()) {
				scheduleRequests.push(serializeScheduleRequest(request));
				scheduleTitles.push(request.title);
			}
			const record = {
				id: `tpl-${Date.now().toString(36)}-${tplSeq}`,
				name: options.name ?? `${bot.name} 模板`,
				description: `从 Bot '${botId}' 导出的模板：${bot.title}`,
				sourceBotId: botId,
				persona: {
					name: bot.name,
					title: bot.title,
					description: bot.description,
					color: bot.color
				},
				skills: {
					scheduleTitles,
					schedules: scheduleRequests,
					mcpServerNames: [...deps.getMcpServerNames()]
				},
				includeMemory: options.includeMemory,
				memory: memoryEntries,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			templates.set(record.id, record);
			await persist(record);
			return record;
		},
		async importTemplate(templateId, options) {
			const tpl = templates.get(templateId);
			if (tpl === void 0) throw new Error(`dsh-bot: 未知模板 '${templateId}'`);
			importSeq += 1;
			const name = options.name ?? `${tpl.persona.name}-${importSeq}`;
			const botId = `${slugOf(name)}-tpl-${importSeq}`;
			const identity = {
				id: botId,
				name,
				title: tpl.persona.title,
				description: tpl.persona.description,
				...tpl.persona.color !== void 0 ? { color: tpl.persona.color } : {}
			};
			await deps.roster.create(identity);
			let restoredMemory = 0;
			if (tpl.includeMemory) {
				const repo = deps.getMemory();
				if (repo === void 0) warn("记忆仓库未就绪，模板记忆未还原");
				else for (const entry of tpl.memory) {
					await repo.write(botId, {
						topic: entry.topic,
						text: entry.text
					});
					restoredMemory += 1;
				}
			}
			let restoredSchedules = 0;
			const schedules = deps.getSchedules();
			if (schedules === void 0) {
				if (tpl.skills.scheduleTitles.length > 0) warn("schedule 服务未挂载，模板例程未重建（接缝：宿主开 Automation 后可用 bot_schedule_create 手工重建）");
			} else for (const request of tpl.skills.schedules) try {
				await schedules.create({
					...request,
					prompt: request.prompt
				});
				restoredSchedules += 1;
			} catch (error) {
				warn(`例程 '${request.title}' 重建失败：${String(error)}`);
			}
			const mcpRestored = false;
			if (tpl.skills.mcpServerNames.length > 0) warn(`模板登记的 MCP server [${tpl.skills.mcpServerNames.join(", ")}] 不随模板分发，需在宿主重新配置`);
			return {
				botId,
				restoredSchedules,
				restoredMemory,
				mcpRestored
			};
		},
		async list() {
			return [...templates.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
		},
		async get(templateId) {
			return templates.get(templateId);
		}
	};
}
//#endregion
export { MAX_SCHEDULE_PROMPT_CHARS, createTemplateStore, serializeScheduleRequest };
