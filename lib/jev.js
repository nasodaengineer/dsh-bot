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
		if (service !== void 0) {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const outcome = await Promise.race([service.decode({
					state: request.state,
					questions: request.questions
				}), new Promise((_, reject) => {
					controller.signal.addEventListener("abort", () => reject(/* @__PURE__ */ new Error("autoDecide decode 超时")));
				})]);
				if (outcome?.answers === void 0 || typeof outcome.answers !== "object") throw new Error("autoDecide 返回缺少 answers");
				return outcome.answers;
			} catch (error) {
				warn(`dsh-bot: autoDecide 不可用，降级 builtin：${String(error)}`);
			} finally {
				clearTimeout(timer);
			}
		} else if (builtin !== void 0) warn("dsh-bot: autoDecide 服务未注入，降级 builtin 直连");
		else throw new Error("无可用决策后端（autoDecide 服务缺失且未配置 builtin）");
		if (builtin === void 0) throw new Error("无可用决策后端（未配置 builtin）");
		return builtin(request);
	};
}
//#endregion
export { buildRouteQuestion, createJevJudge, resolveJevBackend, routeTurn };
