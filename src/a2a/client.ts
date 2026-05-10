import type {
  A2ARequest,
  A2AResponse,
  A2AResponseSuccess,
  A2AResult,
  AgentCard,
  ChatMessage,
  StreamEvent,
} from "./types.js";

function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Call an agent's A2A endpoint with a JSON-RPC request.
 */
export async function callAgent(
  url: string,
  method: string,
  params: Record<string, unknown>,
  options?: { agentId?: string; maxDepth?: number },
): Promise<A2AResult> {
  const request: A2ARequest = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  const response = await fetch(`${url}/a2a`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": options?.agentId ?? "platform",
      "X-Max-Depth": String(options?.maxDepth ?? 10),
      "X-Request-ID": generateRequestId(),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(
      `A2A call failed: ${response.status} ${response.statusText}`,
    );
  }

  const json = (await response.json()) as A2AResponse;

  if ("error" in json) {
    throw new Error(`A2A error ${json.error.code}: ${json.error.message}`);
  }

  return (json as A2AResponseSuccess).result;
}

/**
 * Discover an agent by fetching its AgentCard.
 */
export async function discoverAgent(url: string): Promise<AgentCard> {
  const response = await fetch(`${url}/.well-known/agent-card`);

  if (!response.ok) {
    throw new Error(`Agent discovery failed: ${response.status}`);
  }

  return (await response.json()) as AgentCard;
}

/**
 * Stream a chat conversation with an agent via SSE.
 */
export async function* streamChat(
  url: string,
  messages: ChatMessage[],
  options?: { agentId?: string; maxDepth?: number; context?: string },
): AsyncGenerator<StreamEvent> {
  const request: A2ARequest = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "chat",
    params: {
      messages,
      ...(options?.context ? { context: options.context } : {}),
    },
  };

  const response = await fetch(`${url}/a2a/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agent-ID": options?.agentId ?? "platform",
      "X-Max-Depth": String(options?.maxDepth ?? 10),
      "X-Request-ID": generateRequestId(),
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    throw new Error(`A2A stream failed: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data: ")) continue;

      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        yield JSON.parse(data) as StreamEvent;
      } catch {
        // skip malformed SSE lines
      }
    }
  }
}
