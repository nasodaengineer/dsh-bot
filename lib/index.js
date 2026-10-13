import { createIdentityStore } from "./identity.js";
import { createRoster } from "./roster.js";
import { personaSection } from "./persona.js";
//#region src/index.ts
const name = "dsh-bot";
const inject = [
	"agentPresets",
	"systemPrompt",
	"storage"
];
function apply(ctx) {
	const runtime = {};
	(async () => {
		const store = await createIdentityStore(ctx);
		const roster = await createRoster(ctx, store);
		runtime.roster = roster;
		let selectedId;
		if (ctx.systemPrompt !== void 0) ctx.systemPrompt.section(personaSection(store, { selectedId: () => selectedId }));
		else ctx.logger?.warn("dsh-bot: ctx.systemPrompt 服务缺失，人格段不注入");
	})().catch((error) => {
		ctx.logger?.warn(`dsh-bot: 初始化失败：${String(error)}`);
	});
	return { get roster() {
		return runtime.roster;
	} };
}
/** agent/created 注入的容错封装（路线图 §6 纪律 5）：P0 只留钩子位，P1 接会话启动人格。 */
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
