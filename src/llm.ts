// OpenAI-compatible LLM client (chat + embeddings)

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
  chat(
    messages: ChatMessage[],
    overrides?: Partial<LLMOptions>,
  ): Promise<LLMResponse>;
  /**
   * Génère des embeddings pour un texte ou un batch.
   *
   * Note : le `model` par défaut de `getLLMClient()` est un chat model
   * (`llama-3.3-70b`). Pour `embed()`, passe explicitement un embedding
   * model en override (ex. `text-embedding-3-small`).
   */
  embed(
    input: string | string[],
    overrides?: { model?: string },
  ): Promise<EmbeddingResponse>;
}

export function createLLM(options: LLMOptions): LLMClient {
  const baseHeaders = (): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${options.apiKey}`,
    ...(options.extraHeaders ?? {}),
  });

  return {
    async chat(
      messages: ChatMessage[],
      overrides?: Partial<LLMOptions>,
    ): Promise<LLMResponse> {
      const opts = { ...options, ...overrides };
      const allMessages = opts.systemPrompt
        ? [{ role: "system" as const, content: opts.systemPrompt }, ...messages]
        : messages;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        ...(opts.extraHeaders ?? {}),
      };

      const res = await fetch(`${opts.apiUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
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

      const data = (await res.json()) as Record<string, unknown>;
      const choices = data.choices as
        | Array<{ message: { content: string } }>
        | undefined;
      return {
        content: choices?.[0]?.message?.content ?? "",
        model: (data.model as string) ?? opts.model,
        usage: data.usage as LLMResponse["usage"],
      };
    },

    async embed(
      input: string | string[],
      overrides?: { model?: string },
    ): Promise<EmbeddingResponse> {
      const model = overrides?.model ?? options.model;

      const res = await fetch(`${options.apiUrl}/v1/embeddings`, {
        method: "POST",
        headers: baseHeaders(),
        body: JSON.stringify({ model, input }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`LLM embeddings API error ${res.status}: ${body}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const items =
        (data.data as
          | Array<{ embedding: number[]; index?: number }>
          | undefined) ?? [];
      // Préserve l'ordre d'origine (OpenAI renvoie en général index croissant,
      // mais on s'en assure si le champ est présent).
      const ordered = items.every((it) => typeof it.index === "number")
        ? [...items].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        : items;
      return {
        embeddings: ordered.map((it) => it.embedding ?? []),
        model: (data.model as string) ?? model,
        usage: data.usage as EmbeddingResponse["usage"],
      };
    },
  };
}

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
export function getLLMClient(overrides?: Partial<LLMOptions>): LLMClient {
  const platformUrl = process.env.PLATFORM_URL;
  const agentToken = process.env.AGENT_PLATFORM_TOKEN;
  const agentId = process.env.AGENT_ID;
  const defaultModel =
    overrides?.model ?? process.env.LLM_MODEL ?? "llama-3.3-70b";

  if (platformUrl && agentToken) {
    return createLLM({
      apiUrl: `${platformUrl.replace(/\/$/, "")}/api/llm`,
      apiKey: agentToken,
      model: defaultModel,
      extraHeaders: agentId
        ? { "x-agent-id": agentId, "x-agent-token": agentToken }
        : { "x-agent-token": agentToken },
      ...overrides,
    });
  }

  const apiUrl = overrides?.apiUrl ?? process.env.LLM_API_URL;
  const apiKey = overrides?.apiKey ?? process.env.LLM_API_KEY;
  if (!apiUrl || !apiKey) {
    throw new Error(
      "LLM config missing: set PLATFORM_URL+AGENT_PLATFORM_TOKEN (platform mode) or LLM_API_URL+LLM_API_KEY (standalone mode)",
    );
  }
  return createLLM({ apiUrl, apiKey, model: defaultModel, ...overrides });
}
