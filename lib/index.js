import { createAgentTeamsFacade } from "./agent-teams.js";
import { attachBotApproval } from "./bot-approval.js";
import { attachBotCredentials } from "./bot-credentials.js";
import { attachBotTools, createMcpBridge } from "./bot-tools.js";
import { createJevJudge } from "./jev.js";
import { createGroupChatRuntime } from "./groupchat.js";
import { createIdentityStore } from "./identity.js";
import { createRoster } from "./roster.js";
import { personaSection } from "./persona.js";
import { attachModelRuntime } from "./model.js";
import { attachBotSchedules } from "./schedules.js";
import { createTaskBoard } from "./taskboard.js";
import { createMemoryRepo } from "./memory.js";
import { createTemplateStore } from "./template.js";
//#region src/index.ts
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
		agent.session?.header?.cwd;
		const selected = runtime.selectedId;
		(async () => {
			const roster = runtime.roster;
			if (roster === void 0) return;
			const bots = await roster.list();
			const chosen = (selected !== void 0 ? bots.find((b) => b.id === selected) : void 0) ?? bots[0];
			if (chosen === void 0) return;
			agent.inject?.(`[dsh-bot] 当前 Bot：${chosen.name}（${chosen.title}）\n${chosen.description}`);
		})();
	}
	(async () => {
		const store = await createIdentityStore(ctx);
		const roster = await createRoster(ctx, store);
		runtime.roster = roster;
		storeRef = store;
		runtime.selectedId = await store.getSelectedId();
		runtime.memory = await createMemoryRepo(ctx);
		runtime.templates = await createTemplateStore(ctx, {
			roster,
			getMemory: () => runtime.memory,
			getSchedules: () => runtime.schedules,
			getMcpServerNames: () => mcp.configured.map((c) => c.name)
		});
		if (ctx.systemPrompt !== void 0) ctx.systemPrompt.section(personaSection(store, { selectedId: () => runtime.selectedId }));
		else ctx.logger?.warn("dsh-bot: ctx.systemPrompt 服务缺失，人格段不注入");
		attachP1Runtimes(ctx, runtime, store, options);
	})().catch((error) => {
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
		mcp,
		selection: {
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
		}
	};
}
/** P1/P2 运行时装配：ctx.inject 订阅（见文件头注释的取舍理由） */
function attachP1Runtimes(ctx, runtime, store, options) {
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
		if (roster === void 0) return;
		runtime.botTools = attachBotTools(ctx, services.tools, {
			roster,
			getSchedules,
			getMemory: () => runtime.memory,
			getSelectedBotId: () => runtime.selectedId,
			getTemplates: () => runtime.templates
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
	ctx.inject(["schedule"], (services) => {
		const rootSessionId = options.rootSessionId;
		if (rootSessionId === void 0) {
			ctx.logger?.warn("dsh-bot: 未配置 rootSessionId，例程运行时不挂载（例程必须绑定 root Session）");
			return;
		}
		runtime.schedules = attachBotSchedules(ctx, {
			schedule: services.schedule,
			rootSessionId
		});
	});
	ctx.inject(["agentTeams"], (services) => {
		const teams = createAgentTeamsFacade(services.agentTeams);
		runtime.teams = teams;
		runtime.tasks = createTaskBoard(teams);
		const judge = options.typesafe?.judge ?? (options.typesafe?.apiKey !== void 0 ? createJevJudge({
			apiKey: options.typesafe.apiKey,
			endpoint: options.typesafe.endpoint
		}) : void 0);
		if (judge === void 0) ctx.logger?.warn("dsh-bot: 未配置 typesafe.apiKey/judge，群聊路由走降级（本轮无人响应提示）");
		runtime.groups = createGroupChatRuntime(ctx, {
			store,
			judge,
			sessionId: options.rootSessionId
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
