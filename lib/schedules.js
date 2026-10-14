import { t as trace } from "./diag-RBR7u0y4.js";
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
	const { rootSessionId } = opts;
	const resolveSchedule = () => typeof opts.schedule === "function" ? opts.schedule() : opts.schedule;
	const requireSchedule = () => {
		const schedule = resolveSchedule();
		if (schedule === void 0) {
			try {
				const probe = ctx;
				const calls = probe.calls;
				const sample = Array.isArray(calls) && calls.length > 0 ? String(JSON.stringify(calls.find((c) => c && typeof c === "object") ?? calls[0])).slice(0, 400) : `len=${calls?.length ?? "n/a"}`;
				const fetchFn = probe.connection?.fetch;
				trace(`schedule 探针: callSample=${sample} fetch=${typeof fetchFn}${typeof fetchFn === "function" ? ` fnSrc=${String(fetchFn).slice(0, 200)}` : ""}`);
			} catch (e) {
				trace(`schedule 探针异常: ${e.message}`);
			}
			throw new Error("dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）");
		}
		return schedule;
	};
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
			const record = await requireSchedule().create(rootSessionId, request);
			known.set(record.id, request);
			return record;
		},
		async list() {
			try {
				return await requireSchedule().list({ sessionId: rootSessionId });
			} catch (error) {
				warn(`列例程失败：${String(error)}`);
				return [];
			}
		},
		async pause(id) {
			const schedule = requireSchedule();
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
			const schedule = requireSchedule();
			const request = paused.get(id);
			if (request === void 0) return void 0;
			const record = await schedule.create(rootSessionId, request);
			paused.delete(id);
			known.set(record.id, request);
			return record;
		},
		async delete(id) {
			const schedule = requireSchedule();
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
