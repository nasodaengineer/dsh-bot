import { createAgentTeamsFacade } from "./agent-teams.js";
import { attachBotApproval } from "./bot-approval.js";
import { attachBotCredentials } from "./bot-credentials.js";
import { t as trace } from "./diag-RBR7u0y4.js";
import { attachBotTools, createMcpBridge } from "./bot-tools.js";
import { createJevJudge, resolveJevBackend } from "./jev.js";
import { createGroupChatRuntime, createRootSessionCarrier } from "./groupchat.js";
import { createIdentityStore } from "./identity.js";
import { createRoster } from "./roster.js";
import { personaSection } from "./persona.js";
import { attachModelRuntime } from "./model.js";
import { attachBotSchedules } from "./schedules.js";
import { createTaskBoard } from "./taskboard.js";
import { createMemoryRepo } from "./memory.js";
import { createTemplateStore } from "./template.js";
import { randomUUID } from "node:crypto";
//#region src/endpoint.ts
const ENDPOINT_PATH = "/api/dsh-bot";
const json = (status, body) => new Response(JSON.stringify(body), {
	status,
	headers: { "content-type": "application/json; charset=utf-8" }
});
const caller = "http-endpoint";
/** A4·from 白名单：1–64 个字符，仅限字母/数字/中文/空格和 - _ . · @ */
const FROM_PATTERN = /^[\p{Script=Han}a-zA-Z0-9\s\-_.·@]{1,64}$/u;
function isValidFrom(from) {
	return typeof from === "string" && FROM_PATTERN.test(from);
}
function attachHttpEndpoint(ctx, deps) {
	let disposeRoute;
	ctx.inject(["connection"], (services) => {
		const connection = services.connection;
		if (connection === void 0) {
			trace("endpoint: inject(connection) 触发但服务缺失");
			ctx.logger?.warn(`dsh-bot: ctx.connection 服务缺失，${ENDPOINT_PATH} 端点不注册`);
			return;
		}
		disposeRoute = connection.fetch.register(buildRoute());
		trace("endpoint: /api/dsh-bot 路由注册成功");
	});
	async function dispatch(endpoint, payload) {
		switch (endpoint) {
			case "group.message": {
				const groups = deps.getGroups();
				if (groups === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊运行时未就绪"
					}
				};
				if (!await groups.ensureReady()) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊载体 Session 不可用"
					}
				};
				const p = payload;
				if (typeof p?.groupId !== "string" || typeof p?.text !== "string") return {
					status: 400,
					body: {
						ok: false,
						error: "groupId 与 text 必填"
					}
				};
				if (!isValidFrom(p.from)) return {
					status: 400,
					body: {
						ok: false,
						error: "from 非法（1–64 字符，仅字母/数字/中文/空格/-_·.@）"
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: await groups.postMessage({
							groupId: p.groupId,
							from: p.from,
							text: p.text
						})
					}
				};
			}
			case "group.messages": {
				const groups = deps.getGroups();
				if (groups === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊运行时未就绪"
					}
				};
				const groupId = payload?.groupId;
				if (typeof groupId !== "string") return {
					status: 400,
					body: {
						ok: false,
						error: "groupId 必填"
					}
				};
				if (!(await groups.listGroups()).some((g) => g.id === groupId)) return {
					status: 404,
					body: {
						ok: false,
						error: `群 '${groupId}' 不存在`
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: { messages: await groups.history(groupId) }
					}
				};
			}
			case "group.approvals": {
				const groups = deps.getGroups();
				if (groups === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊运行时未就绪"
					}
				};
				const groupId = payload?.groupId;
				if (typeof groupId !== "string") return {
					status: 400,
					body: {
						ok: false,
						error: "groupId 必填"
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: { approvals: groups.listApprovalCards(groupId) }
					}
				};
			}
			case "group.approve":
			case "group.reject": {
				const groups = deps.getGroups();
				if (groups === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊运行时未就绪"
					}
				};
				const id = payload?.id;
				if (typeof id !== "string" || id === "") return {
					status: 400,
					body: {
						ok: false,
						error: "id 必填"
					}
				};
				try {
					await groups.answerApproval(id, endpoint === "group.approve" ? "allowed-once" : "rejected");
				} catch (error) {
					return {
						status: 404,
						body: {
							ok: false,
							error: String(error instanceof Error ? error.message : error)
						}
					};
				}
				return {
					status: 200,
					body: {
						ok: true,
						result: {
							id,
							granted: endpoint === "group.approve"
						}
					}
				};
			}
			case "group.list": {
				const groups = deps.getGroups();
				if (groups === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊运行时未就绪"
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: { groups: await groups.listGroups() }
					}
				};
			}
			case "group.create": {
				const groups = deps.getGroups();
				if (groups === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊运行时未就绪"
					}
				};
				if (!await groups.ensureReady()) return {
					status: 503,
					body: {
						ok: false,
						error: "群聊载体 Session 不可用"
					}
				};
				const p = payload;
				if (typeof p?.name !== "string" || p.name.trim() === "") return {
					status: 400,
					body: {
						ok: false,
						error: "name 必填"
					}
				};
				if (!Array.isArray(p.memberIds) || p.memberIds.length === 0 || !p.memberIds.every((m) => typeof m === "string" && m.trim() !== "")) return {
					status: 400,
					body: {
						ok: false,
						error: "memberIds 必填（非空字符串数组）"
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: { group: await groups.createGroup({
							name: p.name.trim(),
							memberIds: p.memberIds.map((m) => m.trim())
						}) }
					}
				};
			}
			case "task.list": {
				const tasks = deps.getTasks();
				if (tasks === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "任务板未就绪"
					}
				};
				const filter = payload?.filter;
				try {
					return {
						status: 200,
						body: {
							ok: true,
							result: { tasks: await tasks.listTasks(filter, caller) }
						}
					};
				} catch (error) {
					return {
						status: 503,
						body: {
							ok: false,
							error: `任务板需要 live Team 成员身份（HTTP 端点不合成凭据）：${String(error instanceof Error ? error.message : error)}`
						}
					};
				}
			}
			case "task.get": {
				const tasks = deps.getTasks();
				if (tasks === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "任务板未就绪"
					}
				};
				const id = payload?.id;
				if (typeof id !== "string") return {
					status: 400,
					body: {
						ok: false,
						error: "id 必填"
					}
				};
				let task;
				try {
					task = await tasks.getTask({ id }, caller);
				} catch (error) {
					return {
						status: 503,
						body: {
							ok: false,
							error: `任务板需要 live Team 成员身份（HTTP 端点不合成凭据）：${String(error instanceof Error ? error.message : error)}`
						}
					};
				}
				if (task === void 0) return {
					status: 404,
					body: {
						ok: false,
						error: `任务 '${id}' 不存在`
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: { task }
					}
				};
			}
			case "bot.list": {
				const roster = deps.getRoster();
				if (roster === void 0) return {
					status: 503,
					body: {
						ok: false,
						error: "名册未就绪"
					}
				};
				return {
					status: 200,
					body: {
						ok: true,
						result: { bots: (await roster.list()).map((b) => ({
							id: b.id,
							name: b.name,
							title: b.title,
							description: b.description,
							...b.color !== void 0 ? { color: b.color } : {}
						})) }
					}
				};
			}
			default: return;
		}
	}
	function buildRoute() {
		return {
			path: ENDPOINT_PATH,
			methods: ["POST"],
			requestBody: "buffered",
			async fetch(request) {
				trace(`endpoint.fetch: 收到请求 ${request.method} ${request.url}`);
				let raw;
				try {
					raw = JSON.parse(await request.text());
				} catch {
					return json(400, {
						ok: false,
						error: "请求体必须是 JSON"
					});
				}
				const body = raw;
				if (typeof body?.endpoint !== "string") return json(400, {
					ok: false,
					error: "endpoint 字段必填"
				});
				try {
					const handled = await dispatch(body.endpoint, body.payload);
					if (handled === void 0) return json(404, {
						ok: false,
						error: `未知 endpoint '${body.endpoint}'`
					});
					return json(handled.status, handled.body);
				} catch (error) {
					trace(`endpoint.fetch: '${body.endpoint}' 处理失败 ${String(error instanceof Error ? error.stack : error)}`);
					ctx.logger?.warn(`dsh-bot: 端点 '${body.endpoint}' 处理失败：${String(error)}`);
					return json(500, {
						ok: false,
						error: "端点处理失败"
					});
				}
			}
		};
	}
	return {
		path: ENDPOINT_PATH,
		dispose: () => {
			disposeRoute?.();
			disposeRoute = void 0;
		}
	};
}
//#endregion
//#region src/index.ts
/**
* dsh-bot host 入口（票 #5 P0 · 票 #6 P1）。
*
* 静态 inject 仍只放 P0 真正用到的三个服务（路线图 §6 纪律：不一次性 inject 一把）：
* - agentPresets：Bot 名册的原生装配面（register/list/mount/select）
* - systemPrompt：人格段注入
* - storage：Bot 持久身份的 KV 存储
*
* P1 五个新服务（llm/sessionController/tools/credentials/approval/schedule）全部走
* 运行期 ctx.inject([...], attach)：它们要么是条件挂载（schedule 只在 Automation
* tasks bundle 打开时存在），要么插件可无此服务降级运行；运行期订阅不阻塞 fiber，
* 服务掉了会重挂（boundaries §1.2/§1.4，ds-bot 同款先例）。
*
* 分层混合决策（票 #2/#3）：spawn/消息/任务板归 ctx.agentTeams（P2 做）；
* Bot 持久身份走自有 KV 状态。本票不做任何 client 侧注入（P2 的事）。
*/
const name = "dsh-bot";
const inject = [
	"agentPresets",
	"systemPrompt",
	"storage"
];
function apply(ctx, options = {}) {
	const runtime = {};
	let storeRef;
	const mcp = createMcpBridge(options.mcpServers ?? []);
	function handleAgentCreated(payload) {
		const agent = payload.agent;
		if (agent?.inject === void 0) return;
		const selected = runtime.selectedId;
		(async () => {
			const roster = runtime.roster;
			if (roster === void 0) return;
			const bots = await roster.list();
			const bot = selected !== void 0 ? bots.find((b) => b.id === selected) : void 0;
			if (bot === void 0) return;
			agent.inject?.({
				id: randomUUID(),
				role: "user",
				content: [{
					type: "text",
					text: `[dsh-bot] 当前 Bot：${bot.name}（${bot.title}）\n${bot.description}`
				}],
				source: { kind: "plugin:dsh-bot" }
			});
		})().catch((error) => {
			ctx.logger?.warn(`dsh-bot: agent/created 异步注入失败：${String(error)}`);
		});
	}
	/** 实测#5：selection 提前建（attachRuntimes 的 bot_select 工具依赖它），门面直接引用 */
	const selection = {
		async selectBot(id) {
			runtime.selectedId = id;
			await storeRef?.putSelectedId(id);
		},
		selectedBotId() {
			return runtime.selectedId;
		},
		async selectedBot() {
			const roster = runtime.roster;
			const id = runtime.selectedId;
			if (roster === void 0 || id === void 0) return void 0;
			return roster.list().then((bots) => bots.find((b) => b.id === id));
		}
	};
	(async () => {
		trace("apply: async 装配开始");
		const store = await createIdentityStore(ctx);
		const roster = await createRoster(ctx, store);
		runtime.roster = roster;
		trace("apply: identity+roster 完成");
		storeRef = store;
		runtime.selectedId = await store.getSelectedId();
		runtime.memory = await createMemoryRepo(ctx);
		runtime.templates = await createTemplateStore(ctx, {
			roster,
			getMemory: () => runtime.memory,
			getSchedules: () => runtime.schedules,
			getMcpServerNames: () => mcp.configured.map((c) => c.name)
		});
		runtime.endpoint = attachHttpEndpoint(ctx, {
			getGroups: () => runtime.groups,
			getTasks: () => runtime.tasks,
			getRoster: () => runtime.roster
		});
		if (ctx.systemPrompt !== void 0) ctx.systemPrompt.section(personaSection(store, { selectedId: () => runtime.selectedId }, { warn: (message) => ctx.logger?.warn(message) }));
		else ctx.logger?.warn("dsh-bot: ctx.systemPrompt 服务缺失，人格段不注入");
		attachRuntimes(ctx, runtime, store, options, selection);
		trace("apply: attachRuntimes 完成（inject 订阅已注册）");
	})().catch((error) => {
		trace(`apply: 初始化失败 ${String(error)}`);
		ctx.logger?.warn(`dsh-bot: 初始化失败：${String(error)}`);
	});
	onAgentCreated(ctx, handleAgentCreated);
	return {
		get roster() {
			return runtime.roster;
		},
		get models() {
			return runtime.models;
		},
		get botTools() {
			return runtime.botTools;
		},
		get credentials() {
			return runtime.credentials;
		},
		get approval() {
			return runtime.approval;
		},
		get schedules() {
			return runtime.schedules;
		},
		get teams() {
			return runtime.teams;
		},
		get tasks() {
			return runtime.tasks;
		},
		get groups() {
			return runtime.groups;
		},
		get memory() {
			return runtime.memory;
		},
		get templates() {
			return runtime.templates;
		},
		get endpoint() {
			return runtime.endpoint;
		},
		mcp,
		selection
	};
}
/** P1/P2 运行时装配：ctx.inject 订阅（见文件头注释的取舍理由） */
function attachRuntimes(ctx, runtime, store, options, selection) {
	ctx.inject(["llm", "sessionController"], (services) => {
		runtime.models = attachModelRuntime(ctx, {
			llm: services.llm,
			sessionController: services.sessionController,
			store
		});
	});
	const getSchedules = () => runtime.schedules;
	ctx.inject(["tools"], (services) => {
		const roster = runtime.roster;
		trace(`inject(tools): 触发 roster=${roster !== void 0 ? "ok" : "undefined"} toolsSvc=${services.tools !== void 0 ? "ok" : "undefined"}`);
		if (roster === void 0) return;
		runtime.botTools = attachBotTools(ctx, services.tools, {
			roster,
			getSchedules,
			getMemory: () => runtime.memory,
			getSelectedBotId: () => runtime.selectedId,
			selectBot: (id) => selection.selectBot(id),
			getTemplates: () => runtime.templates,
			getGroups: () => runtime.groups
		});
	});
	ctx.inject(["credentials"], (services) => {
		runtime.credentials = attachBotCredentials(ctx, services.credentials);
	});
	ctx.inject(["approval"], (services) => {
		runtime.approval = attachBotApproval(ctx, {
			approval: services.approval,
			permissionPresets: ctx.permissionPresets
		});
	});
	{
		const scheduleRef = {};
		try {
			ctx.inject(["schedule"], (services) => {
				scheduleRef.service = services.schedule;
			});
		} catch (error) {
			ctx.logger?.warn(`dsh-bot: 订阅 schedule 服务失败（例程将走惰性弱读）：${String(error)}`);
		}
		runtime.schedules = attachBotSchedules(ctx, {
			schedule: () => scheduleRef.service ?? ctx.schedule,
			preferredSessionId: options.rootSessionId
		});
	}
	const autoDecideRef = {};
	ctx.inject(["autoDecide"], (services) => {
		autoDecideRef.service = services.autoDecide;
	});
	ctx.inject(["agentTeams"], (services) => {
		const teams = createAgentTeamsFacade(services.agentTeams);
		runtime.teams = teams;
		runtime.tasks = createTaskBoard(teams);
		const builtinJudge = options.typesafe?.judge ?? (options.typesafe?.apiKey !== void 0 ? createJevJudge({
			apiKey: options.typesafe.apiKey,
			endpoint: options.typesafe.endpoint
		}) : void 0);
		const judge = options.typesafe?.judge ?? resolveJevBackend({
			decision: options.typesafe?.decision,
			getAutoDecide: () => autoDecideRef.service,
			builtin: builtinJudge,
			warn: (message) => ctx.logger?.warn(message)
		});
		if (judge === void 0) ctx.logger?.warn("dsh-bot: 未配置 typesafe.apiKey/judge 且无 autoDecide 服务，群聊路由走降级（本轮无人响应提示）");
		const sessionsRef = {};
		ctx.inject(["sessions"], (services) => {
			sessionsRef.store = services.sessions;
		});
		runtime.groups = createGroupChatRuntime(ctx, {
			store,
			judge,
			ensureSession: createRootSessionCarrier({
				rootSessionId: options.rootSessionId,
				createSession: async () => sessionsRef.store?.create()?.id
			}),
			approvalTier: options.typesafe?.approval,
			getAutoDecide: () => autoDecideRef.service
		});
		const sessionCtrlRef = {};
		ctx.inject(["sessionController"], (services) => {
			sessionCtrlRef.ctrl = services.sessionController;
		});
		runtime.groups.setDeliverer(async (groupId, delivery) => {
			const ctrl = sessionCtrlRef.ctrl;
			if (ctrl === void 0) throw new Error("dsh-bot: sessionController 服务未挂载，群投递不可用");
			const text = typeof delivery.message?.text === "string" ? delivery.message.text : "";
			const promptText = [
				`【dsh-bot 群聊 ${groupId} · 本轮轮到成员 '${delivery.responder}'】`,
				text,
				`（请以群成员 '${delivery.responder}' 的身份处理；本消息由 dsh-bot 群聊投递）`
			].join("\n");
			const request = {
				requestId: `dsh-bot-group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
				sessionId: delivery.sessionId,
				mode: "queue",
				content: [{
					type: "text",
					text: promptText
				}]
			};
			await ctrl.prompt(request, new AbortController().signal);
		});
		ctx.on("approval/request", async (raw, next) => {
			const req = raw;
			const sessionId = req?.agent?.session?.id;
			const group = typeof sessionId === "string" ? runtime.groups?.groupBySession(sessionId) : void 0;
			if (group === void 0) return next();
			return (await runtime.groups.requestApproval({
				groupId: group.id,
				toolName: typeof req.toolName === "string" ? req.toolName : "unknown",
				summary: typeof req.reason === "string" ? req.reason : void 0
			})).outcome;
		});
	});
}
/** agent/created 注入的容错封装（路线图 §6 纪律 5） */
function onAgentCreated(ctx, handler) {
	ctx.on("agent/created", (payload) => {
		try {
			handler(payload);
		} catch (error) {
			ctx.logger?.warn(`dsh-bot: agent/created 注入失败：${String(error)}`);
		}
	});
}
//#endregion
export { apply, inject, name, onAgentCreated };
