import { isGranted } from "./bot-approval.js";
import { openKvUnit } from "./kv.js";
import { routeTurn } from "./jev.js";
//#region src/groupchat.ts
/** 审批代答默认超时（A6：默认 10 分钟） */
const APPROVAL_TIMEOUT_MS = 6e5;
function createRootSessionCarrier(opts) {
	let cached;
	let resolved = false;
	return { async ensure() {
		if (!resolved) {
			resolved = true;
			const id = opts.rootSessionId;
			if (typeof id === "string" && id.trim() !== "") cached = id;
		}
		return cached;
	} };
}
function createGroupChatRuntime(ctx, opts) {
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	const groups = /* @__PURE__ */ new Map();
	const messages = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const waiters = /* @__PURE__ */ new Map();
	let seq = 0;
	let approvalSeq = 0;
	let kvReady = false;
	let kv;
	let deliverer;
	let carrierSessionId;
	let carrierResolved = false;
	async function resolveSession() {
		if (!carrierResolved) {
			carrierResolved = true;
			try {
				carrierSessionId = await opts.ensureSession?.ensure() ?? opts.sessionId;
			} catch (error) {
				warn(`群聊载体 Session 解析失败：${String(error)}`);
				carrierSessionId = void 0;
			}
			if (carrierSessionId === void 0) warn("群聊载体 Session 不可用（未配置 rootSessionId 且无创建路径），群聊功能拒绝服务，不假装在工作");
		}
		return carrierSessionId;
	}
	resolveSession();
	(async () => {
		const opened = await openKvUnit(ctx);
		if (opened.kv === void 0) {
			warn("群聊状态打开 KV unit 失败，降级为进程内存储，重启即丢");
			return;
		}
		kv = opened.kv;
		kvReady = true;
		const snapshot = await kv.loadAll();
		for (const [key, value] of Object.entries(snapshot.tables["groups"] ?? {})) groups.set(key, value);
		for (const [key, value] of Object.entries(snapshot.tables["messages"] ?? {})) {
			const msg = value;
			const list = messages.get(msg.groupId) ?? [];
			list.push(msg);
			messages.set(msg.groupId, list);
		}
		for (const list of messages.values()) list.sort((a, b) => a.seq - b.seq);
	})();
	async function persistGroup(group) {
		if (kvReady && kv !== void 0) await kv.putRecord("groups", group.id, group);
	}
	async function persistMessage(message) {
		if (kvReady && kv !== void 0) await kv.putRecord("messages", `${message.groupId}:${message.seq}`, message);
	}
	return {
		async createGroup(input) {
			const sessionId = await resolveSession();
			if (sessionId === void 0) throw new Error("dsh-bot: 群聊载体 Session 不可用，无法建群（fail-visible，不假装在工作）");
			seq += 1;
			const group = {
				id: `grp-${Date.now().toString(36)}-${seq}`,
				name: input.name,
				memberIds: [...input.memberIds],
				sessionId,
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			groups.set(group.id, group);
			await persistGroup(group);
			return group;
		},
		async listGroups() {
			return [...groups.values()];
		},
		async history(groupId) {
			return [...messages.get(groupId) ?? []];
		},
		sessionReady() {
			return carrierResolved && carrierSessionId !== void 0;
		},
		setDeliverer(fn) {
			deliverer = fn;
		},
		async postMessage(input) {
			const group = groups.get(input.groupId);
			if (group === void 0) throw new Error(`dsh-bot: 未知群 '${input.groupId}'`);
			seq += 1;
			const message = {
				groupId: group.id,
				seq,
				from: input.from,
				text: input.text,
				at: (/* @__PURE__ */ new Date()).toISOString()
			};
			const list = messages.get(group.id) ?? [];
			list.push(message);
			messages.set(group.id, list);
			await persistMessage(message);
			const members = group.memberIds.map((id) => ({ id }));
			const transcript = list.slice(-12).map((m) => ({
				from: m.from,
				text: m.text
			}));
			let result;
			if (opts.judge === void 0) result = {
				responder: "none",
				degraded: true,
				reason: "未配置 Jev 决策模型"
			};
			else result = await routeTurn({
				members,
				transcript
			}, opts.judge);
			if (result.responder === "none") {
				seq += 1;
				const notice = {
					groupId: group.id,
					seq,
					from: "system",
					text: result.degraded === true ? `（Jev 路由不可用，本轮无人响应：${result.reason ?? "未知原因"}）` : "（本轮无人响应）",
					at: (/* @__PURE__ */ new Date()).toISOString()
				};
				list.push(notice);
				await persistMessage(notice);
				return {
					responder: "none",
					degraded: result.degraded,
					reason: result.reason,
					message
				};
			}
			const delivery = {
				sessionId: group.sessionId,
				responder: result.responder,
				message
			};
			if (deliverer === void 0) warn(`群 '${group.name}' 未注入投递实现，本轮判定 ${result.responder} 只记录不投递`);
			else try {
				deliverer(group.id, delivery);
			} catch (error) {
				warn(`群投递失败：${String(error)}`);
			}
			return {
				responder: result.responder,
				confidence: result.confidence,
				message
			};
		},
		async requestApproval(input) {
			approvalSeq += 1;
			const card = {
				id: `apr-${Date.now().toString(36)}-${approvalSeq}`,
				groupId: input.groupId,
				toolName: input.toolName,
				summary: input.summary,
				status: "pending",
				createdAt: (/* @__PURE__ */ new Date()).toISOString()
			};
			pending.set(card.id, card);
			const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : APPROVAL_TIMEOUT_MS;
			return new Promise((resolve) => {
				const settle = (outcome) => {
					pending.delete(card.id);
					resolve({
						granted: isGranted(outcome),
						outcome
					});
				};
				const waiter = { resolve: settle };
				waiter.timer = setTimeout(() => {
					if (waiters.get(card.id) !== waiter) return;
					waiters.delete(card.id);
					warn(`待批卡 '${card.id}' 超时（${timeoutMs}ms），fail-closed 不放行`);
					settle("unavailable");
				}, timeoutMs);
				waiters.set(card.id, waiter);
			});
		},
		listPendingApprovals(groupId) {
			return [...pending.values()].filter((c) => c.groupId === groupId);
		},
		async answerApproval(id, outcome) {
			const waiter = waiters.get(id);
			if (waiter === void 0) throw new Error(`dsh-bot: 未知待批卡 '${id}'（已应答或不存在）`);
			waiters.delete(id);
			if (waiter.timer !== void 0) clearTimeout(waiter.timer);
			waiter.resolve(outcome);
		}
	};
}
//#endregion
export { APPROVAL_TIMEOUT_MS, createGroupChatRuntime, createRootSessionCarrier };
