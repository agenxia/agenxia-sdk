// OpenAI-compatible LLM client

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
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export function createLLM(options: LLMOptions) {
  return {
    async chat(messages: ChatMessage[], overrides?: Partial<LLMOptions>): Promise<LLMResponse> {
      const opts = { ...options, ...overrides };
      const allMessages = opts.systemPrompt
        ? [{ role: "system" as const, content: opts.systemPrompt }, ...messages]
        : messages;

      const res = await fetch(`${opts.apiUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
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

      const data = await res.json() as Record<string, unknown>;
      const choices = data.choices as Array<{ message: { content: string } }> | undefined;
      return {
        content: choices?.[0]?.message?.content ?? "",
        model: (data.model as string) ?? opts.model,
        usage: data.usage as LLMResponse["usage"],
      };
    },
  };
}
