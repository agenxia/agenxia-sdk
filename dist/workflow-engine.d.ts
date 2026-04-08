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
    nodeOutputs: Record<string, unknown>;
}
export type WorkflowEvent = {
    type: "node_start";
    nodeId: string;
    label?: string;
    moduleId?: string;
} | {
    type: "node_complete";
    nodeId: string;
    output: unknown;
    durationMs: number;
} | {
    type: "node_error";
    nodeId: string;
    error: string;
    durationMs: number;
} | {
    type: "edge_active";
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
} | {
    type: "workflow_complete";
    content: string;
    messages: ChatHistoryMessage[];
    nodeOutputs: Record<string, unknown>;
};
export type WorkflowEventHandler = (event: WorkflowEvent) => void;
export interface WorkflowRunOptions {
    onEvent?: WorkflowEventHandler;
}
export interface WorkflowTriggerOptions {
    onEvent?: WorkflowEventHandler;
}
export declare class WorkflowEngine {
    private readonly workflow;
    private readonly modulesDir;
    private readonly manifest;
    private readonly llm?;
    private readonly moduleCache;
    private readonly history;
    private lastOutputs;
    private hasRun;
    private runLock;
    constructor(workflow: WorkflowDefinition, options: {
        modulesDir: string;
        manifest: AgentManifest;
        llm?: ReturnType<typeof createLLM>;
    });
    getHistory(): ChatHistoryMessage[];
    /** Snapshot of the last known outputs for every executed node. */
    getLastOutputs(): Record<string, unknown>;
    private withLock;
    run(message: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult>;
    /**
     * Reactive re-execution from an interactive widget.
     *
     * Used when a node (typically a widget) emits new values on its output
     * ports — e.g. the user clicks a date in widget-calendar. Only the
     * descendants of nodeId are re-executed; upstream nodes keep their
     * cached outputs. nodeId itself is NOT re-executed: its output is set
     * to the merge of the previous cached output and portValues.
     *
     * Requires at least one prior run() call — without a warmed cache,
     * we cannot resolve inputs for descendants whose other predecessors
     * live upstream of nodeId.
     */
    triggerFromNode(nodeId: string, portValues: Record<string, unknown>, options?: WorkflowTriggerOptions): Promise<WorkflowRunResult>;
    private _runFull;
    private _triggerFromNode;
    private executeBatches;
    private makeEmitter;
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