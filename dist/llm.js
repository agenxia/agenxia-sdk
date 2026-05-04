// OpenAI-compatible LLM client (chat + embeddings)
export function createLLM(options) {
    const baseHeaders = () => ({
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`,
        ...(options.extraHeaders ?? {}),
    });
    return {
        async chat(messages, overrides) {
            const opts = { ...options, ...overrides };
            const allMessages = opts.systemPrompt
                ? [{ role: "system", content: opts.systemPrompt }, ...messages]
                : messages;
            const headers = {
                "Content-Type": "application/json",
                Authorization: `Bearer ${opts.apiKey}`,
                ...(opts.extraHeaders ?? {}),
            };
            const res = await fetch(`${opts.apiUrl}/v1/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: opts.model,
                    messages: allMessages,
                    temperature: opts.temperature ?? 0.7,
                    max_tokens: opts.maxTokens ?? 4096,
                }),
            });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`LLM API error ${res.status}: ${body}`);
            }
            const data = (await res.json());
            const choices = data.choices;
            return {
                content: choices?.[0]?.message?.content ?? "",
                model: data.model ?? opts.model,
                usage: data.usage,
            };
        },
        async embed(input, overrides) {
            const model = overrides?.model ?? options.model;
            const res = await fetch(`${options.apiUrl}/v1/embeddings`, {
                method: "POST",
                headers: baseHeaders(),
                body: JSON.stringify({ model, input }),
            });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`LLM embeddings API error ${res.status}: ${body}`);
            }
            const data = (await res.json());
            const items = data.data ?? [];
            // Préserve l'ordre d'origine (OpenAI renvoie en général index croissant,
            // mais on s'en assure si le champ est présent).
            const ordered = items.every((it) => typeof it.index === "number")
                ? [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
                : items;
            return {
                embeddings: ordered.map((it) => it.embedding ?? []),
                model: data.model ?? model,
                usage: data.usage,
            };
        },
    };
}
/**
 * Auto-détecte le mode d'exécution :
 * - Mode plateforme : `PLATFORM_URL` + `AGENT_PLATFORM_TOKEN` injectés au spawn → route via le proxy LLM plateforme.
 * - Mode standalone : `LLM_API_URL` + `LLM_API_KEY` du `.env` local.
 *
 * Le mode plateforme est recommandé : pas de clé API à gérer dans l'agent, billing centralisé,
 * tracing par agentId, providers configurés une fois sur la plateforme.
 *
 * Note : le `model` par défaut (`llama-3.3-70b`) est un chat model. Pour
 * appeler `embed()`, passe un embedding model en override soit à
 * `getLLMClient({ model: 'text-embedding-3-small' })` soit directement à
 * `client.embed(input, { model: 'text-embedding-3-small' })`.
 */
export function getLLMClient(overrides) {
    const platformUrl = process.env.PLATFORM_URL;
    const agentToken = process.env.AGENT_PLATFORM_TOKEN;
    const agentId = process.env.AGENT_ID;
    const defaultModel = overrides?.model ?? process.env.LLM_MODEL ?? "llama-3.3-70b";
    if (platformUrl && agentToken) {
        return createLLM({
            apiUrl: `${platformUrl.replace(/\/$/, "")}/api/llm`,
            apiKey: agentToken,
            model: defaultModel,
            extraHeaders: agentId
                ? { "x-agent-id": agentId, "x-agent-token": agentToken }
                : { "x-agent-token": agentToken },
            ...overrides,
        });
    }
    const apiUrl = overrides?.apiUrl ?? process.env.LLM_API_URL;
    const apiKey = overrides?.apiKey ?? process.env.LLM_API_KEY;
    if (!apiUrl || !apiKey) {
        throw new Error("LLM config missing: set PLATFORM_URL+AGENT_PLATFORM_TOKEN (platform mode) or LLM_API_URL+LLM_API_KEY (standalone mode)");
    }
    return createLLM({ apiUrl, apiKey, model: defaultModel, ...overrides });
}
//# sourceMappingURL=llm.js.map