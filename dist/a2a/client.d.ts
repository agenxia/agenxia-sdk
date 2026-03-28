import type { A2AResult, AgentCard, ChatMessage, HeartbeatPayload, StreamEvent } from "./types.js";
/**
 * Call an agent's A2A endpoint with a JSON-RPC request.
 */
export declare function callAgent(url: string, method: string, params: Record<string, unknown>, options?: {
    agentId?: string;
    maxDepth?: number;
}): Promise<A2AResult>;
/**
 * Discover an agent by fetching its AgentCard.
 */
export declare function discoverAgent(url: string): Promise<AgentCard>;
/**
 * Stream a chat conversation with an agent via SSE.
 */
export declare function streamChat(url: string, messages: ChatMessage[], options?: {
    agentId?: string;
    maxDepth?: number;
    context?: string;
}): AsyncGenerator<StreamEvent>;
/**
 * Send a heartbeat to the platform registry.
 */
export declare function sendHeartbeat(platformUrl: string, payload: HeartbeatPayload): Promise<void>;
/**
 * Start automatic heartbeat to platform registry.
 * Returns a cleanup function to stop the interval.
 */
export declare function startHeartbeat(platformUrl: string, payload: HeartbeatPayload, intervalMs?: number): () => void;
/**
 * Register an agent with the platform and start heartbeat.
 * Convenience function for local development.
 */
export declare function registerWithPlatform(platformUrl: string, agentId: string, agentUrl?: string): () => void;
//# sourceMappingURL=client.d.ts.map