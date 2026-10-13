//#region src/bot-tools.ts
/** MCP server 名文法（预留 P2，先在这里冻结） */
const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
function isValidMcpServerName(name) {
	return MCP_SERVER_NAME_RE.test(name);
}
function assertMcpServerName(name) {
	if (!isValidMcpServerName(name)) throw new Error(`dsh-bot: 非法 MCP server 名 '${name}'（允许 1-32 位 [A-Za-z0-9_-]）`);
}
/** 公开工具名规则：mcp__<server>__<原始工具名> */
function mcpToolName(server, rawTool) {
	assertMcpServerName(server);
	return `mcp__${server}__${rawTool}`;
}
function createMcpBridge(configs) {
	for (const config of configs) assertMcpServerName(config.name);
	return {
		configured: [...configs],
		async connect(server) {
			assertMcpServerName(server);
			return false;
		}
	};
}
/** execute 统一包装：工具永不抛错 */
async function safeExecute(fn) {
	try {
		return await fn();
	} catch (error) {
		return { error: String(error instanceof Error ? error.message : error) };
	}
}
function attachBotTools(ctx, tools, deps) {
	const disposers = [];
	const names = [];
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	const register = (definition) => {
		try {
			disposers.push(tools.register(definition));
			names.push(definition.name);
		} catch (error) {
			warn(`注册工具 ${definition.name} 失败：${String(error)}`);
		}
	};
	register({
		name: "bot_roster_list",
		description: "列出 dsh-bot 名册里的全部 Bot（id/名字/角色/人格）",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		execute: () => safeExecute(async () => {
			return { bots: (await deps.roster.list()).map((b) => ({
				id: b.id,
				name: b.name,
				title: b.title,
				description: b.description
			})) };
		})
	});
	register({
		name: "bot_schedule_create",
		description: "为当前 Bot 创建定时例程（六形态之一：after_seconds | at | every_seconds | daily | weekly | cron），到点后 Bot 以 prompt 自动运行",
		parameters: {
			type: "object",
			properties: {
				title: { type: "string" },
				prompt: { type: "string" },
				after_seconds: { type: "number" },
				at: { type: "string" },
				every_seconds: { type: "number" },
				daily: {
					type: "object",
					properties: {
						time: { type: "string" },
						time_zone: { type: "string" }
					}
				},
				weekly: {
					type: "object",
					properties: {
						time: { type: "string" },
						time_zone: { type: "string" },
						weekdays: {
							type: "array",
							items: { type: "number" }
						}
					}
				},
				cron: {
					type: "object",
					properties: {
						expression: { type: "string" },
						time_zone: { type: "string" }
					}
				}
			},
			required: ["title", "prompt"]
		},
		execute: (args) => safeExecute(async () => {
			const schedules = deps.getSchedules();
			if (schedules === void 0) return { error: "dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）" };
			return schedules.create(args);
		})
	});
	register({
		name: "bot_schedule_delete",
		description: "删除一个已创建的 Bot 例程（按 record id）",
		parameters: {
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"]
		},
		execute: (args) => safeExecute(async () => {
			const schedules = deps.getSchedules();
			if (schedules === void 0) return { error: "dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）" };
			const id = args.id;
			if (typeof id !== "string" || id === "") return { error: "dsh-bot: 缺少例程 id" };
			return { deleted: await schedules.delete(id) };
		})
	});
	register({
		name: "bot_schedule_list",
		description: "列出当前 Bot 在 root Session 上的全部例程",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		execute: () => safeExecute(async () => {
			const schedules = deps.getSchedules();
			if (schedules === void 0) return { error: "dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）" };
			return { schedules: await schedules.list() };
		})
	});
	const getMemory = () => {
		const repo = deps.getMemory();
		if (repo === void 0) warn("记忆仓库未就绪");
		return repo;
	};
	const requireSelectedBot = () => {
		const id = deps.getSelectedBotId();
		if (id === void 0) warn("未选中 Bot，记忆工具需要先选定 Bot");
		return id;
	};
	register({
		name: "bot_memory_write",
		description: "为当前 Bot 写入一条长期记忆（主题 + 文本；单条有体积上限，超限请先摘要）",
		parameters: {
			type: "object",
			properties: {
				topic: { type: "string" },
				text: { type: "string" }
			},
			required: ["topic", "text"]
		},
		execute: (args) => safeExecute(async () => {
			const repo = getMemory();
			const botId = requireSelectedBot();
			if (repo === void 0 || botId === void 0) return { error: "dsh-bot: 记忆仓库未就绪或未选中 Bot" };
			const a = args;
			if (typeof a.topic !== "string" || typeof a.text !== "string") return { error: "dsh-bot: topic 与 text 必填" };
			return { entry: await repo.write(botId, {
				topic: a.topic,
				text: a.text
			}) };
		})
	});
	register({
		name: "bot_memory_read",
		description: "读取当前 Bot 某个主题下的全部记忆条目",
		parameters: {
			type: "object",
			properties: { topic: { type: "string" } },
			required: ["topic"]
		},
		execute: (args) => safeExecute(async () => {
			const repo = getMemory();
			const botId = requireSelectedBot();
			if (repo === void 0 || botId === void 0) return { error: "dsh-bot: 记忆仓库未就绪或未选中 Bot" };
			const topic = args.topic;
			if (typeof topic !== "string") return { error: "dsh-bot: topic 必填" };
			return { entries: await repo.read(botId, topic) };
		})
	});
	register({
		name: "bot_memory_search",
		description: "按关键词检索当前 Bot 的长期记忆（关键词全命中才返回）",
		parameters: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"]
		},
		execute: (args) => safeExecute(async () => {
			const repo = getMemory();
			const botId = requireSelectedBot();
			if (repo === void 0 || botId === void 0) return { error: "dsh-bot: 记忆仓库未就绪或未选中 Bot" };
			const query = args.query;
			if (typeof query !== "string") return { error: "dsh-bot: query 必填" };
			return { entries: await repo.search(botId, query) };
		})
	});
	register({
		name: "bot_memory_list",
		description: "列出当前 Bot 的全部记忆条目（按主题排序）",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		execute: () => safeExecute(async () => {
			const repo = getMemory();
			const botId = requireSelectedBot();
			if (repo === void 0 || botId === void 0) return { error: "dsh-bot: 记忆仓库未就绪或未选中 Bot" };
			return { entries: await repo.list(botId) };
		})
	});
	register({
		name: "bot_memory_forget",
		description: "删除当前 Bot 的一条记忆（按 topic + 条目 id）",
		parameters: {
			type: "object",
			properties: {
				topic: { type: "string" },
				id: { type: "string" }
			},
			required: ["topic", "id"]
		},
		execute: (args) => safeExecute(async () => {
			const repo = getMemory();
			const botId = requireSelectedBot();
			if (repo === void 0 || botId === void 0) return { error: "dsh-bot: 记忆仓库未就绪或未选中 Bot" };
			const a = args;
			if (typeof a.topic !== "string" || typeof a.id !== "string") return { error: "dsh-bot: topic 与 id 必填" };
			return { deleted: await repo.forget(botId, a.topic, a.id) };
		})
	});
	register({
		name: "bot_memory_journal",
		description: "查看当前 Bot 的记忆变更流水（write/forget），最新的在前",
		parameters: {
			type: "object",
			properties: { limit: { type: "number" } }
		},
		execute: (args) => safeExecute(async () => {
			const repo = getMemory();
			const botId = requireSelectedBot();
			if (repo === void 0 || botId === void 0) return { error: "dsh-bot: 记忆仓库未就绪或未选中 Bot" };
			const limit = args.limit;
			return { journal: await repo.journal(botId, typeof limit === "number" ? limit : void 0) };
		})
	});
	return {
		names,
		dispose() {
			for (const dispose of disposers.splice(0)) dispose();
			names.length = 0;
		}
	};
}
//#endregion
export { assertMcpServerName, attachBotTools, createMcpBridge, isValidMcpServerName, mcpToolName };
