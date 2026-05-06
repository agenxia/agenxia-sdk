// Platform-aware email client. POSTs to ${PLATFORM_URL}/api/email/send with
// x-agent-token. Resend credentials live on the platform — agents never see
// the API key. Modeled after getLLMClient (./llm.ts) but stateless: no client
// object, just a single helper.
export async function sendEmail(to, subject, content) {
    const platformUrl = process.env.PLATFORM_URL;
    const agentToken = process.env.AGENT_PLATFORM_TOKEN;
    const agentId = process.env.AGENT_ID;
    if (!platformUrl || !agentToken) {
        return {
            success: false,
            error: "Email config missing: PLATFORM_URL + AGENT_PLATFORM_TOKEN required (platform mode only)",
        };
    }
    if (!to)
        return { success: false, error: "Destinataire (to) manquant" };
    const url = `${platformUrl.replace(/\/$/, "")}/api/email/send`;
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
        "x-agent-token": agentToken,
    };
    if (agentId)
        headers["x-agent-id"] = agentId;
    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ to, subject, html: content }),
        });
        const text = await res.text();
        if (!res.ok) {
            return {
                success: false,
                error: `Email API ${res.status}: ${text.slice(0, 200)}`,
            };
        }
        const json = text
            ? JSON.parse(text)
            : {};
        return {
            success: !!json.success,
            messageId: json.messageId,
            error: json.error,
        };
    }
    catch (err) {
        return { success: false, error: err.message };
    }
}
//# sourceMappingURL=email.js.map