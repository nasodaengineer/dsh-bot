//#region src/template.ts
const BACKEND_NAME = "json";
const UNIT_NAME = "dsh-bot";
const UNIT_VERSION = 1;
const TABLE_NAME = "templates";
async function openTables(ctx) {
	const backend = ctx.storage?.backend;
	if (backend === void 0) return void 0;
	try {
		const kv = backend.get(BACKEND_NAME)?.kv;
		if (kv === void 0) return void 0;
		return await kv.open({
			name: UNIT_NAME,
			version: UNIT_VERSION,
			tables: [TABLE_NAME],
			hasGlobal: false
		});
	} catch {
		return;
	}
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
			const schedules = deps.getSchedules();
			if (schedules !== void 0) for (const record of await schedules.list()) scheduleTitles.push(record.title);
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
			} else for (const title of tpl.skills.scheduleTitles) try {
				await schedules.create({
					title,
					prompt: `（模板 ${tpl.id} 重建的例程：${title}）`,
					every_seconds: 86400
				});
				restoredSchedules += 1;
			} catch (error) {
				warn(`例程 '${title}' 重建失败：${String(error)}`);
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
export { createTemplateStore };
