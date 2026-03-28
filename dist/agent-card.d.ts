import type { AgentManifest } from "./types.js";
interface AgentCardOutput {
    name: string;
    description: string;
    version: string;
    protocol: string;
    capabilities: string[];
    config: Record<string, unknown>;
    env_vars: string[];
    endpoints: Record<string, string>;
    methods: Array<{
        name: string;
        description?: string;
        params: Record<string, unknown>;
        returns?: Record<string, unknown>;
        example?: {
            request: unknown;
            response: unknown;
        };
    }>;
    api: Array<{
        method: string;
        path: string;
        description: string;
    }>;
    metadata: Record<string, unknown>;
}
/**
 * Generate the full agent-card object from agenxia.json.
 */
export declare function generateAgentCard(options?: {
    rootDir?: string;
    deployUrl?: string;
    manifest?: AgentManifest;
}): AgentCardOutput;
export {};
//# sourceMappingURL=agent-card.d.ts.map