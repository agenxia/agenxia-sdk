function generateRequestId() {
    return crypto.randomUUID();
}
/**
 * Call an agent's A2A endpoint with a JSON-RPC request.
 */
export async function callAgent(url, method, params, options) {
    const request = {
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
        throw new Error(`A2A call failed: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json());
    if ("error" in json) {
        throw new Error(`A2A error ${json.error.code}: ${json.error.message}`);
    }
    return json.result;
}
/**
 * Discover an agent by fetching its AgentCard.
 */
export async function discoverAgent(url) {
    const response = await fetch(`${url}/.well-known/agent-card`);
    if (!response.ok) {
        throw new Error(`Agent discovery failed: ${response.status}`);
    }
    return (await response.json());
}
/**
 * Stream a chat conversation with an agent via SSE.
 */
export async function* streamChat(url, messages, options) {
    const request = {
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
    if (!reader)
        throw new Error("No response body");
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: "))
                continue;
            const data = trimmed.slice(6);
            if (data === "[DONE]")
                return;
            try {
                yield JSON.parse(data);
            }
            catch {
                // skip malformed SSE lines
            }
        }
    }
}
/**
 * Send a heartbeat to the platform registry.
 */
export async function sendHeartbeat(platformUrl, payload) {
    await fetch(`${platformUrl}/api/registry/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}
/**
 * Start automatic heartbeat to platform registry.
 * Returns a cleanup function to stop the interval.
 */
export function startHeartbeat(platformUrl, payload, intervalMs = 10_000) {
    const send = () => sendHeartbeat(platformUrl, payload).catch(() => { });
    send(); // send immediately
    const id = setInterval(send, intervalMs);
    return () => clearInterval(id);
}
/**
 * Register an agent with the platform and start heartbeat.
 * Convenience function for local development.
 */
export function registerWithPlatform(platformUrl, agentId, agentUrl) {
    const url = agentUrl ?? "http://localhost:3001";
    return startHeartbeat(platformUrl, {
        agentId,
        url,
        status: "online",
        metadata: { version: "2.0" },
    });
}
//# sourceMappingURL=client.js.map