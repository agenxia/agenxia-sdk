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
export declare function createLLM(options: LLMOptions): {
    chat(messages: ChatMessage[], overrides?: Partial<LLMOptions>): Promise<LLMResponse>;
};
/**
 * Auto-détecte le mode d'exécution :
 * - Mode plateforme : `PLATFORM_URL` + `AGENT_PLATFORM_TOKEN` injectés au spawn → route via le proxy LLM plateforme.
 * - Mode standalone : `LLM_API_URL` + `LLM_API_KEY` du `.env` local.
 *
 * Le mode plateforme est recommandé : pas de clé API à gérer dans l'agent, billing centralisé,
 * tracing par agentId, providers configurés une fois sur la plateforme.
 */
export declare function getLLMClient(overrides?: Partial<LLMOptions>): {
    chat(messages: ChatMessage[], overrides?: Partial<LLMOptions>): Promise<LLMResponse>;
};
//# sourceMappingURL=llm.d.ts.map