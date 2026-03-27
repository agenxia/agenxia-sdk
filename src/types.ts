// Agenxia SDK — Manifest & Config types

export interface PortDefinition {
  id: string;
  label: string;
  type: "input" | "output";
  description?: string;
}

export interface MethodParamDefinition {
  type: string;
  required?: boolean;
  description?: string;
}

export interface MethodReturnDefinition {
  type: string;
  description?: string;
}

export interface MethodDefinition {
  name: string;
  description?: string;
  params: Record<string, MethodParamDefinition>;
  returns?: Record<string, MethodReturnDefinition>;
  example?: {
    request: unknown;
    response: unknown;
  };
}

export interface ApiEndpointDefinition {
  method: string;
  path: string;
  description?: string;
}

export interface AgentConfig {
  system_prompt?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
}

export interface AgentManifest {
  name: string;
  version?: string;
  description?: string;
  type?: "agent" | "template" | "connector";
  source_template?: string;
  config?: AgentConfig;
  env_vars?: string[];
  ports?: PortDefinition[];
  methods?: MethodDefinition[];
  api?: ApiEndpointDefinition[];
  capabilities?: string[];
  features?: string[];
  ui?: {
    icon?: string;
    color?: string;
  };
}

// Re-export A2A types for convenience
export type {
  AgentCard,
  AgentCardMethod,
  AgentCardEndpoints,
  AgentCardMetadata,
  ChatMessage,
  A2ARequest,
  A2AResult,
  A2AError,
  A2AResponseSuccess,
  A2AResponseError,
  A2AResponse,
  StreamDelta,
  StreamMetadata,
  StreamEvent,
  HeartbeatPayload,
  HealthResponse,
  A2AHeaders,
  A2AMethodHandler,
  A2AStreamHandler,
  A2AMethodDefinition,
} from "./a2a/types.js";

export { A2A_ERROR_CODES } from "./a2a/types.js";
