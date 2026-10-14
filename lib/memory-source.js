//#region src/memory-source.ts
/** COMPOSABLE_MEMORY_API_VERSION（view.ts:16） */
const COMPOSABLE_MEMORY_API_VERSION = "dsh-mnemon/v1";
const TYPE_ID = "dsh-bot/memory";
const REVISION = "rev-1";
/**
* 构造 dsh-bot 记忆的 MemorySource 定义：事实源是 MemoryRepo（ctx.storage KV），
* project 贡献索引（含 compact 摘要条目），query 走关键词检索，mutate 走 write 动作。
*/
function createDshBotMemorySource(repo, options = {}) {
	options.instanceKey;
	const manifest = {
		apiVersion: COMPOSABLE_MEMORY_API_VERSION,
		kind: "source",
		typeId: TYPE_ID,
		packageName: "dsh-bot",
		role: "bot-facts",
		capabilities: [
			"status",
			"project",
			"recall",
			"search",
			"write"
		],
		consistency: "namespace-pinned-live-read",
		routes: [{
			id: "search",
			description: "按关键词全命中检索 dsh-bot 记忆（输入 {query: string}）",
			capability: "search",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"]
			}
		}],
		actions: [{
			id: "write",
			description: "写入一条 Bot 记忆（输入 {botId, topic, text}）",
			capability: "write",
			inputSchema: {
				type: "object",
				properties: {
					botId: { type: "string" },
					topic: { type: "string" },
					text: { type: "string" }
				},
				required: [
					"botId",
					"topic",
					"text"
				]
			}
		}]
	};
	const botIdOf = (scope) => options.defaultBotId ?? (typeof scope?.agentId === "string" && scope.agentId !== "" ? scope.agentId : "default");
	return {
		manifest,
		create(context) {
			const key = context.sourceInstanceKey;
			return {
				async facts() {
					return {
						sourceInstanceKey: key,
						sourceTypeId: TYPE_ID,
						role: manifest.role,
						availability: "ready",
						revision: REVISION,
						capabilities: manifest.capabilities,
						routeIds: (manifest.routes ?? []).map((r) => r.id),
						actionIds: (manifest.actions ?? []).map((a) => a.id),
						hints: {
							factSource: "ctx.storage KV (unit dsh-bot)",
							compactSummariesIncluded: true
						}
					};
				},
				async project(request) {
					const botId = botIdOf(request.scope);
					const index = await repo.indexText(botId);
					if (!request.includeProjection || index === "") return { fragments: [] };
					const truncated = index.length > request.maxCharacters;
					const text = truncated ? index.slice(0, request.maxCharacters) : index;
					return { fragments: [{
						id: `${key}:index:${botId}`,
						sourceInstanceKey: key,
						mode: request.mode,
						text,
						revision: request.expectedRevision,
						provenance: {
							botId,
							kind: "memory-index",
							truncated
						}
					}] };
				},
				async query(request) {
					const input = request.input ?? {};
					const query = typeof input.query === "string" ? input.query : "";
					if (query.trim() === "") return {
						id: `ev-${Date.now().toString(36)}`,
						viewId: request.view.id,
						routeId: request.route.id,
						sourceInstanceKey: key,
						observedAt: (/* @__PURE__ */ new Date()).toISOString(),
						items: [],
						truncated: false
					};
					const botId = botIdOf(request.view.scope);
					const hits = await repo.search(botId, query);
					return {
						id: `ev-${Date.now().toString(36)}`,
						viewId: request.view.id,
						routeId: request.route.id,
						sourceInstanceKey: key,
						observedAt: (/* @__PURE__ */ new Date()).toISOString(),
						items: hits.map((entry) => ({
							id: `${key}:${entry.id}`,
							text: entry.text,
							provenance: {
								botId,
								topic: entry.topic,
								entryId: entry.id,
								updatedAt: entry.updatedAt
							},
							revision: REVISION
						})),
						truncated: false
					};
				},
				async mutate(request) {
					const base = {
						viewId: request.view.id,
						offerId: request.offer.id,
						sourceInstanceKey: key
					};
					const input = request.input ?? {};
					const botId = typeof input.botId === "string" ? input.botId : "";
					const topic = typeof input.topic === "string" ? input.topic : "";
					const text = typeof input.text === "string" ? input.text : "";
					if (botId === "" || topic === "" || text === "") return {
						...base,
						status: "failed",
						completion: "failed",
						details: { reason: "botId/topic/text 均为必填字符串" }
					};
					try {
						const entry = await repo.write(botId, {
							topic,
							text
						});
						return {
							...base,
							status: "succeeded",
							completion: "committed",
							committedAt: (/* @__PURE__ */ new Date()).toISOString(),
							revision: REVISION,
							details: { entryId: entry.id }
						};
					} catch (error) {
						return {
							...base,
							status: "failed",
							completion: "failed",
							details: { reason: String(error) }
						};
					}
				},
				async dispose() {}
			};
		}
	};
}
//#endregion
export { COMPOSABLE_MEMORY_API_VERSION, createDshBotMemorySource };
