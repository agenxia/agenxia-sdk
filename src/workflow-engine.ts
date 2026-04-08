// Local workflow engine — executes workflow.json autonomously.
//
// Agents embed this engine to run their own workflow without the platform.
// Modules are loaded from ./modules/<moduleId>/execute.js (CommonJS).
// A module without execute.js is treated as passthrough.

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import type { AgentManifest } from "./types.js";
import type { createLLM } from "./llm.js";

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

export interface WorkflowRunOptions {
  onEvent?: WorkflowEventHandler;
}

export interface WorkflowTriggerOptions {
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
// Module loader
// ---------------------------------------------------------------------------

// Load modules/<id>/execute.js files that use CommonJS
// (module.exports = function) even when the agent's package.json has
// "type": "module".
//
// Neither import() nor createRequire() work here: Node resolves .js
// format from the nearest package.json, so a CJS-style file under an
// ESM package is rejected with "module is not defined".
//
// Solution (matches the platform's own runner): read the source, wrap
// it in a CJS shim, and evaluate with `new Function`.
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
    const noRequire = (id: string) => {
      throw new Error(`require('${id}') not available in module sandbox`);
    };
    const exported = factory(noRequire, globalThis.fetch, console);
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
  private readonly moduleCache = new Map<string, ModuleExecuteFn>();
  private readonly history: ChatHistoryMessage[] = [];

  // Persistent output cache across runs. Populated by run() and
  // triggerFromNode(), read by triggerFromNode() to reuse upstream values
  // without re-executing ancestors.
  private lastOutputs: Map<string, unknown> = new Map();
  private hasRun = false;

  // Mutex: serialize run() and triggerFromNode() to prevent concurrent
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

  getHistory(): ChatHistoryMessage[] {
    return [...this.history];
  }

  /** Snapshot of the last known outputs for every executed node. */
  getLastOutputs(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [id, v] of this.lastOutputs) out[id] = v;
    return out;
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

  async run(
    message: string,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    return this.withLock(() => this._runFull(message, options));
  }

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
  async triggerFromNode(
    nodeId: string,
    portValues: Record<string, unknown>,
    options: WorkflowTriggerOptions = {},
  ): Promise<WorkflowRunResult> {
    return this.withLock(() =>
      this._triggerFromNode(nodeId, portValues, options),
    );
  }

  // -------------------------------------------------------------------------
  // Internal: full workflow run (classic chat message entry)
  // -------------------------------------------------------------------------
  private async _runFull(
    message: string,
    options: WorkflowRunOptions,
  ): Promise<WorkflowRunResult> {
    const emit = this.makeEmitter(options.onEvent);

    this.history.push({ role: "user", content: message });

    const { nodes, edges, entrypoint } = this.workflow;
    const graph = buildGraph(nodes, edges);
    const { nodeMap, adjacency, reverseAdj } = graph;

    const outputs = new Map<string, unknown>();
    const executed = new Set<string>();

    // Determine roots: nodes without incoming edges.
    const roots: string[] = [];
    for (const [nodeId] of nodeMap) {
      if ((reverseAdj.get(nodeId) ?? []).length === 0) roots.push(nodeId);
    }
    // If no roots (cyclic) and entrypoint provided, use it.
    if (roots.length === 0 && entrypoint && nodeMap.has(entrypoint)) {
      roots.push(entrypoint);
    }
    // Entrypoint node gets the message as passthrough input.
    const entryIds = new Set<string>(
      entrypoint && nodeMap.has(entrypoint) ? [entrypoint] : roots,
    );

    const initialReady =
      roots.length > 0 ? [...roots] : entrypoint ? [entrypoint] : [];
    if (initialReady.length === 0) {
      throw new Error("Workflow has no executable entry node");
    }

    const executionOrder = await this.executeBatches({
      nodeMap,
      adjacency,
      reverseAdj,
      outputs,
      executed,
      initialReady,
      allowedNodes: null, // full graph
      entryInputs: (id) => (entryIds.has(id) ? { message } : null),
      emit,
    });

    const content = this.extractContent(outputs, adjacency, executionOrder);
    console.log(
      `[workflow] run complete — executed=[${executionOrder.join(", ")}] content="${content.slice(0, 80)}"`,
    );
    this.history.push({ role: "assistant", content });

    // Persist outputs for future reactive triggers
    this.lastOutputs = new Map(outputs);
    this.hasRun = true;

    const nodeOutputs: Record<string, unknown> = {};
    for (const [id, out] of outputs) nodeOutputs[id] = out;

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
  // Internal: reactive subgraph re-execution
  // -------------------------------------------------------------------------
  private async _triggerFromNode(
    startId: string,
    portValues: Record<string, unknown>,
    options: WorkflowTriggerOptions,
  ): Promise<WorkflowRunResult> {
    if (!this.hasRun) {
      throw new Error(
        "triggerFromNode: no previous run — call run() first to warm the output cache",
      );
    }
    const emit = this.makeEmitter(options.onEvent);

    const { nodes, edges } = this.workflow;
    const graph = buildGraph(nodes, edges);
    const { nodeMap, adjacency, reverseAdj } = graph;

    if (!nodeMap.has(startId)) {
      throw new Error(
        `triggerFromNode: node "${startId}" not found in workflow`,
      );
    }

    // Validate portValues against declared ports if any — warn, don't throw.
    const declaredPorts = nodeMap.get(startId)?.data?.ports;
    if (declaredPorts && typeof declaredPorts === "object") {
      const known = new Set(Object.keys(declaredPorts));
      for (const key of Object.keys(portValues)) {
        if (!known.has(key)) {
          console.warn(
            `[workflow] triggerFromNode: port "${key}" not declared on node "${startId}"`,
          );
        }
      }
    }

    // Log the interaction as a system entry (not a user message).
    this.history.push({
      role: "system",
      content: `[widget ${startId} → ${JSON.stringify(portValues)}]`,
    });

    // Seed outputs from the cache and merge portValues into startId's entry.
    const outputs = new Map<string, unknown>(this.lastOutputs);
    const prevStartOut = this.lastOutputs.get(startId);
    const mergedStartOut = {
      ...(prevStartOut && typeof prevStartOut === "object"
        ? (prevStartOut as Record<string, unknown>)
        : {}),
      ...portValues,
    };
    outputs.set(startId, mergedStartOut);

    // Compute downstream subgraph.
    const subgraph = descendantsOf(startId, adjacency);

    // Seed executed with everything OUTSIDE the subgraph (they are
    // considered already-done, backed by lastOutputs). startId is also
    // marked executed so its merged output is used by descendants.
    const executed = new Set<string>();
    for (const [id] of nodeMap) {
      if (!subgraph.has(id)) executed.add(id);
    }

    // No descendants — nothing to re-run. Still persist the new startId
    // output and emit workflow_complete immediately.
    if (subgraph.size === 0) {
      this.lastOutputs.set(startId, mergedStartOut);
      const nodeOutputs: Record<string, unknown> = {};
      for (const [id, v] of this.lastOutputs) nodeOutputs[id] = v;
      const content = this.extractContent(outputs, adjacency, [startId]);
      const finalMessages = [...this.history];
      emit({
        type: "workflow_complete",
        content,
        messages: finalMessages,
        nodeOutputs,
      });
      return { content, messages: finalMessages, nodeOutputs };
    }

    // Initial ready = direct descendants of startId whose other
    // predecessors are all outside the subgraph (and therefore already
    // marked executed via seeding).
    const initialReady: string[] = [];
    for (const id of subgraph) {
      const incoming = reverseAdj.get(id) ?? [];
      // Must have at least one incoming from startId or an executed source.
      const hasAnyExecutedPred = incoming.some((e) => executed.has(e.source));
      const allResolved = incoming.every((e) => {
        if (executed.has(e.source)) return true;
        return isReachable(id, e.source, adjacency);
      });
      if (hasAnyExecutedPred && allResolved) initialReady.push(id);
    }

    const executionOrder = await this.executeBatches({
      nodeMap,
      adjacency,
      reverseAdj,
      outputs,
      executed,
      initialReady,
      allowedNodes: subgraph,
      entryInputs: () => null,
      emit,
    });

    const content = this.extractContent(outputs, adjacency, executionOrder);
    console.log(
      `[workflow] trigger from ${startId} complete — re-executed=[${executionOrder.join(", ")}] content="${content.slice(0, 80)}"`,
    );

    // Merge the re-executed outputs back into lastOutputs. Nodes
    // outside the subgraph keep their previous value untouched.
    this.lastOutputs.set(startId, mergedStartOut);
    for (const id of subgraph) {
      if (outputs.has(id)) this.lastOutputs.set(id, outputs.get(id));
    }

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
          const entry = entryInputs(nodeId);
          if (entry && Object.keys(inputs).length === 0) {
            inputs = entry;
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
        if (r.skip) continue;
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
  ): Promise<Record<string, unknown>> {
    const moduleId = node.data?.moduleId;
    const inputKeys = Object.keys(inputs).join(",") || "(none)";
    if (!moduleId) {
      console.log(
        `[workflow] exec ${node.id} (passthrough) inputs={${inputKeys}}`,
      );
      return inputs;
    }

    let fn = this.moduleCache.get(moduleId);
    if (!fn) {
      fn = await loadModule(this.modulesDir, moduleId);
      this.moduleCache.set(moduleId, fn);
    }

    const params = (node.data?.config as Record<string, unknown>) ?? {};
    const context: ModuleContext = {
      manifest: this.manifest,
      llm: this.llm,
      nodeId: node.id,
      history: [...this.history],
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
