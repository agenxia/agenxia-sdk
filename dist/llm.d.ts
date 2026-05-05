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
     * Pour `embed()`, passe explicitement un embedding model en override
     * (ex. `text-embedding-3-small`) — un chat model passé à
     * `getLLMClient()` ne convient pas pour les embeddings.
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
 * Le model doit être fourni explicitement — soit en override (`getLLMClient({ model })`),
 * soit via la variable d'env `LLM_MODEL`. L'absence de model lève une erreur.
 */
export declare function getLLMClient(overrides?: Partial<LLMOptions>): LLMClient;
//# sourceMappingURL=llm.d.ts.map