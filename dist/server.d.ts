import type { AgentManifest, A2AResult } from "./types.js";
import { createLLM } from "./llm.js";
export interface ProcessContext {
    manifest: AgentManifest;
    llm?: ReturnType<typeof createLLM>;
    params: Record<string, unknown>;
    method: string;
    callerId: string;
    depth: number;
    requestId: string;
}
export type ProcessFunction = (ctx: ProcessContext) => Promise<A2AResult>;
export interface ServerOptions {
    manifestPath?: string;
    processPath?: string;
    port?: number;
    host?: string;
}
/**
 * Create and start the agent server.
 *
 * 1. Reads agenxia.json
 * 2. Imports process.js (if it exists)
 * 3. Mounts routes: /health, /.well-known/agent-card.json, /docs, /a2a
 * 4. Creates LLM client if config has LLM settings
 * 5. Starts the Fastify server
 */
export declare function createAgentServer(options?: ServerOptions): Promise<void>;
//# sourceMappingURL=server.d.ts.map