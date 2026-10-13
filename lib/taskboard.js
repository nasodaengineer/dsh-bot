//#region src/taskboard.ts
/** 纯函数守卫：task 的依赖（dependsOn）全部 status === 'completed' 才可 claim */
function canClaim(task, tasks) {
	if (task === void 0) return false;
	const byId = new Map(tasks.map((t) => [t.id, t]));
	return (task.dependsOn ?? []).every((depId) => byId.get(depId)?.status === "completed");
}
/** 从 live caller 提取稳定标识（用于 claimedBy 审计），拿不到就用类型名 */
function callerLabel(caller) {
	if (typeof caller === "string") return caller;
	if (typeof caller === "object" && caller !== null) {
		const record = caller;
		for (const key of [
			"name",
			"id",
			"agent",
			"label"
		]) if (typeof record[key] === "string" && record[key] !== "") return record[key];
		return "live-caller";
	}
	return "live-caller";
}
function createTaskBoard(teams) {
	return {
		async createTask(spec, caller) {
			return await teams.createTask(spec, caller);
		},
		async getTask(request, caller) {
			return await teams.getTask(request, caller);
		},
		async listTasks(filter, caller) {
			return await teams.listTasks(filter, caller);
		},
		async updateTask(request, caller) {
			return await teams.updateTask(request, caller);
		},
		async claimTask(id, caller) {
			const tasks = await teams.listTasks(void 0, caller);
			const task = tasks.find((t) => t.id === id);
			if (!canClaim(task, tasks)) return {
				ok: false,
				reason: `依赖未全部完成：${(task?.dependsOn ?? []).filter((depId) => tasks.find((t) => t.id === depId)?.status !== "completed").join(", ") || "(未知任务)"}`
			};
			return {
				ok: true,
				task: await teams.updateTask({
					id,
					patch: {
						status: "claimed",
						owner: callerLabel(caller),
						claimedBy: callerLabel(caller)
					}
				}, caller)
			};
		},
		async waitForChange(filter, options, caller) {
			return teams.waitForChange(filter, options, caller);
		}
	};
}
//#endregion
export { canClaim, createTaskBoard };
