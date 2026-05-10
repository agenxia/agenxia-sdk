// Platform-aware LLM/image client (chat + image generation).
//
// The platform proxy at ${PLATFORM_URL}/api/llm/* forwards requests to the
// configured LiteLLM backend; credentials live on the platform, not in the
// agent. `getLLMClient()` is the recommended entry point — it auto-detects
// platform vs standalone mode and falls back to the platform's
// `default_llm_model` (configurable via /settings) when the caller omits a
// model.
//
// Convention apiUrl : `apiUrl` est l'URL COMPLETE du endpoint chat
// (OpenAI-compatible). Le SDK ne suffixe rien. Exemples :
//   - OpenAI       : https://api.openai.com/v1/chat/completions
//   - Gemini       : https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
//   - Plateforme   : https://agenxia.anteika.fr/api/llm/v1/chat/completions
// Les embeddings sont gerees par un module dedie, pas par ce client.
let platformDefaultsCache = null;
/**
 * Récupère les modèles par défaut configurés côté plateforme via
 * `GET ${PLATFORM_URL}/api/llm/defaults`. Caché pour la durée du process —
 * en pratique le default change rarement et un agent peut être recyclé pour
 * le rafraîchir.
 *
 * Passer `force: true` pour bypasser le cache et fetch frais. Utile depuis
 * un init.js (Reconfigurer) où le user vient de modifier ses /settings et
 * attend que la nouvelle valeur soit prise en compte immediatement.
 */
export async function getPlatformDefaults(ctx) {
    if (!ctx?.force && platformDefaultsCache)
        return platformDefaultsCache;
    const platformUrl = ctx?.platformUrl ?? process.env.PLATFORM_URL;
    const agentToken = ctx?.agentToken ?? process.env.AGENT_PLATFORM_TOKEN;
    const agentId = ctx?.agentId ?? process.env.AGENT_ID;
    if (!platformUrl || !agentToken) {
        throw new Error("Cannot fetch platform defaults: PLATFORM_URL + AGENT_PLATFORM_TOKEN required");
    }
    platformDefaultsCache = (async () => {
        const url = `${platformUrl.replace(/\/$/, "")}/api/llm/defaults`;
        const headers = {
            Authorization: `Bearer ${agentToken}`,
            "x-agent-token": agentToken,
        };
        if (agentId)
            headers["x-agent-id"] = agentId;
        const res = await fetch(url, { headers });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`Failed to fetch platform defaults (${res.status}): ${body}`);
        }
        const json = (await res.json());
        return {
            chat_model: json.data?.chat_model ?? null,
            image_model: json.data?.image_model ?? null,
            custom_provider: json.data?.custom_provider ?? null,
            timezone: json.data?.timezone ?? "Europe/Paris",
        };
    })();
    // Reset cache on failure so the next caller can retry.
    platformDefaultsCache.catch(() => {
        platformDefaultsCache = null;
    });
    return platformDefaultsCache;
}
/** Resets the platform-defaults cache. Mainly for tests. */
export function resetPlatformDefaultsCache() {
    platformDefaultsCache = null;
}
export function createLLM(options) {
    const baseHeaders = (apiKey) => ({
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(options.extraHeaders ?? {}),
    });
    // Resolves a model — explicit > options > env > platform default.
    // Throws if nothing is resolvable.
    const resolveModel = async (explicit) => {
        if (explicit)
            return explicit;
        if (options.model)
            return options.model;
        if (process.env.LLM_MODEL)
            return process.env.LLM_MODEL;
        // Last resort: ask the platform. Only meaningful if the apiUrl looks
        // like the platform proxy — for standalone (LLM_API_URL) the call
        // would fail anyway, so we keep the explicit error.
        if (process.env.PLATFORM_URL && process.env.AGENT_PLATFORM_TOKEN) {
            const defaults = await getPlatformDefaults();
            if (defaults.chat_model)
                return defaults.chat_model;
        }
        throw new Error("No LLM model resolved: pass overrides.model, set LLM_MODEL env var, configure platform default_llm_model, or set the model in the workflow node config");
    };
    return {
        async chat(messages, overrides) {
            const opts = { ...options, ...overrides };
            const model = await resolveModel(overrides?.model);
            const allMessages = opts.systemPrompt
                ? [{ role: "system", content: opts.systemPrompt }, ...messages]
                : messages;
            // max_tokens : si non specifie, on n'envoie rien et le provider
            // utilise son propre defaut (Gemini 2.5 Flash = 8192, OpenAI = variable
            // selon model). Forcer un defaut bas (4096) tronquait silencieusement
            // les reponses longues.
            const body = {
                model,
                messages: allMessages,
                temperature: opts.temperature ?? 0.7,
            };
            if (opts.maxTokens !== undefined && opts.maxTokens !== null) {
                body.max_tokens = opts.maxTokens;
            }
            const res = await fetch(opts.apiUrl, {
                method: "POST",
                headers: baseHeaders(opts.apiKey),
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`LLM API error ${res.status}: ${body}`);
            }
            const data = (await res.json());
            const choices = data.choices;
            return {
                content: choices?.[0]?.message?.content ?? "",
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
 * Le mode plateforme est recommandé : pas de clé API à gérer dans l'agent,
 * billing centralisé, tracing par agentId, providers + default model
 * configurés une fois sur la plateforme.
 *
 * Le model est résolu paresseusement à chaque appel `chat()`, dans cet
 * ordre : `overrides.model` (call-site) → `options.model` (constructeur)
 * → `LLM_MODEL` env → `platform_settings.default_llm_model` via
 * `/api/llm/defaults`. Si rien n'est résolvable, l'appel throw avec un
 * message explicite.
 */
export function getLLMClient(overrides) {
    const platformUrl = process.env.PLATFORM_URL;
    const agentToken = process.env.AGENT_PLATFORM_TOKEN;
    const agentId = process.env.AGENT_ID;
    if (platformUrl && agentToken) {
        return createLLM({
            apiUrl: `${platformUrl.replace(/\/$/, "")}/api/llm/v1/chat/completions`,
            apiKey: agentToken,
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
    return createLLM({ apiUrl, apiKey, ...overrides });
}
/**
 * Image-generation client routed through the platform proxy.
 *
 * NOTE: the backend endpoint `${PLATFORM_URL}/api/llm/v1/images/generations`
 * is not implemented yet — this client surface is wired so modules can be
 * written against it today and start working as soon as the platform side
 * lands. Calls currently throw a clear "not implemented" error.
 */
export function getImageClient(overrides) {
    const platformUrl = process.env.PLATFORM_URL;
    const agentToken = process.env.AGENT_PLATFORM_TOKEN;
    const agentId = process.env.AGENT_ID;
    return {
        async generate(prompt, callOverrides) {
            if (!platformUrl || !agentToken) {
                throw new Error("Image generation requires platform mode: set PLATFORM_URL + AGENT_PLATFORM_TOKEN");
            }
            let model = callOverrides?.model ??
                overrides?.model ??
                process.env.IMAGE_MODEL ??
                undefined;
            if (!model) {
                const defaults = await getPlatformDefaults();
                model = defaults.image_model ?? undefined;
            }
            if (!model) {
                throw new Error("No image model resolved: pass overrides.model, set IMAGE_MODEL env var, or configure platform image_model in /settings");
            }
            const headers = {
                "Content-Type": "application/json",
                Authorization: `Bearer ${agentToken}`,
                "x-agent-token": agentToken,
            };
            if (agentId)
                headers["x-agent-id"] = agentId;
            const url = `${platformUrl.replace(/\/$/, "")}/api/llm/v1/images/generations`;
            const res = await fetch(url, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model,
                    prompt,
                    size: callOverrides?.size ?? overrides?.size ?? "1024x1024",
                    n: callOverrides?.n ?? overrides?.n ?? 1,
                }),
            });
            if (res.status === 404) {
                throw new Error("Image generation endpoint not implemented yet on platform — coming in a future release");
            }
            if (!res.ok) {
                const body = await res.text();
                throw new Error(`Image API error ${res.status}: ${body}`);
            }
            const data = (await res.json());
            const items = data.data ??
                [];
            const images = items
                .map((it) => it.url ??
                (it.b64_json ? `data:image/png;base64,${it.b64_json}` : ""))
                .filter((s) => s.length > 0);
            return { images, model: data.model ?? model };
        },
    };
}
//# sourceMappingURL=llm.js.map