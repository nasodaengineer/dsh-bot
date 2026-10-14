import { isGranted } from "./bot-approval.js";
import { openKvUnit } from "./kv.js";
import { judgeApprovalDenial, routeTurn } from "./jev.js";
//#region src/groupchat.ts
/** 审批代答默认超时（A6：默认 10 分钟） */
const APPROVAL_TIMEOUT_MS = 6e5;
/** limited 档在超时前多少毫秒做自动判定（票面示例：剩 60 秒时） */
const APPROVAL_LIMITED_LEAD_MS = 6e4;
function normalizeApprovalTier(tier, warn) {
	if (tier === "limited" || tier === "full") return tier;
	if (tier !== void 0 && tier !== "manual") warn?.(`dsh-bot: 未知审批档位 '${String(tier)}'，按 manual 处理（fail-closed）`);
	return "manual";
}
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
	const approvalTier = normalizeApprovalTier(opts.approvalTier, warn);
	const groups = /* @__PURE__ */ new Map();
	const messages = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const decidedCards = /* @__PURE__ */ new Map();
	const audits = [];
	const waiters = /* @__PURE__ */ new Map();
	let seq = 0;
	let approvalSeq = 0;
	let auditSeq = 0;
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
		for (const value of Object.values(snapshot.tables["approvals"] ?? {})) {
			const rec = value;
			if (rec.__kind === "card") {
				const card = rec;
				decidedCards.set(card.id, {
					id: card.id,
					groupId: card.groupId,
					toolName: card.toolName,
					summary: card.summary,
					status: "answered",
					createdAt: card.createdAt,
					autoVerdict: card.autoVerdict
				});
			} else audits.push(rec);
		}
	})();
	async function persistGroup(group) {
		if (kvReady && kv !== void 0) await kv.putRecord("groups", group.id, group);
	}
	async function persistMessage(message) {
		if (kvReady && kv !== void 0) await kv.putRecord("messages", `${message.groupId}:${message.seq}`, message);
	}
	/** 系统提示写群历史（票 #16：limited 档「自动建议：拒绝」等提示）。appendMessage 的薄封装 */
	async function writeNotice(groupId, text) {
		await appendMessage(groupId, "system", text);
	}
	/**
	* 修复轮·消息写入样板提炼：seq 自增 + 内存插入 + KV 尽力持久化（失败只 warn）。
	* postMessage 的成员消息、writeNotice 的系统提示共用同一条写入路径。
	*/
	async function appendMessage(groupId, from, text) {
		seq += 1;
		const message = {
			groupId,
			seq,
			from,
			text,
			at: (/* @__PURE__ */ new Date()).toISOString()
		};
		const list = messages.get(groupId) ?? [];
		list.push(message);
		messages.set(groupId, list);
		try {
			await persistMessage(message);
		} catch (error) {
			warn(`消息落 KV 失败（保留内存记录）：${String(error)}`);
		}
		return message;
	}
	/** 修复轮：full 档已判定卡的 KV 持久化（复用 approvals 表，__kind 区分卡与审计记录） */
	async function persistDecidedCard(card) {
		if (kvReady && kv !== void 0) try {
			await kv.putRecord("approvals", `card:${card.id}`, {
				__kind: "card",
				...card
			});
		} catch (error) {
			warn(`已判定卡落 KV 失败（保留内存记录）：${String(error)}`);
		}
	}
	/** 票 #16：审计双写（内存必达 + KV 尽力），绝不抛错。KV 不可用/写失败均显式 warn（修复轮：不再静默降级） */
	async function recordAudit(rec) {
		auditSeq += 1;
		const record = {
			id: `aud-${auditSeq}-${rec.approvalId}`,
			at: (/* @__PURE__ */ new Date()).toISOString(),
			...rec
		};
		audits.push(record);
		if (kvReady && kv !== void 0) try {
			await kv.putRecord("approvals", record.id, record);
		} catch (error) {
			warn(`审批审计落 KV 失败（审计降级内存，保留内存记录）：${String(error)}`);
		}
		else warn("审批审计降级内存（KV 不可用），重启即丢");
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
			const message = await appendMessage(group.id, input.from, input.text);
			const list = messages.get(group.id) ?? [];
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
				await appendMessage(group.id, "system", result.degraded === true ? `（Jev 路由不可用，本轮无人响应：${result.reason ?? "未知原因"}）` : "（本轮无人响应）");
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
			const timeoutMs = typeof input.timeoutMs === "number" && input.timeoutMs > 0 ? input.timeoutMs : APPROVAL_TIMEOUT_MS;
			if (approvalTier === "full") {
				const auditBase = {
					approvalId: card.id,
					groupId: card.groupId,
					toolName: card.toolName,
					summary: card.summary,
					tier: "full",
					source: "auto"
				};
				try {
					const j = await judgeApprovalDenial(opts.getAutoDecide, {
						toolName: input.toolName,
						summary: input.summary
					});
					if (j.judgment === "allow") {
						await recordAudit({
							...auditBase,
							judgment: "allow",
							outcome: "allowed-once",
							basis: j.basis,
							probabilities: j.probabilities,
							confidence: j.confidence
						});
						const decided = {
							...card,
							status: "answered",
							autoVerdict: "allowed"
						};
						decidedCards.set(decided.id, decided);
						await persistDecidedCard(decided);
						return {
							granted: true,
							outcome: "allowed-once"
						};
					}
					if (j.judgment === "deny" || j.judgment === "uncertain") {
						await recordAudit({
							...auditBase,
							judgment: j.judgment,
							outcome: "rejected",
							basis: j.basis,
							probabilities: j.probabilities,
							confidence: j.confidence
						});
						const decided = {
							...card,
							status: "answered",
							autoVerdict: "rejected"
						};
						decidedCards.set(decided.id, decided);
						await persistDecidedCard(decided);
						return {
							granted: false,
							outcome: "rejected"
						};
					}
					await recordAudit({
						...auditBase,
						judgment: "unavailable",
						basis: j.basis,
						probabilities: j.probabilities,
						confidence: j.confidence
					});
					warn(`full 档 autoDecide 不可用（${j.basis ?? "未知原因"}），审批 '${card.id}' 回退人工等待，不代答`);
				} catch (error) {
					warn(`full 档自动判定异常，审批 '${card.id}' 回退人工等待：${String(error)}`);
				}
			}
			pending.set(card.id, card);
			return new Promise((resolve) => {
				let settled = false;
				let autoTimer;
				const settle = (outcome) => {
					if (settled) return;
					settled = true;
					pending.delete(card.id);
					if (waiters.get(card.id) === waiter) waiters.delete(card.id);
					if (waiter.timer !== void 0) clearTimeout(waiter.timer);
					if (autoTimer !== void 0) clearTimeout(autoTimer);
					resolve({
						granted: isGranted(outcome),
						outcome
					});
				};
				const waiter = { resolve: settle };
				waiter.timer = setTimeout(() => {
					if (waiters.get(card.id) !== waiter) return;
					warn(`待批卡 '${card.id}' 超时（${timeoutMs}ms），fail-closed 不放行`);
					settle("unavailable");
				}, timeoutMs);
				waiters.set(card.id, waiter);
				if (approvalTier === "limited") {
					const leadAt = timeoutMs > 6e4 ? timeoutMs - APPROVAL_LIMITED_LEAD_MS : Math.max(1, Math.floor(timeoutMs / 2));
					autoTimer = setTimeout(() => {
						if (waiters.get(card.id) !== waiter) return;
						(async () => {
							let j;
							try {
								j = await judgeApprovalDenial(opts.getAutoDecide, {
									toolName: input.toolName,
									summary: input.summary
								});
							} catch (error) {
								warn(`limited 档自动判定异常，继续等人工：${String(error)}`);
								return;
							}
							const auditBase = {
								approvalId: card.id,
								groupId: card.groupId,
								toolName: card.toolName,
								summary: card.summary,
								tier: "limited",
								source: "auto",
								probabilities: j.probabilities,
								confidence: j.confidence
							};
							if (j.judgment === "deny" || j.judgment === "uncertain") {
								await recordAudit({
									...auditBase,
									judgment: j.judgment,
									outcome: "rejected",
									basis: j.basis
								});
								await writeNotice(input.groupId, `审批自动建议：拒绝（${j.basis ?? "fail-closed"}）——已自动驳回 '${input.toolName}'`);
								settle("rejected");
								return;
							}
							await recordAudit({
								...auditBase,
								judgment: j.judgment,
								basis: j.basis
							});
						})();
					}, leadAt);
				}
			});
		},
		listPendingApprovals(groupId) {
			return [...pending.values()].filter((c) => c.groupId === groupId);
		},
		listApprovalCards(groupId) {
			return [[...pending.values()].filter((c) => c.groupId === groupId), [...decidedCards.values()].filter((c) => c.groupId === groupId)].flat();
		},
		async answerApproval(id, outcome) {
			const waiter = waiters.get(id);
			if (waiter === void 0) throw new Error(`dsh-bot: 未知待批卡 '${id}'（已应答或不存在）`);
			const card = pending.get(id) ?? decidedCards.get(id);
			if (card === void 0) throw new Error(`dsh-bot: 待批卡 '${id}' 缺少卡记录，拒绝记审计（fail-closed）`);
			try {
				await recordAudit({
					approvalId: card.id,
					groupId: card.groupId,
					toolName: card.toolName,
					summary: card.summary,
					tier: approvalTier,
					source: "human",
					judgment: isGranted(outcome) ? "allow" : "deny",
					outcome,
					basis: "人工应答"
				});
			} catch (error) {
				warn(`人工应答审计记录失败（不影响应答）：${String(error)}`);
			}
			waiter.resolve(outcome);
		},
		listApprovalAudits() {
			return [...audits];
		}
	};
}
//#endregion
export { APPROVAL_LIMITED_LEAD_MS, APPROVAL_TIMEOUT_MS, createGroupChatRuntime, createRootSessionCarrier, normalizeApprovalTier };
