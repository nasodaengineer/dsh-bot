//#region src/model.ts
const MODEL_META_KEY = "model";
function attachModelRuntime(ctx, opts) {
	const { llm, sessionController, store } = opts;
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	let cached;
	store.getMeta(MODEL_META_KEY).then((value) => {
		if (isModelSelection(value)) cached = value;
	});
	return {
		async listCatalog() {
			const providers = llm.listProviders();
			const entries = [];
			for (const provider of providers) try {
				const models = await llm.listModels(provider.name);
				entries.push({
					provider: provider.name,
					models: models.map((m) => m.id)
				});
			} catch (error) {
				warn(`列模型失败（provider=${provider.name}）：${String(error)}`);
				entries.push({
					provider: provider.name,
					models: []
				});
			}
			return entries;
		},
		async selectModel(sessionId, selection) {
			const result = await sessionController.selectModel({
				sessionId,
				...selection
			});
			cached = result.selected;
			await store.putMeta(MODEL_META_KEY, result.selected);
			return result.selected;
		},
		currentSelection() {
			return cached;
		}
	};
}
function isModelSelection(value) {
	return typeof value === "object" && value !== null && typeof value.provider === "string" && typeof value.model === "string";
}
//#endregion
export { attachModelRuntime };
