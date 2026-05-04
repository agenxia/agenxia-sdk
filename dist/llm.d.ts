export interface LLMOptions {
    apiUrl: string;
    apiKey: string;
    model: string;
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
export interface LLMClient {
    chat(messages: ChatMessage[], overrides?: Partial<LLMOptions>): Promise<LLMResponse>;
    /**
     * Génère des embeddings pour un texte ou un batch.
     *
     * Note : le `model` par défaut de `getLLMClient()` est un chat model
     * (`llama-3.3-70b`). Pour `embed()`, passe explicitement un embedding
     * model en override (ex. `text-embedding-3-small`).
     */
    embed(input: string | string[], overrides?: {
        model?: string;
    }): Promise<EmbeddingResponse>;
}
export declare function createLLM(options: LLMOptions): LLMClient;
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
export declare function getLLMClient(overrides?: Partial<LLMOptions>): LLMClient;
//# sourceMappingURL=llm.d.ts.map