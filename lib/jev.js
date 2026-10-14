//#region src/jev.ts
/**
* 票 #14：builtin 后端 = 原有 TypeSafe HTTP 直连（凭据面：TYPESAFE_API_KEY 只在这条路径出现）。
*/
function createJevJudge(options) {
	const endpoint = options.endpoint ?? "https://api.typesafe.ai/v1/systemone";
	const timeoutMs = options.timeoutMs ?? 15e3;
	const doFetch = options.fetchImpl ?? fetch;
	return async (request) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await doFetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${options.apiKey}`
				},
				body: JSON.stringify({
					state: request.state,
					model: request.model ?? "jev-latest",
					questions: request.questions
				}),
				signal: controller.signal
			});
			if (!response.ok) throw new Error(`jev: HTTP ${response.status}`);
			const body = await response.json();
			if (body.answers === void 0 || typeof body.answers !== "object") throw new Error("jev: 响应缺少 answers");
			return body.answers;
		} finally {
			clearTimeout(timer);
		}
	};
}
/** 构造路由判定：choice 问「谁说话」，候选 = 全部成员 + none */
function buildRouteQuestion(input) {
	const criteria = { none: "本轮无人需要响应，保持沉默" };
	for (const member of input.members) criteria[member.id] = `${member.name ?? member.id}${member.description ? `（${member.description}）` : ""} 应该回应这条消息`;
	return {
		state: {
			members: input.members.map((m) => ({
				id: m.id,
				name: m.name,
				description: m.description
			})),
			transcript: input.transcript.slice(-12)
		},
		questions: { responder: {
			type: "choice",
			instructions: "这是一段群聊。根据最近的对话，判断这一轮应该由谁说话：从成员中选择最合适的响应者；如果没有人需要回应（比如消息与所有人无关、对话已结束），选 none。只选一个人。",
			criteria
		} }
	};
}
/** 每轮投递决策：Jev 判定；不可用/超时/未知选项 → 降级，不挂死 */
async function routeTurn(input, judge, options = {}) {
	if (input.members.length === 0) return {
		responder: "none",
		degraded: true,
		reason: "群内没有成员"
	};
	const { state, questions } = buildRouteQuestion(input);
	let answer;
	try {
		answer = (await judge({
			state,
			questions
		})).responder ?? {};
	} catch (error) {
		return {
			responder: "none",
			degraded: true,
			reason: `Jev 判定不可用：${String(error)}`
		};
	}
	const choice = answer.choice;
	if (typeof choice !== "string") return {
		responder: "none",
		degraded: true,
		reason: "Jev 返回缺少 choice"
	};
	if (choice === "none") return {
		responder: "none",
		confidence: answer.confidence
	};
	if (!input.members.some((m) => m.id === choice)) return {
		responder: "none",
		degraded: true,
		reason: `Jev 返回未知响应者 '${choice}'`
	};
	return {
		responder: choice,
		confidence: answer.confidence
	};
}
/**
* 修复轮·共享超时模板：给任意 promise 挂保险超时，超时抛 `tag` 错误。
* judgeApprovalDenial 与 resolveJevBackend 的 autoDecide 弱读共用（对方自带 15s 超时，
* 这里只做本地保险，绝不挂死）。
*/
function withTimeout(promise, ms, tag) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	return Promise.race([promise, new Promise((_, reject) => {
		controller.signal.addEventListener("abort", () => reject(new Error(tag)));
	})]).finally(() => clearTimeout(timer));
}
/**
* 票 #16·审批自动判定：noul 题「是否应拒绝该审批」。
* 只弱读 autoDecide 服务（复用票 #14 的弱读 + withTimeout 保险超时模式）——服务缺失/
* decode 抛错/超时/应答缺失 → judgment='unavailable'，绝不降级 builtin，也绝不抛错。
* 判读（修复轮 fail-closed 收紧）：只认 choice——'true'=应拒绝→deny；'false'=允许→allow；
* choice 缺失（含概率再怎么倾向 false）一律 uncertain（消费方把 uncertain 当 deny，
* fail-closed）。修复轮删除了旧的「p(false) 占优即 allow」概率兜底：概率不能代替
* 服务给出的明确判定，缺 choice 说明应答不可解析，宁可拒也不放行。
*/
async function judgeApprovalDenial(getAutoDecide, input, options = {}) {
	const service = getAutoDecide?.();
	if (service === void 0) return {
		judgment: "unavailable",
		basis: "autoDecide 服务不可用"
	};
	const timeoutMs = options.timeoutMs ?? 15e3;
	try {
		const answer = (await withTimeout(service.decode({
			state: {
				toolName: input.toolName,
				summary: input.summary ?? ""
			},
			questions: { deny: {
				type: "noul",
				instructions: "这是一次工具调用审批请求。根据工具名与摘要判断：是否应当拒绝这次审批？危险、破坏性、超出常规操作范围或摘要可疑的应拒绝。",
				criteria: {
					true: "应当拒绝该审批",
					false: "不应当拒绝（可以允许）"
				}
			} }
		}), timeoutMs, "autoDecide decode 超时"))?.answers?.deny;
		if (answer === void 0 || typeof answer !== "object") return {
			judgment: "unavailable",
			basis: "autoDecide 返回缺少 deny 应答"
		};
		const probabilities = answer.probabilities;
		const basis = `noul 判定 choice=${String(answer.choice)}`;
		if (answer.choice === "true") return {
			judgment: "deny",
			basis,
			confidence: answer.confidence,
			probabilities
		};
		if (answer.choice === "false") return {
			judgment: "allow",
			basis,
			confidence: answer.confidence,
			probabilities
		};
		return {
			judgment: "uncertain",
			basis: "autoDecide 应答无法解析出明确判定",
			probabilities
		};
	} catch (error) {
		return {
			judgment: "unavailable",
			basis: `autoDecide 判定失败：${String(error)}`
		};
	}
}
let warnedAutoDecideMissing = false;
/**
* 票 #14 双后端解析：默认 autoDecide 优先——服务在且 decode 成功则透传 DecideOutcome.answers
* （choice/score/noul 题型原样透传，路由消费方只读 choice/confidence）；服务不在/decode 抛错/
* 超时 → 自动降级 builtin。decision='builtin' 时跳过 autoDecide。两个后端都不可用时返回
* undefined（由调用方走「未配置决策模型」降级文案），运行期双双缺失则抛错交给 routeTurn 降级。
*/
function resolveJevBackend(options) {
	const builtin = options.builtin;
	const warn = options.warn ?? (() => {});
	const timeoutMs = options.timeoutMs ?? 15e3;
	if (options.decision === "builtin") return builtin;
	const hasAutoDecideHook = options.getAutoDecide !== void 0;
	if (builtin === void 0 && !hasAutoDecideHook) return void 0;
	return async (request) => {
		const service = options.getAutoDecide?.();
		if (service !== void 0) try {
			const outcome = await withTimeout(service.decode({
				state: request.state,
				questions: request.questions
			}), timeoutMs, "autoDecide decode 超时");
			if (outcome?.answers === void 0 || typeof outcome.answers !== "object") throw new Error("autoDecide 返回缺少 answers");
			return outcome.answers;
		} catch (error) {
			warn(`dsh-bot: autoDecide 不可用，降级 builtin：${String(error)}`);
		}
		else if (builtin !== void 0) {
			if (!warnedAutoDecideMissing) {
				warnedAutoDecideMissing = true;
				warn("dsh-bot: autoDecide 服务未注入，降级 builtin 直连");
			}
		} else throw new Error("无可用决策后端（autoDecide 服务缺失且未配置 builtin）");
		return builtin(request);
	};
}
//#endregion
export { buildRouteQuestion, createJevJudge, judgeApprovalDenial, resolveJevBackend, routeTurn, withTimeout };
