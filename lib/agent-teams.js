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
			return native.spawnTeammate(options, caller);
		},
		async sendMessage(input, caller) {
			requireCaller(caller);
			return native.sendMessage(input, caller);
		},
		async createTask(spec, caller) {
			requireCaller(caller);
			return native.createTask(spec, caller);
		},
		async getTask(request, caller) {
			requireCaller(caller);
			return native.getTask(request, caller);
		},
		async listTasks(filter, caller) {
			requireCaller(caller);
			return native.listTasks(filter, caller);
		},
		async updateTask(request, caller) {
			requireCaller(caller);
			return native.updateTask(request, caller);
		},
		async waitForChange(filter, options, caller) {
			requireCaller(caller);
			return native.waitForChange(filter, options, caller);
		},
		async interrupt(target, caller) {
			requireCaller(caller);
			return native.interrupt(target, caller);
		}
	};
}
//#endregion
export { createAgentTeamsFacade };
