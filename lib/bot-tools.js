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
