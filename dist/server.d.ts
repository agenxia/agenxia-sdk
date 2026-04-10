export interface ServerOptions {
    manifestPath?: string;
    port?: number;
    host?: string;
}
/**
 * Create and start the agent server.
 *
 * 1. Reads agenxia.json
 * 2. Loads workflow.json + LLM config
 * 3. Mounts routes: /health, /.well-known/agent-card.json, /docs, /a2a
 * 4. Starts the Fastify server
 */
export declare function createAgentServer(options?: ServerOptions): Promise<void>;
//# sourceMappingURL=server.d.ts.map