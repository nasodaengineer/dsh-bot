//#region src/persona.ts
const PERSONA_SECTION_NAME = "dsh-bot:persona";
const PERSONA_SECTION_ORDER = 100;
function renderBot(identity) {
	const lines = [`Name: ${identity.name}`];
	if (identity.title) lines.push(`Title: ${identity.title}`);
	if (identity.description) lines.push(`Description: ${identity.description}`);
	return lines.join("\n");
}
function personaSection(store, selection) {
	return {
		name: PERSONA_SECTION_NAME,
		order: 100,
		text: () => {
			const bots = store.listSync();
			const picked = bots.find((bot) => bot.id === selection.selectedId()) ?? bots[0];
			return picked === void 0 ? "" : renderBot(picked);
		}
	};
}
//#endregion
export { PERSONA_SECTION_NAME, PERSONA_SECTION_ORDER, personaSection };
