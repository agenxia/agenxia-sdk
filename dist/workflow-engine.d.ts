import type { AgentManifest } from "./types.js";
import type { createLLM } from "./llm.js";
import { type PortType } from "./convert.js";
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
    convert: (value: unknown, fromType: PortType, toType: PortType) => unknown;
    agentId?: string;
    platformUrl?: string;
    sessionId?: string;
    /**
     * Accumulator for structured logs. Captured lines are exposed on the
     * node's output under the `__log` key (system handle, bottom-left).
     */
    log?: (...args: unknown[]) => void;
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
export interface StartOptions {
    onEvent?: WorkflowEventHandler;
}
/**
 * Build a label-keyed view of `inputs` using `node.data.ports.inputs`
 * (label ↔ id mapping). The original id-keyed entries are preserved
 * so callers that reference ports by id still resolve correctly.
 * Used internally for placeholder interpolation only — the module
 * itself keeps receiving the untouched `inputs`.
 */
export declare function buildNamedInputs(node: WorkflowNode, inputs: Record<string, unknown>): Record<string, unknown>;
/**
 * Replace `{{name}}` placeholders in every string field of `params`
 * with the matching value from `view`. Object / array inputs are
 * stringified via JSON.stringify(value, null, 2). Missing keys become
 * an empty string. Placeholder syntax: `{{ name }}` with optional
 * whitespace around the name. Recursive over nested objects / arrays.
 * Non-string leaves (numbers, booleans) are passed through untouched.
 */
export declare function interpolateParams(params: Record<string, unknown>, view: Record<string, unknown>): Record<string, unknown>;
export declare class WorkflowEngine {
    private readonly workflow;
    private readonly modulesDir;
    private readonly manifest;
    private readonly llm?;
    private _requestContext;
    private readonly moduleCache;
    private readonly history;
    private lastOutputs;
    private lastContent;
    private runLock;
    constructor(workflow: WorkflowDefinition, options: {
        modulesDir: string;
        manifest: AgentManifest;
        llm?: ReturnType<typeof createLLM>;
    });
    setRequestContext(ctx: {
        agentId?: string;
        platformUrl?: string;
        sessionId?: string;
    }): void;
    getHistory(): ChatHistoryMessage[];
    /** Snapshot of the last known outputs for every executed node. */
    getLastOutputs(): Record<string, unknown>;
    /**
     * Read-only snapshot of the engine's current state. Pure getter — no
     * execution, no mutation. Before any start() has run, returns empty
     * content, empty messages, and empty nodeOutputs.
     */
    getState(): WorkflowRunResult;
    private withLock;
    /**
     * Execute the workflow from a specific node.
     *
     * Single execution primitive of the engine. Covers both the initial
     * "run from scratch" and reactive re-execution from a widget:
     *
     * - `nodeId` defaults to `workflow.entrypoint`. Must exist.
     * - `values` are merged on top of the start node's computed inputs
     *   (which themselves come from resolveInputs on cached upstream
     *   outputs, if any). The start node then runs normally through its
     *   module (or passthrough).
     * - Only the start node and its descendants are re-executed. Nodes
     *   outside the descendant subgraph keep their cached outputs.
     * - On the first call `lastOutputs` is empty; descendants whose
     *   upstream dependencies are unresolved are simply skipped by the
     *   scheduler.
     * - `lastOutputs` is updated with the new outputs of executed nodes.
     *
     * Conversational workflows are a convention, not a feature: pass
     * `values: { message: "..." }` and let the edges route it where the
     * workflow author wired it.
     */
    start(nodeId?: string, values?: Record<string, unknown>, options?: StartOptions): Promise<WorkflowRunResult>;
    private _start;
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