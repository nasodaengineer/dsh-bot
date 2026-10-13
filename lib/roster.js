//#region src/roster.ts
const PRESET_ID_PREFIX = "dsh-bot:";
async function createRoster(ctx, store) {
	const presets = ctx.agentPresets;
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	if (presets === void 0) warn("ctx.agentPresets 服务缺失，名册降级为纯自有状态（无原生 preset 装配）");
	const disposers = /* @__PURE__ */ new Map();
	return {
		presetsAvailable: presets !== void 0,
		async create(identity) {
			await store.put(identity);
			if (presets !== void 0) {
				const disposer = await presets.register({
					id: `${PRESET_ID_PREFIX}${identity.id}`,
					name: identity.name,
					description: identity.description,
					plugins: []
				});
				disposers.set(identity.id, disposer);
			}
		},
		async list() {
			return store.list();
		},
		async remove(id) {
			const disposer = disposers.get(id);
			if (disposer !== void 0) {
				await disposer();
				disposers.delete(id);
			}
			await store.remove(id);
		},
		async mount(agentCtx, id) {
			if (presets === void 0) return { id: id ?? "" };
			return presets.mount(agentCtx, id === void 0 ? void 0 : `${PRESET_ID_PREFIX}${id}`);
		},
		async select(agent, id) {
			if (presets === void 0) return id;
			return presets.select(agent, `${PRESET_ID_PREFIX}${id}`);
		}
	};
}
//#endregion
export { PRESET_ID_PREFIX, createRoster };
