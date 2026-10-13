//#region src/persona.ts
const PERSONA_SECTION_NAME = "dsh-bot:persona";
const PERSONA_SECTION_ORDER = 100;
function renderBot(identity) {
	const lines = [`Name: ${identity.name}`];
	if (identity.title) lines.push(`Title: ${identity.title}`);
	if (identity.description) lines.push(`Description: ${identity.description}`);
	return lines.join("\n");
}
function personaSection(store, selection, options = {}) {
	let warnedNoSelection = false;
	return {
		name: PERSONA_SECTION_NAME,
		order: 100,
		text: () => {
			const selectedId = selection.selectedId();
			if (selectedId === void 0) {
				if (!warnedNoSelection) {
					warnedNoSelection = true;
					options.warn?.("dsh-bot: 未选中 Bot，人格段不注入（不再静默回退名册第一个）");
				}
				return "";
			}
			const picked = store.listSync().find((bot) => bot.id === selectedId);
			return picked === void 0 ? "" : renderBot(picked);
		}
	};
}
//#endregion
export { PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER, personaSection };
