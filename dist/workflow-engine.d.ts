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
     * ID of the platform user who triggered this workflow run, when known.
     * LLM modules should forward it as the `user` param to OpenAI-compatible
     * APIs so LiteLLM attributes spend logs to the right user.
     */
    userId?: string;
    /**
     * Accumulator for structured logs. Captured lines are exposed on the
     * node's output under the `__log` key (system handle, bottom-left).
     */
    log?: (...args: unknown[]) => void;
    /**
     * For trigger modules in `listen()`: re-runs this node + its descendants.
     * The node's output is just `{__done: true}` (auto-injected), so any
     * downstream `__go` edge is satisfied.
     */
    triggerNode?: () => void;
    /**
     * For trigger modules that emit on a specific output port (e.g. a Drive
     * watcher pushing new files into a `files-out` port). Equivalent to
     * `engine.start(nodeId, { [portId]: value })` — the trigger module's
     * `execute()` should pass-through inputs to outputs (`return inputs`).
     */
    triggerPort?: (portId: string, value: unknown) => void;
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
/**
 * Subset of a module manifest that the engine reads at runtime — just
 * enough to drive init() flows. Other manifest fields (icon, color, full
 * port specs, etc.) are not needed inside the agent process.
 */
export interface ModuleManifestLite {
    id?: string;
    init?: {
        required?: boolean;
        label?: string;
        description?: string;
        produces?: string[];
    };
}
export interface InitNodeMetadata {
    node_id: string;
    module_id: string;
    label: string | null;
    description: string | null;
    required: boolean;
    produces: string[];
}
export interface InitContextPayload {
    phase: "start" | "complete";
    userId: string;
    callbackUrl: string;
    stateToken?: string;
    code?: string;
    state?: string;
}
export interface InitResult {
    status: "redirect" | "done" | "error";
    module_id?: string;
    url?: string;
    config?: Record<string, unknown>;
    message?: string;
}
export declare class WorkflowEngine {
    private readonly workflow;
    private readonly modulesDir;
    private readonly manifest;
    private readonly llm?;
    private _requestContext;
    private readonly moduleCache;
    private readonly manifestCache;
    private readonly history;
    private _userConfig;
    private lastOutputs;
    private lastContent;
    private runLock;
    private listenerCleanups;
    constructor(workflow: WorkflowDefinition, options: {
        modulesDir: string;
        manifest: AgentManifest;
        llm?: ReturnType<typeof createLLM>;
    });
    setRequestContext(ctx: {
        agentId?: string;
        platformUrl?: string;
        sessionId?: string;
        userId?: string;
    }): void;
    /**
     * Stores the per-user config map fetched from the platform
     * (`/api/agents/:id/user-config?user_id=…`). Keys are node IDs;
     * values are partial configs that override `node.data.config` for
     * the duration of the next run. Call before `start()` and clear
     * with `clearUserConfig()` afterwards if needed.
     */
    setUserConfig(map: Record<string, Record<string, unknown>>): void;
    clearUserConfig(): void;
    /**
     * Read a module's manifest.json from the agent's modules dir.
     * Returns null when the file is absent or invalid — manifests are
     * not strictly required at runtime, only by features that opt in
     * (init() flows, etc.).
     */
    private loadModuleManifest;
    /**
     * Walk the workflow's nodes and return the metadata for those whose
     * module declares an `init` section in its manifest. Used by
     * `/api/init/status` and the platform's setup page.
     */
    listInitNodes(): InitNodeMetadata[];
    /**
     * Resolve the param-admin inputs for a node, applying the same
     * priority order as `executeNode` minus upstream edges (which don't
     * exist at init time): pinned > config > default.
     */
    private resolveAdminConfig;
    /**
     * Invoke `execute.init(adminConfig, context)` for the module backing
     * the given node. Both phases of an OAuth flow go through here:
     * `phase: 'start'` returns a redirect URL, `phase: 'complete'`
     * receives the OAuth `code` and returns the produced config.
     */
    runModuleInit(nodeId: string, payload: InitContextPayload): Promise<InitResult>;
    /**
     * Boots long-running watchers from `listen()` exports of trigger modules.
     * Idempotent — disposes previous listeners first. Returns the count of
     * cleanups now registered. Call once after construction (and again
     * after `/api/sync` reloads the workflow).
     */
    initializeListeners(): Promise<number>;
    /**
     * Invoke all stored cleanups (e.g. clearInterval) on agent shutdown
     * or before re-init. Errors are logged, never thrown.
     */
    disposeListeners(): Promise<void>;
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