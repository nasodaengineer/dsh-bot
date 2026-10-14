//#region src/agent-teams.ts
function requireCaller(caller) {
	if (caller === void 0 || caller === null) throw new Error("dsh-bot: agentTeams 调用缺少 live 调用方 caller（原生安全模型：不合成权限凭据）");
}
function createAgentTeamsFacade(native) {
	return {
		async membership(caller) {
			requireCaller(caller);
			return native.membership(caller);
		},
		async tryMembership(caller) {
			requireCaller(caller);
			return native.tryMembership(caller);
		},
		async listMembers(caller) {
			requireCaller(caller);
			return native.listMembers(caller);
		},
		async spawnTeammate(options, caller) {
			requireCaller(caller);
			return native.spawnTeammate(caller, options);
		},
		async sendMessage(input, caller) {
			requireCaller(caller);
			return native.sendMessage(caller, input);
		},
		async createTask(spec, caller) {
			requireCaller(caller);
			return native.createTask(caller, spec);
		},
		async getTask(request, caller) {
			requireCaller(caller);
			return native.getTask(caller, request.id);
		},
		async listTasks(filter, caller) {
			requireCaller(caller);
			const all = await native.listTasks(caller);
			if (filter === void 0) return all;
			const entries = Object.entries(filter);
			return all.filter((t) => entries.every(([k, v]) => t[k] === v));
		},
		async updateTask(request, caller) {
			requireCaller(caller);
			return native.updateTask(caller, request);
		},
		async waitForChange(filter, options, caller) {
			requireCaller(caller);
			const timeoutMs = typeof options?.timeoutMs === "number" ? options.timeoutMs : 1e4;
			return native.waitForChange(caller, timeoutMs, void 0);
		},
		async interrupt(target, caller) {
			requireCaller(caller);
			return native.interrupt(caller, target);
		}
	};
}
//#endregion
export { createAgentTeamsFacade };
