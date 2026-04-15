// Local workflow engine — executes workflow.json autonomously.
//
// Agents embed this engine to run their own workflow without the platform.
// Modules are loaded from ./modules/<moduleId>/execute.js (CommonJS).
// A module without execute.js is treated as passthrough.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createRequire } from "node:module";
import type { AgentManifest } from "./types.js";
import type { createLLM } from "./llm.js";
import { convert, type PortType } from "./convert.js";

// ---------------------------------------------------------------------------
// Workflow types
// ---------------------------------------------------------------------------

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

export type ModuleExecuteFn = (
  inputs: Record<string, unknown>,
  params: Record<string, unknown>,
  context: ModuleContext,
) =>
  | Promise<Record<string, unknown> | unknown>
  | Record<string, unknown>
  | unknown;

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

// Streaming events emitted during workflow execution for live monitoring.
export type WorkflowEvent =
  | {
      type: "node_start";
      nodeId: string;
      label?: string;
      moduleId?: string;
    }
  | {
      type: "node_complete";
      nodeId: string;
      output: unknown;
      durationMs: number;
    }
  | {
      type: "node_error";
      nodeId: string;
      error: string;
      durationMs: number;
    }
  | {
      type: "edge_active";
      source: string;
      target: string;
      sourceHandle?: string | null;
      targetHandle?: string | null;
    }
  | {
      type: "workflow_complete";
      content: string;
      messages: ChatHistoryMessage[];
      nodeOutputs: Record<string, unknown>;
    };

export type WorkflowEventHandler = (event: WorkflowEvent) => void;

export interface StartOptions {
  onEvent?: WorkflowEventHandler;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

interface AdjEdge {
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

interface RevEdge {
  source: string;
  sourceHandle: string | null;
  targetHandle: string | null;
}

interface Graph {
  nodeMap: Map<string, WorkflowNode>;
  adjacency: Map<string, AdjEdge[]>;
  reverseAdj: Map<string, RevEdge[]>;
}

function buildGraph(nodes: WorkflowNode[], edges: WorkflowEdge[]): Graph {
  const nodeMap = new Map<string, WorkflowNode>();
  const adjacency = new Map<string, AdjEdge[]>();
  const reverseAdj = new Map<string, RevEdge[]>();

  for (const node of nodes) {
    nodeMap.set(node.id, node);
    adjacency.set(node.id, []);
    reverseAdj.set(node.id, []);
  }

  for (const edge of edges) {
    adjacency.get(edge.source)?.push({
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    });
    reverseAdj.get(edge.target)?.push({
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    });
  }

  return { nodeMap, adjacency, reverseAdj };
}

/**
 * Return the set of nodes reachable via outgoing edges from startId.
 * startId itself is NOT included — it is treated as already executed
 * (its output is supplied by the caller of triggerFromNode).
 */
function descendantsOf(
  startId: string,
  adjacency: Map<string, AdjEdge[]>,
): Set<string> {
  const visited = new Set<string>();
  const stack: string[] = [startId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    for (const edge of adjacency.get(id) ?? []) {
      if (!visited.has(edge.target) && edge.target !== startId) {
        visited.add(edge.target);
        stack.push(edge.target);
      }
    }
  }
  return visited;
}

/** BFS: is targetId reachable from sourceId in adjacency? Detects back-edges. */
function isReachable(
  sourceId: string,
  targetId: string,
  adjacency: Map<string, AdjEdge[]>,
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [sourceId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === targetId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const { target } of adjacency.get(current) ?? []) {
      if (!visited.has(target)) queue.push(target);
    }
  }
  return false;
}

/**
 * Build the inputs object for a node by routing data from upstream
 * executed predecessors according to their edges' port handles.
 *
 * Rules:
 * - Edge with BOTH sourceHandle and targetHandle: forwards only the
 *   `source.outputs[sourceHandle]` value, exposed on the target side
 *   under the key `targetHandle`. Missing source key yields the key
 *   with value `undefined` (present, not omitted).
 * - Edge without handles (legacy): merges the entire source output
 *   into the result via Object.assign. Preserves backwards
 *   compatibility for workflows generated before port routing.
 * - Multiple edges targeting the same `targetHandle`: last writer wins.
 * - Back-edges (source not yet executed) are skipped upstream by the
 *   filter on `executed`.
 */
function resolveInputs(
  nodeId: string,
  reverseAdj: Map<string, RevEdge[]>,
  outputs: Map<string, unknown>,
  executed: Set<string>,
): Record<string, unknown> {
  const incoming = reverseAdj.get(nodeId) ?? [];
  const activeEdges = incoming.filter((e) => executed.has(e.source));
  const result: Record<string, unknown> = {};

  for (const edge of activeEdges) {
    const src = outputs.get(edge.source);
    if (!src || typeof src !== "object") continue;
    const srcObj = src as Record<string, unknown>;

    const hasHandles =
      typeof edge.sourceHandle === "string" &&
      edge.sourceHandle.length > 0 &&
      typeof edge.targetHandle === "string" &&
      edge.targetHandle.length > 0;

    if (hasHandles) {
      // Port routing: forward only the named field, under the declared
      // target name. Missing source key is exposed as `undefined` so
      // modules can detect "wired but no value" distinctly from "not wired".
      result[edge.targetHandle as string] = srcObj[edge.sourceHandle as string];
    } else {
      // Legacy fallback: merge the whole output.
      Object.assign(result, srcObj);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Params interpolation — resolves `{{name}}` placeholders in a node's
// config against the node's inputs, keyed by port LABEL (what the user
// sees in the editor) rather than port ID (auto-generated, opaque).
// ---------------------------------------------------------------------------

/**
 * Build a label-keyed view of `inputs` using `node.data.ports.inputs`
 * (label ↔ id mapping). The original id-keyed entries are preserved
 * so callers that reference ports by id still resolve correctly.
 * Used internally for placeholder interpolation only — the module
 * itself keeps receiving the untouched `inputs`.
 */
export function buildNamedInputs(
  node: WorkflowNode,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const ports =
    (
      node.data?.ports as
        | { inputs?: Array<{ id?: string; label?: string }> }
        | undefined
    )?.inputs ?? [];
  const out: Record<string, unknown> = { ...inputs };
  for (const port of ports) {
    if (!port?.id) continue;
    const label = port.label?.trim();
    if (label && !(label in out)) {
      out[label] = inputs[port.id];
    }
  }
  return out;
}

/**
 * Replace `{{name}}` placeholders in every string field of `params`
 * with the matching value from `view`. Object / array inputs are
 * stringified via JSON.stringify(value, null, 2). Missing keys become
 * an empty string. Placeholder syntax: `{{ name }}` with optional
 * whitespace around the name. Recursive over nested objects / arrays.
 * Non-string leaves (numbers, booleans) are passed through untouched.
 */
export function interpolateParams(
  params: Record<string, unknown>,
  view: Record<string, unknown>,
): Record<string, unknown> {
  const placeholder = /\{\{\s*([^\s{}]+(?:\s+[^\s{}]+)*)\s*\}\}/g;
  const render = (val: unknown): unknown => {
    if (typeof val === "string") {
      if (!val.includes("{{")) return val;
      return val.replace(placeholder, (_m, key: string) => {
        const v = view[key];
        if (v == null) return "";
        if (typeof v === "string") return v;
        try {
          return JSON.stringify(v, null, 2);
        } catch {
          return String(v);
        }
      });
    }
    if (Array.isArray(val)) return val.map(render);
    if (val && typeof val === "object") {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) obj[k] = render(v);
      return obj;
    }
    return val;
  };
  return render(params) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

// Load modules/<id>/execute.js files that use CommonJS
// (module.exports = function) even when the agent's package.json has
// "type": "module".
//
// Modules are CJS but the agent is ESM ("type": "module"), so we
// can't use import() directly. Solution: read the source, wrap it in
// a CJS shim, and evaluate with `new Function`. A real `require`
// (via createRequire) is injected so modules can load npm packages.
function loadModuleSync(modulesDir: string, moduleId: string): ModuleExecuteFn {
  const execPath = join(modulesDir, moduleId, "execute.js");
  if (!existsSync(execPath)) {
    // Passthrough
    return async (inputs) => inputs as Record<string, unknown>;
  }
  try {
    const code = readFileSync(execPath, "utf-8");
    const wrapped = `
      const module = { exports: {} };
      const exports = module.exports;
      ${code}
      return module.exports;
    `;
    const factory = new Function("require", "fetch", "console", wrapped) as (
      req: (id: string) => unknown,
      f: typeof fetch,
      c: typeof console,
    ) => unknown;
    const moduleRequire = createRequire(execPath);
    const exported = factory(moduleRequire, globalThis.fetch, console);
    if (typeof exported === "function") return exported as ModuleExecuteFn;
    if (
      exported &&
      typeof (exported as { default?: unknown }).default === "function"
    ) {
      return (exported as { default: ModuleExecuteFn }).default;
    }
    console.warn(
      `[workflow] module ${moduleId} did not export a function, using passthrough`,
    );
    return async (inputs) => inputs as Record<string, unknown>;
  } catch (err) {
    console.warn(`[workflow] failed to load module ${moduleId}:`, err);
    return async (inputs) => inputs as Record<string, unknown>;
  }
}

async function loadModule(
  modulesDir: string,
  moduleId: string,
): Promise<ModuleExecuteFn> {
  return loadModuleSync(modulesDir, moduleId);
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class WorkflowEngine {
  private readonly workflow: WorkflowDefinition;
  private readonly modulesDir: string;
  private readonly manifest: AgentManifest;
  private readonly llm?: ReturnType<typeof createLLM>;
  private _requestContext: {
    agentId?: string;
    platformUrl?: string;
    sessionId?: string;
  } = {};
  private readonly moduleCache = new Map<string, ModuleExecuteFn>();
  private readonly history: ChatHistoryMessage[] = [];

  // Persistent output cache across start() calls. Reads: used as
  // upstream input source for nodes outside the subgraph being
  // re-executed. Writes: updated at the end of each start() with the
  // new outputs of executed nodes; nodes outside the subgraph keep
  // their previous values untouched.
  private lastOutputs: Map<string, unknown> = new Map();

  // Last extracted content (response/content/message from the most
  // recent start()). Empty string before any execution.
  private lastContent = "";

  // Mutex: serialize concurrent start() calls to prevent interleaved
  // mutations of lastOutputs.
  private runLock: Promise<unknown> = Promise.resolve();

  constructor(
    workflow: WorkflowDefinition,
    options: {
      modulesDir: string;
      manifest: AgentManifest;
      llm?: ReturnType<typeof createLLM>;
    },
  ) {
    this.workflow = workflow;
    this.modulesDir = options.modulesDir;
    this.manifest = options.manifest;
    this.llm = options.llm;
  }

  setRequestContext(ctx: {
    agentId?: string;
    platformUrl?: string;
    sessionId?: string;
  }): void {
    this._requestContext = ctx;
  }

  getHistory(): ChatHistoryMessage[] {
    return [...this.history];
  }

  /** Snapshot of the last known outputs for every executed node. */
  getLastOutputs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, v] of this.lastOutputs) out[id] = v;
    return out;
  }

  /**
   * Read-only snapshot of the engine's current state. Pure getter — no
   * execution, no mutation. Before any start() has run, returns empty
   * content, empty messages, and empty nodeOutputs.
   */
  getState(): WorkflowRunResult {
    return {
      content: this.lastContent,
      messages: [...this.history],
      nodeOutputs: this.getLastOutputs(),
    };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.runLock;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this.runLock = prev.then(() => gate).catch(() => gate);
    try {
      await prev;
    } catch {
      // previous run errored — we still proceed
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

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
  async start(
    nodeId?: string,
    values: Record<string, unknown> = {},
    options: StartOptions = {},
  ): Promise<WorkflowRunResult> {
    return this.withLock(() => this._start(nodeId, values, options));
  }

  // -------------------------------------------------------------------------
  // Internal: unified start implementation
  // -------------------------------------------------------------------------
  private async _start(
    requestedNodeId: string | undefined,
    values: Record<string, unknown>,
    options: StartOptions,
  ): Promise<WorkflowRunResult> {
    const emit = this.makeEmitter(options.onEvent);

    const { nodes, edges, entrypoint } = this.workflow;
    const graph = buildGraph(nodes, edges);
    const { nodeMap, adjacency, reverseAdj } = graph;

    const startId = requestedNodeId ?? entrypoint;
    if (!startId) {
      throw new Error(
        "start: no nodeId provided and workflow.entrypoint is not set",
      );
    }
    if (!nodeMap.has(startId)) {
      throw new Error(`start: node "${startId}" not found in workflow`);
    }

    // Subgraph = startId + all its descendants. Anything outside is
    // frozen: its cached output is reused as-is.
    const descendants = descendantsOf(startId, adjacency);
    const subgraph = new Set<string>([startId, ...descendants]);

    // Seed outputs from the cache, then drop stale entries for nodes
    // we are about to re-execute.
    const outputs = new Map<string, unknown>(this.lastOutputs);
    for (const id of subgraph) outputs.delete(id);

    // Seed `executed` with every non-subgraph node that has a cached
    // output: from the scheduler's point of view they are done.
    const executed = new Set<string>();
    for (const [id] of nodeMap) {
      if (!subgraph.has(id) && this.lastOutputs.has(id)) executed.add(id);
    }

    const initialReady = [startId];

    const executionOrder = await this.executeBatches({
      nodeMap,
      adjacency,
      reverseAdj,
      outputs,
      executed,
      initialReady,
      allowedNodes: subgraph,
      // Merge `values` on top of resolveInputs for the start node only.
      entryInputs: (id) => (id === startId ? values : null),
      emit,
    });

    const content = this.extractContent(outputs, adjacency, executionOrder);
    console.log(
      `[workflow] start from ${startId} complete — executed=[${executionOrder.join(", ")}] content="${content.slice(0, 80)}"`,
    );

    // Commit new outputs to the persistent cache. Non-subgraph nodes
    // keep their previous value. Also remember the extracted content
    // so getState() can serve it without re-running anything.
    for (const id of subgraph) {
      if (outputs.has(id)) this.lastOutputs.set(id, outputs.get(id));
    }
    this.lastContent = content;

    const nodeOutputs: Record<string, unknown> = {};
    for (const [id, v] of this.lastOutputs) nodeOutputs[id] = v;

    const finalMessages = [...this.history];
    emit({
      type: "workflow_complete",
      content,
      messages: finalMessages,
      nodeOutputs,
    });

    return { content, messages: finalMessages, nodeOutputs };
  }

  // -------------------------------------------------------------------------
  // Internal: shared BFS batch executor used by run() and triggerFromNode()
  // -------------------------------------------------------------------------
  private async executeBatches(params: {
    nodeMap: Map<string, WorkflowNode>;
    adjacency: Map<string, AdjEdge[]>;
    reverseAdj: Map<string, RevEdge[]>;
    outputs: Map<string, unknown>;
    executed: Set<string>;
    initialReady: string[];
    /** If set, only nodes in this set may be executed or queued. */
    allowedNodes: Set<string> | null;
    /** Seed inputs for an entrypoint-style node when its incoming edges are empty. */
    entryInputs: (nodeId: string) => Record<string, unknown> | null;
    emit: (e: WorkflowEvent) => void;
  }): Promise<string[]> {
    const {
      nodeMap,
      adjacency,
      reverseAdj,
      outputs,
      executed,
      allowedNodes,
      entryInputs,
      emit,
    } = params;

    const executionOrder: string[] = [];
    const isAllowed = (id: string): boolean =>
      allowedNodes === null || allowedNodes.has(id);

    let readyQueue = params.initialReady.filter((id) => isAllowed(id));

    while (readyQueue.length > 0) {
      const batch = readyQueue;
      const batchResults = await Promise.all(
        batch.map(async (nodeId) => {
          const node = nodeMap.get(nodeId);
          if (!node || executed.has(nodeId))
            return { nodeId, output: null, skip: true as const };

          let inputs = resolveInputs(nodeId, reverseAdj, outputs, executed);
          // For the start node, merge `values` on top of computed inputs.
          const entry = entryInputs(nodeId);
          if (entry) {
            inputs = { ...inputs, ...entry };
          }

          emit({
            type: "node_start",
            nodeId,
            label:
              typeof node.data?.label === "string"
                ? node.data.label
                : undefined,
            moduleId: node.data?.moduleId,
          });
          const startTs = Date.now();

          try {
            const output = await this.executeNode(node, inputs);
            const durationMs = Date.now() - startTs;
            // output === null → skip silencieux (go-mode sans signal).
            // Pas de node_complete : le node n'a pas tourné, il n'entre
            // ni dans `executed` ni dans `outputs`.
            if (output === null) {
              console.log(
                `[workflow] exec ${nodeId} skipped (go-mode, no signal)`,
              );
              return { nodeId, output: null, skip: true as const };
            }
            emit({ type: "node_complete", nodeId, output, durationMs });
            return { nodeId, output, skip: false as const };
          } catch (err) {
            const durationMs = Date.now() - startTs;
            const msg = err instanceof Error ? err.message : String(err);
            emit({ type: "node_error", nodeId, error: msg, durationMs });
            throw err;
          }
        }),
      );

      for (const r of batchResults) {
        if (r.skip) {
          // Un node skippé (go-mode sans signal, ou déjà exécuté) doit être
          // marqué `executed` pour ne pas être replanifié — sinon le scheduler
          // boucle indéfiniment car ses préds sont déjà exécutés.
          // Pas d'entrée dans `outputs` : les downstream verront src=undefined
          // via resolveInputs et en déduiront qu'il n'y a rien à propager.
          executed.add(r.nodeId);
          continue;
        }
        outputs.set(r.nodeId, r.output);
        executed.add(r.nodeId);
        executionOrder.push(r.nodeId);
        for (const e of adjacency.get(r.nodeId) ?? []) {
          emit({
            type: "edge_active",
            source: r.nodeId,
            target: e.target,
            sourceHandle: e.sourceHandle,
            targetHandle: e.targetHandle,
          });
        }
      }

      // Compute next ready batch, restricted to allowedNodes if set.
      const nextReady: string[] = [];
      for (const [nodeId] of nodeMap) {
        if (executed.has(nodeId)) continue;
        if (!isAllowed(nodeId)) continue;
        const incoming = reverseAdj.get(nodeId) ?? [];
        if (incoming.length === 0) continue;
        const allResolved = incoming.every((e) => {
          if (executed.has(e.source)) return true;
          return isReachable(nodeId, e.source, adjacency);
        });
        const hasAnyExecutedPred = incoming.some((e) => executed.has(e.source));
        if (allResolved && hasAnyExecutedPred) nextReady.push(nodeId);
      }
      readyQueue = nextReady;
    }

    return executionOrder;
  }

  private makeEmitter(
    onEvent: WorkflowEventHandler | undefined,
  ): (e: WorkflowEvent) => void {
    return (e) => {
      if (!onEvent) return;
      try {
        onEvent(e);
      } catch (err) {
        console.warn("[workflow] onEvent threw:", err);
      }
    };
  }

  private async executeNode(
    node: WorkflowNode,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    const moduleId = node.data?.moduleId;

    // --- System handle: __go (gate simple) ---
    // Si __go est câblé, on exécute seulement si la valeur reçue est truthy.
    // Falsy (undefined, null, false, 0, "") → skip silencieux (downstream non activé).
    // Aucune contrainte sur les autres inputs : un node-source (ex: RSS) peut
    // être déclenché uniquement via __go, sans data input amont.
    if ("__go" in inputs) {
      if (!inputs["__go"]) return null;
      const { __go: _go, ...regularInputs } = inputs;
      inputs = regularInputs;
    }

    // Resolve input values using the canonical hierarchy (most to least
    // specific):
    //   1. port.value    — constant pinned in the node editor sidebar
    //                      (overrides EVERYTHING, including upstream edges)
    //   2. inputs[id]    — value coming from an upstream edge via
    //                      resolveInputs (already populated before)
    //   3. config[id]    — admin/user override saved in node.data.config
    //                      (from the workflow "Paramètres" panel)
    //   4. port.default  — fallback declared in the module manifest
    //
    // The `scope` field on a port (input | param-admin | param-user) is
    // purely UI metadata — the engine resolves values the same way for
    // every scope. The editor controls which UI surface exposes it.
    const inputPorts =
      (
        node.data?.ports as
          | {
              inputs?: Array<{
                id?: string;
                value?: unknown;
                default?: unknown;
                scope?: string;
              }>;
            }
          | undefined
      )?.inputs ?? [];
    const configMap = (node.data?.config as Record<string, unknown>) ?? {};
    for (const port of inputPorts) {
      if (!port?.id) continue;
      if (port.value !== undefined) {
        // Pinned constant — wins over upstream edges.
        inputs[port.id] = port.value;
        continue;
      }
      if (inputs[port.id] !== undefined) continue; // edge provided a value
      if (port.id in configMap && configMap[port.id] !== undefined) {
        inputs[port.id] = configMap[port.id];
        continue;
      }
      if (port.default !== undefined) {
        inputs[port.id] = port.default;
      }
    }
    // Final fallback: any config key not yet exposed in inputs is
    // surfaced directly. This lets modules migrated to the unified
    // signature (reading inputs.foo instead of params.foo) work with
    // legacy workflow.json files where node.data.ports.inputs does
    // not yet mention every ex-parameter.
    for (const [k, v] of Object.entries(configMap)) {
      if (v === undefined) continue;
      if (inputs[k] === undefined) inputs[k] = v;
    }

    const inputKeys = Object.keys(inputs).join(",") || "(none)";
    if (!moduleId) {
      console.log(
        `[workflow] exec ${node.id} (passthrough) inputs={${inputKeys}}`,
      );
      return { ...inputs, __done: true };
    }

    let fn = this.moduleCache.get(moduleId);
    if (!fn) {
      fn = await loadModule(this.modulesDir, moduleId);
      this.moduleCache.set(moduleId, fn);
    }

    const rawParams = (node.data?.config as Record<string, unknown>) ?? {};
    const namedInputs = buildNamedInputs(node, inputs);
    const params = interpolateParams(rawParams, namedInputs);
    const logs: string[] = [];
    const context: ModuleContext = {
      manifest: this.manifest,
      llm: this.llm,
      nodeId: node.id,
      history: [...this.history],
      convert,
      agentId: this._requestContext.agentId,
      platformUrl: this._requestContext.platformUrl,
      sessionId: this._requestContext.sessionId,
      log: (...args: unknown[]) =>
        logs.push(
          args
            .map((a) =>
              typeof a === "string"
                ? a
                : (() => {
                    try {
                      return JSON.stringify(a);
                    } catch {
                      return String(a);
                    }
                  })(),
            )
            .join(" "),
        ),
    };
    console.log(
      `[workflow] exec ${node.id} (module=${moduleId}) inputs={${inputKeys}} hasLLM=${!!this.llm}`,
    );

    try {
      const result = await fn(inputs, params, context);
      const out =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)
          : { value: result };
      // System outputs: __done (toujours true), __log (si logs émis), __error (miroir de out.error).
      out.__done = true;
      if (logs.length > 0) out.__log = logs.join("\n");
      if (
        "error" in out &&
        out.error !== undefined &&
        out.__error === undefined
      ) {
        out.__error = out.error;
      }
      const outKeys = Object.keys(out).join(",") || "(none)";
      console.log(`[workflow] exec ${node.id} → output={${outKeys}}`);
      return out;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[workflow] exec ${node.id} ERROR:`, msg);
      throw new Error(`[module:${moduleId}] ${msg}`);
    }
  }

  private extractContent(
    outputs: Map<string, unknown>,
    adjacency: Map<string, AdjEdge[]>,
    executionOrder: string[],
  ): string {
    const getField = (out: unknown, key: string): string | null => {
      if (!out || typeof out !== "object") return null;
      const v = (out as Record<string, unknown>)[key];
      return typeof v === "string" && v !== "" ? v : null;
    };

    // Priority 1: `response` from any executed node (LLM modules emit
    // this — agent-core, etc.). Walk in reverse execution order so the
    // most recent LLM response wins in cyclic workflows.
    for (let i = executionOrder.length - 1; i >= 0; i--) {
      const id = executionOrder[i]!;
      const v = getField(outputs.get(id), "response");
      if (v) return v;
    }

    // Priority 2: `content` field anywhere (newest first).
    for (let i = executionOrder.length - 1; i >= 0; i--) {
      const id = executionOrder[i]!;
      const v = getField(outputs.get(id), "content");
      if (v) return v;
    }

    // Priority 3: sink nodes (no outgoing edges) with message/text.
    const sinks: string[] = [];
    for (const [nodeId, edges] of adjacency) {
      if (edges.length === 0 && outputs.has(nodeId)) sinks.push(nodeId);
    }
    for (const id of sinks) {
      const out = outputs.get(id);
      const m = getField(out, "message") ?? getField(out, "text");
      if (m) return m;
    }

    // Last resort: last executed output, stringified.
    const lastKey = executionOrder[executionOrder.length - 1];
    const last = lastKey ? outputs.get(lastKey) : undefined;
    if (typeof last === "string") return last;
    return last ? JSON.stringify(last) : "";
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function loadWorkflowDefinition(
  workflowPath: string,
): WorkflowDefinition | null {
  if (!existsSync(workflowPath)) return null;
  try {
    const raw = readFileSync(workflowPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<WorkflowDefinition>;
    if (!parsed.nodes || !Array.isArray(parsed.nodes)) return null;
    return {
      entrypoint: parsed.entrypoint,
      nodes: parsed.nodes,
      edges: parsed.edges ?? [],
    };
  } catch (err) {
    console.warn(`[workflow] failed to parse ${workflowPath}:`, err);
    return null;
  }
}

export function createWorkflowEngine(
  options: WorkflowEngineOptions,
): WorkflowEngine | null {
  const def = loadWorkflowDefinition(options.workflowPath);
  if (!def) return null;
  const modulesDir = resolve(options.modulesDir);
  return new WorkflowEngine(def, {
    modulesDir,
    manifest: options.manifest,
    llm: options.llm,
  });
}

// Helper to resolve default paths relative to a manifest directory
export function defaultWorkflowPaths(manifestPath: string): {
  workflowPath: string;
  modulesDir: string;
} {
  const dir = dirname(resolve(manifestPath));
  return {
    workflowPath: join(dir, "workflow.json"),
    modulesDir: join(dir, "modules"),
  };
}
