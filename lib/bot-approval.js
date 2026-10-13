//#region src/bot-approval.ts
/** fail-closed 判定：只有宿主显式给的一次性授权算「通过」 */
function isGranted(outcome) {
	return outcome === "allowed-once";
}
function attachBotApproval(ctx, opts) {
	const { approval, permissionPresets } = opts;
	return {
		async request(input) {
			const outcome = await approval.request({
				tool: "dsh-bot",
				...input
			});
			return {
				granted: isGranted(outcome),
				outcome
			};
		},
		async listPresets() {
			if (permissionPresets === void 0) {
				ctx.logger?.warn("dsh-bot: ctx.permissionPresets 服务缺失，预设目录不可用");
				return [];
			}
			return (await permissionPresets.catalog()).map((entry) => entry.name);
		},
		async currentPreset(session) {
			if (permissionPresets === void 0) return void 0;
			return (await permissionPresets.current(session))?.name;
		},
		async applyPreset(session, name) {
			if (permissionPresets === void 0) throw new Error("dsh-bot: ctx.permissionPresets 服务缺失，无法切换权限档位");
			const names = await this.listPresets();
			if (!names.includes(name)) throw new Error(`dsh-bot: 未知权限档位 '${name}'（可选：${names.join(", ")}）`);
			return permissionPresets.set(session, name);
		}
	};
}
//#endregion
export { attachBotApproval, isGranted };
