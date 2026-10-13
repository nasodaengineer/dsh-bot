//#region src/schedules.ts
const TIMING_FIELDS = [
	"after_seconds",
	"at",
	"every_seconds",
	"daily",
	"weekly",
	"cron"
];
function attachBotSchedules(ctx, opts) {
	const { schedule, rootSessionId } = opts;
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	if (typeof rootSessionId !== "string" || rootSessionId.trim() === "") throw new Error("dsh-bot: 例程必须绑定 root Session（sessionId 为空；子代理 Session 会被宿主以 subagent_session 拒绝）");
	const known = /* @__PURE__ */ new Map();
	const paused = /* @__PURE__ */ new Map();
	function validate(request) {
		if (typeof request.title !== "string" || request.title.trim() === "" || request.title.length > 120) throw new Error("dsh-bot: 例程 title 必须为 1-120 字符");
		if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new Error("dsh-bot: 例程 prompt 不能为空");
		const present = TIMING_FIELDS.filter((field) => request[field] !== void 0);
		if (present.length !== 1) throw new Error(`dsh-bot: 六种定时形态必须且只能给一种（当前：${present.length === 0 ? "未给" : present.join(" + ")}）`);
	}
	return {
		rootSessionId,
		async create(request) {
			validate(request);
			const record = await schedule.create(rootSessionId, request);
			known.set(record.id, request);
			return record;
		},
		async list() {
			try {
				return await schedule.list({ sessionId: rootSessionId });
			} catch (error) {
				warn(`列例程失败：${String(error)}`);
				return [];
			}
		},
		async pause(id) {
			const request = known.get(id);
			if (request === void 0) return false;
			if (!await schedule.delete({
				sessionId: rootSessionId,
				id
			})) return false;
			known.delete(id);
			paused.set(id, request);
			return true;
		},
		async resume(id) {
			const request = paused.get(id);
			if (request === void 0) return void 0;
			const record = await schedule.create(rootSessionId, request);
			paused.delete(id);
			known.set(record.id, request);
			return record;
		},
		async delete(id) {
			const existed = known.delete(id);
			paused.delete(id);
			return await schedule.delete({
				sessionId: rootSessionId,
				id
			}) || existed;
		},
		requests() {
			return [...known.values()];
		}
	};
}
//#endregion
export { attachBotSchedules };
