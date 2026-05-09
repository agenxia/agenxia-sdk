// Platform-aware LLM/image client (chat + embeddings + image generation).
//
// The platform proxy at ${PLATFORM_URL}/api/llm/* forwards requests to the
// configured LiteLLM backend; credentials live on the platform, not in the
// agent. `getLLMClient()` is the recommended entry point — it auto-detects
// platform vs standalone mode and falls back to the platform's
// `default_llm_model` (configurable via /settings) when the caller omits a
// model.

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
  /** Fuseau horaire IANA resolu pour l'utilisateur appelant :
   * `user.timezone` (Profile) > `platform_settings.default_timezone`
   * (admin Settings) > `'Europe/Paris'`. Utilise par les modules qui
   * doivent ancrer du temps a l'heure locale (ex: cron). */
  timezone: string;
}

export interface LLMClient {
  chat(
    messages: ChatMessage[],
    overrides?: Partial<LLMOptions>,
  ): Promise<LLMResponse>;
  /**
   * Génère des embeddings pour un texte ou un batch.
   *
   * Pour `embed()`, passe explicitement un embedding model en override
   * (ex. `text-embedding-3-small`) — le default plateforme est un chat
   * model, qui ne convient pas pour les embeddings.
   */
  embed(
    input: string | string[],
    overrides?: { model?: string },
  ): Promise<EmbeddingResponse>;
}

interface PlatformContext {
  platformUrl: string;
  agentToken: string;
  agentId?: string;
}

let platformDefaultsCache: Promise<PlatformDefaults> | null = null;

/**
 * Récupère les modèles par défaut configurés côté plateforme via
 * `GET ${PLATFORM_URL}/api/llm/defaults`. Caché pour la durée du process —
 * en pratique le default change rarement et un agent peut être recyclé pour
 * le rafraîchir.
 */
export async function getPlatformDefaults(
  ctx?: Partial<PlatformContext>,
): Promise<PlatformDefaults> {
  if (platformDefaultsCache) return platformDefaultsCache;

  const platformUrl = ctx?.platformUrl ?? process.env.PLATFORM_URL;
  const agentToken = ctx?.agentToken ?? process.env.AGENT_PLATFORM_TOKEN;
  const agentId = ctx?.agentId ?? process.env.AGENT_ID;

  if (!platformUrl || !agentToken) {
    throw new Error(
      "Cannot fetch platform defaults: PLATFORM_URL + AGENT_PLATFORM_TOKEN required",
    );
  }

  platformDefaultsCache = (async () => {
    const url = `${platformUrl.replace(/\/$/, "")}/api/llm/defaults`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${agentToken}`,
      "x-agent-token": agentToken,
    };
    if (agentId) headers["x-agent-id"] = agentId;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Failed to fetch platform defaults (${res.status}): ${body}`,
      );
    }
    const json = (await res.json()) as { data?: PlatformDefaults };
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
export function resetPlatformDefaultsCache(): void {
  platformDefaultsCache = null;
}

export function createLLM(options: LLMOptions): LLMClient {
  const baseHeaders = (apiKey: string): Record<string, string> => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...(options.extraHeaders ?? {}),
  });

  // Resolves a model — explicit > options > env > platform default.
  // Throws if nothing is resolvable.
  const resolveModel = async (
    explicit: string | undefined,
    isEmbedding: boolean,
  ): Promise<string> => {
    if (explicit) return explicit;
    if (options.model) return options.model;
    if (process.env.LLM_MODEL) return process.env.LLM_MODEL;

    // Last resort: ask the platform. Only meaningful if the apiUrl looks
    // like the platform proxy — for standalone (LLM_API_URL) the call
    // would fail anyway, so we keep the explicit error.
    if (process.env.PLATFORM_URL && process.env.AGENT_PLATFORM_TOKEN) {
      const defaults = await getPlatformDefaults();
      const candidate = isEmbedding ? null : defaults.chat_model;
      if (candidate) return candidate;
    }

    throw new Error(
      isEmbedding
        ? "No embedding model resolved: pass overrides.model — embedding models must be explicit"
        : "No LLM model resolved: pass overrides.model, set LLM_MODEL env var, configure platform default_llm_model, or set the model in the workflow node config",
    );
  };

  return {
    async chat(
      messages: ChatMessage[],
      overrides?: Partial<LLMOptions>,
    ): Promise<LLMResponse> {
      const opts = { ...options, ...overrides };
      const model = await resolveModel(overrides?.model, false);

      const allMessages = opts.systemPrompt
        ? [{ role: "system" as const, content: opts.systemPrompt }, ...messages]
        : messages;

      const res = await fetch(`${opts.apiUrl}/v1/chat/completions`, {
        method: "POST",
        headers: baseHeaders(opts.apiKey),
        body: JSON.stringify({
          model,
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
        model: (data.model as string) ?? model,
        usage: data.usage as LLMResponse["usage"],
      };
    },

    async embed(
      input: string | string[],
      overrides?: { model?: string },
    ): Promise<EmbeddingResponse> {
      const model = await resolveModel(overrides?.model, true);

      const res = await fetch(`${options.apiUrl}/v1/embeddings`, {
        method: "POST",
        headers: baseHeaders(options.apiKey),
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
export function getLLMClient(overrides?: Partial<LLMOptions>): LLMClient {
  const platformUrl = process.env.PLATFORM_URL;
  const agentToken = process.env.AGENT_PLATFORM_TOKEN;
  const agentId = process.env.AGENT_ID;

  if (platformUrl && agentToken) {
    return createLLM({
      apiUrl: `${platformUrl.replace(/\/$/, "")}/api/llm`,
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
    throw new Error(
      "LLM config missing: set PLATFORM_URL+AGENT_PLATFORM_TOKEN (platform mode) or LLM_API_URL+LLM_API_KEY (standalone mode)",
    );
  }
  return createLLM({ apiUrl, apiKey, ...overrides });
}

// ---------------------------------------------------------------------------
// Image generation (placeholder — backend endpoint pending)
// ---------------------------------------------------------------------------

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
export function getImageClient(overrides?: ImageOptions): ImageClient {
  const platformUrl = process.env.PLATFORM_URL;
  const agentToken = process.env.AGENT_PLATFORM_TOKEN;
  const agentId = process.env.AGENT_ID;

  return {
    async generate(
      prompt: string,
      callOverrides?: ImageOptions,
    ): Promise<ImageResponse> {
      if (!platformUrl || !agentToken) {
        throw new Error(
          "Image generation requires platform mode: set PLATFORM_URL + AGENT_PLATFORM_TOKEN",
        );
      }

      let model =
        callOverrides?.model ??
        overrides?.model ??
        process.env.IMAGE_MODEL ??
        undefined;
      if (!model) {
        const defaults = await getPlatformDefaults();
        model = defaults.image_model ?? undefined;
      }
      if (!model) {
        throw new Error(
          "No image model resolved: pass overrides.model, set IMAGE_MODEL env var, or configure platform image_model in /settings",
        );
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agentToken}`,
        "x-agent-token": agentToken,
      };
      if (agentId) headers["x-agent-id"] = agentId;

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
        throw new Error(
          "Image generation endpoint not implemented yet on platform — coming in a future release",
        );
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Image API error ${res.status}: ${body}`);
      }

      const data = (await res.json()) as Record<string, unknown>;
      const items =
        (data.data as Array<{ url?: string; b64_json?: string }> | undefined) ??
        [];
      const images = items
        .map(
          (it) =>
            it.url ??
            (it.b64_json ? `data:image/png;base64,${it.b64_json}` : ""),
        )
        .filter((s): s is string => s.length > 0);

      return { images, model: (data.model as string) ?? model };
    },
  };
}
