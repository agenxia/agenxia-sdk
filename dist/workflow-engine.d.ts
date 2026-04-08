import type { AgentManifest } from "./types.js";
import type { createLLM } from "./llm.js";
export interface WorkflowNode {
    id: string;
    type?: string;
    data?: {
        moduleId?: string;
        label?: string;
        config?: Record<string, unknown>;
        ports?: Record<string, unknown>;
        [key: string]: unknown;
    };
}
export interface WorkflowEdge {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
}
export interface WorkflowDefinition {
    entrypoint?: string;
    nodes: WorkflowNode[];
    edges: WorkflowEdge[];
}
export interface ChatHistoryMessage {
    role: "user" | "assistant" | "system";
    content: string;
}
export interface ModuleContext {
    manifest: AgentManifest;
    llm?: ReturnType<typeof createLLM>;
    nodeId: string;
    history?: ChatHistoryMessage[];
}
export type ModuleExecuteFn = (inputs: Record<string, unknown>, params: Record<string, unknown>, context: ModuleContext) => Promise<Record<string, unknown> | unknown> | Record<string, unknown> | unknown;
export interface WorkflowEngineOptions {
    workflowPath: string;
    modulesDir: string;
    manifest: AgentManifest;
    llm?: ReturnType<typeof createLLM>;
}
export interface WorkflowRunResult {
    content: string;
    messages: ChatHistoryMessage[];
}
export declare class WorkflowEngine {
    private readonly workflow;
    private readonly modulesDir;
    private readonly manifest;
    private readonly llm?;
    private readonly moduleCache;
    private readonly history;
    constructor(workflow: WorkflowDefinition, options: {
        modulesDir: string;
        manifest: AgentManifest;
        llm?: ReturnType<typeof createLLM>;
    });
    getHistory(): ChatHistoryMessage[];
    run(message: string): Promise<WorkflowRunResult>;
    private executeNode;
    private extractContent;
}
export declare function loadWorkflowDefinition(workflowPath: string): WorkflowDefinition | null;
export declare function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine | null;
export declare function defaultWorkflowPaths(manifestPath: string): {
    workflowPath: string;
    modulesDir: string;
};
//# sourceMappingURL=workflow-engine.d.ts.map