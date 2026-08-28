export function buildCompleteInitContext(body) {
    return {
        phase: "complete",
        userId: body.user_id,
        callbackUrl: body.callback_url,
        code: body.code,
        state: body.state,
    };
}
//# sourceMappingURL=oauth-init.js.map