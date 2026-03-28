interface DocCard {
    name: string;
    description?: string;
    version?: string;
    protocol?: string;
    type?: string;
    config?: Record<string, unknown>;
    methods?: Array<{
        name: string;
        description?: string;
        params?: Record<string, {
            type?: string;
            required?: boolean;
            description?: string;
        }>;
        returns?: Record<string, {
            type?: string;
            description?: string;
        }>;
        example?: {
            request: unknown;
            response: unknown;
        };
    }>;
    api?: Array<{
        method: string;
        path: string;
        description?: string;
    }>;
    env_vars?: string[];
    metadata?: Record<string, unknown>;
}
/**
 * Generate a complete HTML documentation page for an agent.
 */
export declare function generateDocs(card: DocCard, baseUrl?: string): string;
export {};
//# sourceMappingURL=docs.d.ts.map