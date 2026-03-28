import type { A2AMethodDefinition, A2AMethodHandler, A2AStreamHandler, AgentCard } from "./types.js";
interface MethodMap {
    [methodName: string]: A2AMethodDefinition;
}
/**
 * Create an A2A request handler for the /a2a endpoint.
 * Returns a function compatible with Web Request/Response API.
 */
export declare function createA2AHandler(methods: MethodMap): (req: Request) => Promise<Response>;
/**
 * Create an A2A streaming handler for the /a2a/stream endpoint.
 * Returns SSE responses.
 */
export declare function createA2AStreamHandler(methods: MethodMap): (req: Request) => Promise<Response>;
/**
 * Create the agent-card endpoint handler.
 */
export declare function createAgentCardHandler(card: AgentCard): () => Response;
/**
 * Create a health check endpoint handler.
 */
export declare function createHealthHandler(agentId: string, startTime: number): () => Response;
/**
 * Helper to define a simple chat method.
 */
export declare function defineChatMethod(handler: A2AMethodHandler, streamHandler?: A2AStreamHandler): A2AMethodDefinition;
export {};
//# sourceMappingURL=server.d.ts.map