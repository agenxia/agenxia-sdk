import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
// ---------------------------------------------------------------------------
// MCP client mode — Agenxia SDK acts as the MCP client itself, exposing
// remote MCP server tools to the LLM via the standard OpenAI function-calling
// format (`tools: [{type: "function", ...}]`). Works with ANY OpenAI-compat
// provider — no native MCP support required from the upstream LLM.
// ---------------------------------------------------------------------------
// Cap sur le nombre d'iterations de la boucle MCP (LLM → tool_call → tool_result → LLM…).
// Garde-fou anti boucle infinie et anti facture explosive. Si on atteint le cap
// sans que le modele ait emis une reponse finale (toolCalls.length === 0 → break
// avec finalContent), on fait un dernier call SANS tools pour forcer la synthese
// (cf runWithMcpClients). Le cap doit donc rester moderé : un modele qui chaine
// > N appels avant de conclure produira de toutes facons une reponse souvent
// hallucinée ou tronquée.
const MCP_MAX_ITERATIONS = 15;
const MCP_TOOL_NAME_SEP = "__";
/** Open one MCP client per declared server. Uses Streamable HTTP transport
 * (modern, works with Stripe/Anthropic-hosted MCP servers). Auth via Bearer
 * token if `authorization_token` is present on the handle. */
async function openMcpClients(servers) {
    const clients = new Map();
    for (const srv of servers) {
        if (!srv?.name || !srv?.url)
            continue;
        const client = new McpClient({ name: "agenxia-sdk", version: "2.11.0" }, { capabilities: {} });
        const transport = new StreamableHTTPClientTransport(new URL(srv.url), {
            requestInit: srv.authorization_token
                ? {
                    headers: {
                        Authorization: `Bearer ${srv.authorization_token}`,
                    },
                }
                : undefined,
        });
        await client.connect(transport);
        clients.set(srv.name, client);
    }
    return clients;
}
/** List tools across all clients and convert to OpenAI function-calling format.
 * Tool names are prefixed with `${serverName}__` to avoid collisions when
 * multiple MCP servers expose tools with the same name. */
async function listAndConvertMcpTools(clients) {
    const out = [];
    for (const [serverName, client] of clients) {
        const result = await client.listTools();
        for (const t of result.tools ?? []) {
            out.push({
                type: "function",
                function: {
                    name: `${serverName}${MCP_TOOL_NAME_SEP}${t.name}`,
                    description: t.description ?? undefined,
                    parameters: t.inputSchema ?? {
                        type: "object",
                        properties: {},
                    },
                },
            });
        }
    }
    return out;
}
/** Resolve a tool_call to the right MCP server and execute. Returns text
 * content (concatenated text blocks) plus an error flag. Errors are reported
 * back to the LLM as tool results so it can decide what to do next. */
async function executeMcpToolCall(toolCall, clients) {
    const fnName = toolCall.function.name;
    const sep = fnName.indexOf(MCP_TOOL_NAME_SEP);
    if (sep < 0) {
        return {
            content: `Unknown tool '${fnName}': missing server prefix`,
            isError: true,
        };
    }
    const serverName = fnName.slice(0, sep);
    const toolName = fnName.slice(sep + MCP_TOOL_NAME_SEP.length);
    const client = clients.get(serverName);
    if (!client) {
        return { content: `Unknown MCP server '${serverName}'`, isError: true };
    }
    let args = {};
    try {
        args = JSON.parse(toolCall.function.arguments || "{}");
    }
    catch (e) {
        return {
            content: `Invalid JSON arguments for ${fnName}: ${e instanceof Error ? e.message : String(e)}`,
            isError: true,
        };
    }
    try {
        const result = await client.callTool({ name: toolName, arguments: args });
        const blocks = result.content ?? [];
        const text = blocks
            .filter((b) => b?.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("\n");
        return {
            content: text || JSON.stringify(result.content ?? result),
            isError: Boolean(result.isError),
        };
    }
    catch (e) {
        return {
            content: `MCP tool call failed: ${e instanceof Error ? e.message : String(e)}`,
            isError: true,
        };
    }
}
/** Run a chat completion in MCP client mode: open clients, advertise tools
 * to the LLM, execute tool_calls server-side, loop until the LLM stops
 * calling tools. */
async function runWithMcpClients(mcpServers, initialMessages, model, opts, callChatCompletions) {
    const clients = await openMcpClients(mcpServers);
    const mcpToolUses = [];
    let finalUsage;
    let finalModel = model;
    let finalContent = "";
    try {
        const tools = await listAndConvertMcpTools(clients);
        // Conversation history accumulates as we loop. We keep raw assistant /
        // tool messages so the LLM has the full context for each iteration.
        const convo = [...initialMessages];
        for (let iter = 0; iter < MCP_MAX_ITERATIONS; iter++) {
            const body = {
                model,
                messages: convo,
                temperature: opts.temperature ?? 0.7,
                tools,
            };
            if (opts.maxTokens !== undefined && opts.maxTokens !== null) {
                body.max_tokens = opts.maxTokens;
            }
            const data = await callChatCompletions(body, opts.apiUrl, opts.apiKey);
            finalUsage = data.usage;
            finalModel = data.model ?? model;
            const choices = data.choices;
            const msg = choices?.[0]?.message;
            if (!msg) {
                // No assistant message — stop, surface what we have.
                break;
            }
            // Keep the raw assistant message so its tool_calls IDs match the
            // tool messages we'll append below (OpenAI API requirement).
            convo.push(msg);
            const toolCalls = msg.tool_calls ?? [];
            if (toolCalls.length === 0) {
                finalContent = msg.content ?? "";
                break;
            }
            for (const tc of toolCalls) {
                let parsedInput = {};
                try {
                    parsedInput = JSON.parse(tc.function.arguments || "{}");
                }
                catch {
                    parsedInput = { _raw: tc.function.arguments };
                }
                mcpToolUses.push({
                    type: "mcp_tool_use",
                    id: tc.id,
                    name: tc.function.name,
                    input: parsedInput,
                });
                const result = await executeMcpToolCall(tc, clients);
                mcpToolUses.push({
                    type: "mcp_tool_result",
                    tool_use_id: tc.id,
                    is_error: result.isError,
                    content: result.content,
                });
                convo.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: result.content,
                });
            }
        }
        // Force-summarize : si on est sorti de la boucle SANS reponse finale (cap
        // atteint en chaine de tool_calls), faire un dernier appel SANS tools pour
        // obliger le modele a synthetiser ce qu'il a deja appris. Sans ca,
        // finalContent reste "" et l'utilisateur voit une reponse vide (le bug
        // observe sur des prompts complexes type "trouve les emails des clients
        // qui ont paye X cette annee" qui chainent list_invoices + N fetches).
        if (!finalContent && mcpToolUses.length > 0) {
            convo.push({
                role: "user",
                content: "Tu as atteint la limite d'appels d'outils. Reponds maintenant en " +
                    "synthese a la question initiale, en utilisant uniquement les " +
                    "informations deja collectees ci-dessus. Si elles sont insuffisantes, " +
                    "dis-le clairement et indique ce qui manque.",
            });
            try {
                const body = {
                    model,
                    messages: convo,
                    temperature: opts.temperature ?? 0.7,
                    // PAS de `tools` — on force la synthese texte.
                };
                if (opts.maxTokens !== undefined && opts.maxTokens !== null) {
                    body.max_tokens = opts.maxTokens;
                }
                const data = await callChatCompletions(body, opts.apiUrl, opts.apiKey);
                const msg = data.choices?.[0]?.message;
                finalContent = msg?.content ?? "";
                if (data.usage)
                    finalUsage = data.usage;
            }
            catch (err) {
                // Sur echec de la synthese forcee, on laisse finalContent vide ;
                // l'appelant verra response="" et pourra remonter une erreur claire.
                console.warn("[llm] force-summarize failed:", err instanceof Error ? err.message : String(err));
            }
        }
    }
    finally {
        for (const client of clients.values()) {
            try {
                await client.close();
            }
            catch {
                /* swallow close errors */
            }
        }
    }
    return {
        content: finalContent,
        model: finalModel,
        usage: finalUsage,
        mcp_tool_uses: mcpToolUses.length > 0 ? mcpToolUses : undefined,
    };
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
    // POST /chat/completions sans MCP — utilisé directement quand aucun serveur
    // MCP n'est branché, et comme inner-loop quand on a une boucle tool-calling.
    const callChatCompletions = async (payload, apiUrl, apiKey) => {
        const res = await fetch(apiUrl, {
            method: "POST",
            headers: baseHeaders(apiKey),
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`LLM API error ${res.status}: ${body}`);
        }
        return (await res.json());
    };
    return {
        async chat(messages, overrides) {
            const opts = { ...options, ...overrides };
            const model = await resolveModel(overrides?.model);
            const allMessages = opts.systemPrompt
                ? [{ role: "system", content: opts.systemPrompt }, ...messages]
                : messages;
            // Cas simple : aucun serveur MCP — un seul POST chat/completions.
            if (!opts.mcpServers || opts.mcpServers.length === 0) {
                const body = {
                    model,
                    messages: allMessages,
                    temperature: opts.temperature ?? 0.7,
                };
                if (opts.maxTokens !== undefined && opts.maxTokens !== null) {
                    body.max_tokens = opts.maxTokens;
                }
                const data = await callChatCompletions(body, opts.apiUrl, opts.apiKey);
                const choices = data.choices;
                return {
                    content: choices?.[0]?.message?.content ?? "",
                    model: data.model ?? model,
                    usage: data.usage,
                };
            }
            // Mode client MCP : le SDK Agenxia agit comme client MCP, pas le LLM.
            // - Pour chaque serveur MCP : on ouvre une connexion, on liste les tools
            //   et on les convertit au format function-calling OpenAI standard.
            // - On envoie au LLM via `tools: [...]` standard (marche partout, aucun
            //   support MCP natif requis côté provider).
            // - Quand le LLM répond avec `tool_calls`, on les exécute côté SDK via
            //   le client MCP et on réinjecte les résultats comme messages `tool`.
            // - Boucle jusqu'à ce que le LLM réponde sans `tool_calls`, ou jusqu'à
            //   MCP_MAX_ITERATIONS (garde-fou anti boucle infinie).
            return runWithMcpClients(opts.mcpServers, allMessages, model, opts, callChatCompletions);
        },
        async embed(input, overrides) {
            // L'embedding model est distinct du chat model : on ne tombe jamais sur
            // options.model (qui est le chat model). overrides.model > EMBED_MODEL env.
            const model = overrides?.model ?? process.env.EMBED_MODEL;
            if (!model) {
                throw new Error("No embedding model resolved: pass overrides.model or set EMBED_MODEL env var (ex: text-embedding-3-small)");
            }
            // options.apiUrl est l'URL chat/completions. On dérive l'endpoint
            // embeddings : .../chat/completions → .../embeddings. Fonctionne pour le
            // proxy plateforme comme pour un endpoint OpenAI-compatible direct.
            const url = /\/chat\/completions\/?$/.test(options.apiUrl)
                ? options.apiUrl.replace(/\/chat\/completions\/?$/, "/embeddings")
                : `${options.apiUrl.replace(/\/$/, "")}/embeddings`;
            const inputs = Array.isArray(input) ? input : [input];
            const body = { model, input: inputs };
            if (overrides?.dimensions !== undefined) {
                body.dimensions = overrides.dimensions;
            }
            const res = await fetch(url, {
                method: "POST",
                headers: baseHeaders(options.apiKey),
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Embedding API error ${res.status}: ${text}`);
            }
            const data = (await res.json());
            const embeddings = (data.data ?? []).map((d) => d.embedding);
            return {
                embeddings,
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