/** Handle MCP émis par un module mcp-* (mcp-stripe, mcp-qonto, mcp-hubspot…).
 *
 * Format conforme à la spec MCP officielle, identique pour les deux specs
 * provider :
 *   - Anthropic Messages MCP (beta `mcp-client-2025-11-20`) : envoyé dans
 *     `mcp_servers: [{type, url, name, authorization_token}]` au top-level.
 *   - OpenAI Responses MCP : envoyé dans `tools: [{type: "mcp", server_label,
 *     server_url, authorization}]` (alias de nommage des mêmes champs).
 *
 * `authorization_token` est le token **brut**, SANS préfixe `Bearer ` :
 * le scheme est ajouté par le serveur MCP cible selon son protocole d'auth.
 * Préfixer côté module produirait "Bearer Bearer …" et casserait l'auth.
 *
 * Le SDK transmet ce handle tel quel au LLM (format pivot Anthropic
 * Messages-style). La translation vers le wire format final du provider
 * (chat-completions → Messages, → Responses…) est la responsabilité de
 * l'infra (LiteLLM avec passthrough config, ou custom proxy plateforme). */
export interface MCPServerHandle {
    type: "url";
    name: string;
    url: string;
    authorization_token?: string;
}
export interface LLMOptions {
    /** URL COMPLETE du endpoint chat (OpenAI-compatible). Aucun suffixe ajoute par le SDK. */
    apiUrl: string;
    apiKey: string;
    /** Model identifier. Optional — resolved from env or platform defaults at call time. */
    model?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    /** Serveurs MCP à exposer au modèle pour ce call (ex: Stripe, Qonto). Requiert
     * un provider Anthropic ; le proxy plateforme strip ce champ pour les autres
     * providers. */
    mcpServers?: MCPServerHandle[];
    /** Headers additionnels propagés à chaque requête (ex. x-agent-id pour le proxy plateforme). */
    extraHeaders?: Record<string, string>;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
/** Bloc mcp_tool_use ou mcp_tool_result remonté par le proxy plateforme dans
 * une extension OpenAI non-standard (`__mcp_tool_uses`). Utile pour debug et
 * pour afficher les appels d'outils dans l'UI. */
export interface MCPToolBlock {
    type: "mcp_tool_use" | "mcp_tool_result";
    id?: string;
    name?: string;
    server_name?: string;
    input?: unknown;
    tool_use_id?: string;
    is_error?: boolean;
    content?: unknown;
}
export interface LLMResponse {
    content: string;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    mcp_tool_uses?: MCPToolBlock[];
}
export interface PlatformCustomProvider {
    name: string;
    url: string;
    api_key: string;
}
export interface PlatformDefaults {
    chat_model: string | null;
    image_model: string | null;
    /** Si `chat_model` matche un `custom_llm_providers[].name` configure dans
     * /settings, la plateforme renvoie ici les credentials a utiliser pour
     * appeler l'endpoint custom directement (bypass LiteLLM). Le module
     * llm-call/init.js s'en sert pour pre-remplir base_url et api_key. */
    custom_provider: PlatformCustomProvider | null;
    /** Fuseau horaire IANA resolu pour l'utilisateur appelant :
     * `user.timezone` (Profile) > `platform_settings.default_timezone`
     * (admin Settings) > `'Europe/Paris'`. Utilise par les modules qui
     * doivent ancrer du temps a l'heure locale (ex: cron). */
    timezone: string;
}
export interface LLMClient {
    chat(messages: ChatMessage[], overrides?: Partial<LLMOptions>): Promise<LLMResponse>;
}
interface PlatformContext {
    platformUrl: string;
    agentToken: string;
    agentId?: string;
}
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
export declare function getPlatformDefaults(ctx?: Partial<PlatformContext> & {
    force?: boolean;
}): Promise<PlatformDefaults>;
/** Resets the platform-defaults cache. Mainly for tests. */
export declare function resetPlatformDefaultsCache(): void;
export declare function createLLM(options: LLMOptions): LLMClient;
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
export declare function getLLMClient(overrides?: Partial<LLMOptions>): LLMClient;
export interface ImageOptions {
    /** Image model identifier. Falls back to `platform_settings.image_model`. */
    model?: string;
    /** Pixel size, e.g. `1024x1024`. */
    size?: string;
    /** Number of images to generate. */
    n?: number;
}
export interface ImageResponse {
    /** Generated images as URLs (or data URLs depending on backend config). */
    images: string[];
    model: string;
}
export interface ImageClient {
    generate(prompt: string, overrides?: ImageOptions): Promise<ImageResponse>;
}
/**
 * Image-generation client routed through the platform proxy.
 *
 * NOTE: the backend endpoint `${PLATFORM_URL}/api/llm/v1/images/generations`
 * is not implemented yet — this client surface is wired so modules can be
 * written against it today and start working as soon as the platform side
 * lands. Calls currently throw a clear "not implemented" error.
 */
export declare function getImageClient(overrides?: ImageOptions): ImageClient;
export {};
//# sourceMappingURL=llm.d.ts.map