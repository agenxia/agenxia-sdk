import type { A2AResult, AgentCard, ChatMessage, StreamEvent } from "./types.js";
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
//# sourceMappingURL=client.d.ts.map