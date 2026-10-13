//#region src/bot-credentials.ts
/** CredentialRef 文法：POSIX shell 标识符段，段内 [A-Za-z0-9_][A-Za-z0-9_-]*，可 'scope/id'（至多一层 scope） */
const CRED_REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\/[A-Za-z0-9_][A-Za-z0-9_-]*)?$/;
function isValidCredentialRef(ref) {
	return CRED_REF_RE.test(ref);
}
function assertCredentialRef(ref) {
	if (!isValidCredentialRef(ref)) throw new Error(`dsh-bot: 非法凭据引用 '${ref}'（应为 POSIX shell 标识符，可含一个 '/' 分隔 scope/id）`);
}
function attachBotCredentials(ctx, credentials) {
	const warn = (message) => ctx.logger?.warn(`dsh-bot: ${message}`);
	return {
		async resolve(ref) {
			assertCredentialRef(ref);
			const resolved = await credentials.resolve(ref);
			if (resolved === void 0) return void 0;
			return {
				value: resolved.value,
				source: resolved.source
			};
		},
		async describe(ref) {
			assertCredentialRef(ref);
			const info = await credentials.describe(ref);
			return {
				configured: info.configured,
				source: info.source
			};
		},
		async set(ref, value) {
			assertCredentialRef(ref);
			if (typeof value !== "string" || value.trim() === "") throw new Error("dsh-bot: 凭据值不能为空；要清除请用 unset");
			await credentials.set(ref, value);
		},
		async unset(ref) {
			assertCredentialRef(ref);
			await credentials.unset(ref);
		},
		async listRecords() {
			try {
				return await credentials.listRecords();
			} catch (error) {
				warn(`列凭据记录失败：${String(error)}`);
				return [];
			}
		}
	};
}
//#endregion
export { assertCredentialRef, attachBotCredentials, isValidCredentialRef };
