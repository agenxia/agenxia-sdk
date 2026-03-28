// OpenAI-compatible LLM client
export function createLLM(options) {
    return {
        async chat(messages, overrides) {
            const opts = { ...options, ...overrides };
            const allMessages = opts.systemPrompt
                ? [{ role: "system", content: opts.systemPrompt }, ...messages]
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
            const data = await res.json();
            const choices = data.choices;
            return {
                content: choices?.[0]?.message?.content ?? "",
                model: data.model ?? opts.model,
                usage: data.usage,
            };
        },
    };
}
//# sourceMappingURL=llm.js.map