export interface LLMOptions {
    apiUrl: string;
    apiKey: string;
    /** Model identifier. Optional — resolved from env or platform defaults at call time. */
    model?: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    /** Headers additionnels propagés à chaque requête (ex. x-agent-id pour le proxy plateforme). */
    extraHeaders?: Record<string, string>;
}
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}
export interface LLMResponse {
    content: string;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}
export interface EmbeddingResponse {
    /** Toujours un tableau de vecteurs, même pour un input unique (longueur 1). */
    embeddings: number[][];
    model: string;
    usage?: {
        prompt_tokens: number;
        total_tokens: number;
    };
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
}
export interface LLMClient {
    chat(messages: ChatMessage[], overrides?: Partial<LLMOptions>): Promise<LLMResponse>;
    /**
     * Génère des embeddings pour un texte ou un batch.
     *
     * Pour `embed()`, passe explicitement un embedding model en override
     * (ex. `text-embedding-3-small`) — le default plateforme est un chat
     * model, qui ne convient pas pour les embeddings.
     */
    embed(input: string | string[], overrides?: {
        model?: string;
    }): Promise<EmbeddingResponse>;
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
 */
export declare function getPlatformDefaults(ctx?: Partial<PlatformContext>): Promise<PlatformDefaults>;
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
 * Le model est résolu paresseusement à chaque appel `chat()` / `embed()`,
 * dans cet ordre : `overrides.model` (call-site) → `options.model`
 * (constructeur) → `LLM_MODEL` env → `platform_settings.default_llm_model`
 * via `/api/llm/defaults`. Si rien n'est résolvable, l'appel throw avec un
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