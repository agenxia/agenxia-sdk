export interface LLMOptions {
    apiUrl: string;
    apiKey: string;
    model: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
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
//# sourceMappingURL=llm.d.ts.map