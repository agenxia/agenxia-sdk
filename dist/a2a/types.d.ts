export interface AgentCardMethod {
    name: string;
    description: string;
    params: Record<string, string>;
}
export interface AgentCardEndpoints {
    a2a: string;
    stream: string;
    health: string;
}
export interface AgentCardMetadata {
    author: string;
    model: string;
    provider: string;
    created: string;
}
export interface AgentCard {
    id: string;
    name: string;
    description: string;
    version: string;
    visibility: "public" | "private";
    capabilities: string[];
    methods: AgentCardMethod[];
    endpoints: AgentCardEndpoints;
    metadata: AgentCardMetadata;
}
export interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
}
export interface A2ARequest {
    jsonrpc: "2.0";
    id: number | string;
    method: string;
    params: Record<string, unknown>;
}
export interface A2AResult {
    content: string;
    metadata?: {
        model?: string;
        tokens?: number;
    };
}
export interface A2AError {
    code: number;
    message: string;
    data?: Record<string, unknown>;
}
export interface A2AResponseSuccess {
    jsonrpc: "2.0";
    id: number | string;
    result: A2AResult;
}
export interface A2AResponseError {
    jsonrpc: "2.0";
    id: number | string;
    error: A2AError;
}
export type A2AResponse = A2AResponseSuccess | A2AResponseError;
export interface StreamDelta {
    type: "text-delta";
    delta: string;
}
export interface StreamMetadata {
    type: "metadata";
    data: {
        model?: string;
        tokens?: number;
    };
}
export type StreamEvent = StreamDelta | StreamMetadata;
export interface HeartbeatPayload {
    agentId: string;
    url: string;
    status: "online" | "offline" | "error";
    metadata?: {
        version?: string;
        uptime?: number;
    };
}
export interface HealthResponse {
    status: "ok" | "error";
    agentId: string;
    uptime: number;
    version: string;
}
export interface A2AHeaders {
    "X-Agent-ID": string;
    "X-Max-Depth": string;
    "X-Request-ID": string;
}
export declare const A2A_ERROR_CODES: {
    readonly UNAUTHORIZED: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly INTERNAL_ERROR: -32603;
    readonly MAX_DEPTH_EXCEEDED: -32001;
    readonly AGENT_UNAVAILABLE: -32002;
};
export type A2AMethodHandler = (params: Record<string, unknown>, context: {
    callerId: string;
    depth: number;
    requestId: string;
}) => Promise<A2AResult>;
export type A2AStreamHandler = (params: Record<string, unknown>, context: {
    callerId: string;
    depth: number;
    requestId: string;
}) => AsyncGenerator<StreamEvent>;
export interface A2AMethodDefinition {
    handler: A2AMethodHandler;
    streamHandler?: A2AStreamHandler;
}
//# sourceMappingURL=types.d.ts.map