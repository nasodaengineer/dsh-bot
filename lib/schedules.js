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
	const resolveSessionId = (sessionId) => {
		const id = typeof opts.preferredSessionId === "string" && opts.preferredSessionId.trim() !== "" ? opts.preferredSessionId : sessionId;
		if (typeof id !== "string" || id.trim() === "") throw new Error("dsh-bot: 无法确定目标 Session（exec.agent.session.id 缺失且未配置 rootSessionId）");
		return id;
	};
	const resolveSchedule = () => typeof opts.schedule === "function" ? opts.schedule() : opts.schedule;
	const requireSchedule = () => {
		const schedule = resolveSchedule();
		if (schedule === void 0) {
			try {
				const probe = ctx;
				const fetchObj = probe.connection?.fetch;
				const fetchInfo = fetchObj && typeof fetchObj === "object" ? `fetch.keys=[${Object.keys(fetchObj).join(",")}] fetch.vals=[${Object.keys(fetchObj).map((k) => typeof fetchObj[k]).join(",")}]` : `fetch=${typeof fetchObj}`;
				const calls = probe.calls;
				const schedCalls = Array.isArray(calls) ? calls.filter((c) => typeof c === "string" && c.toLowerCase().includes("sched")).slice(0, 5).join(" | ") || "none-string" : "not-array";
				trace(`schedule 探针: callsLen=${calls?.length ?? "n/a"} schedCalls=[${schedCalls}] ${fetchInfo}`);
			} catch (e) {
				trace(`schedule 探针异常: ${e.message}`);
			}
			throw new Error("dsh-bot: schedule 服务未挂载（宿主未开 Automation tasks）");
		}
		return schedule;
	};
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	const known = /* @__PURE__ */ new Map();
	const paused = /* @__PURE__ */ new Map();
	function validate(request) {
		if (typeof request.title !== "string" || request.title.trim() === "" || request.title.length > 120) throw new Error("dsh-bot: 例程 title 必须为 1-120 字符");
		if (typeof request.prompt !== "string" || request.prompt.trim() === "") throw new Error("dsh-bot: 例程 prompt 不能为空");
		const present = TIMING_FIELDS.filter((field) => request[field] !== void 0);
		if (present.length !== 1) throw new Error(`dsh-bot: 六种定时形态必须且只能给一种（当前：${present.length === 0 ? "未给" : present.join(" + ")}）`);
	}
	return {
		async create(sessionId, request) {
			const sid = resolveSessionId(sessionId);
			validate(request);
			const record = await requireSchedule().create(sid, request);
			known.set(record.id, request);
			return record;
		},
		async list(sessionId) {
			try {
				return await requireSchedule().list({ sessionId: resolveSessionId(sessionId) });
			} catch (error) {
				warn(`列例程失败：${String(error)}`);
				return [];
			}
		},
		async pause(sessionId, id) {
			const schedule = requireSchedule();
			const request = known.get(id);
			if (request === void 0) return false;
			if (!await schedule.delete({
				sessionId: resolveSessionId(sessionId),
				id
			})) return false;
			known.delete(id);
			paused.set(id, request);
			return true;
		},
		async resume(sessionId, id) {
			const schedule = requireSchedule();
			const request = paused.get(id);
			if (request === void 0) return void 0;
			const record = await schedule.create(resolveSessionId(sessionId), request);
			paused.delete(id);
			known.set(record.id, request);
			return record;
		},
		async delete(sessionId, id) {
			const schedule = requireSchedule();
			const existed = known.delete(id);
			paused.delete(id);
			return await schedule.delete({
				sessionId: resolveSessionId(sessionId),
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
