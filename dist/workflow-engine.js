// Local workflow engine — executes workflow.json autonomously.
//
// Agents embed this engine to run their own workflow without the platform.
// Modules are loaded from ./modules/<moduleId>/execute.js (CommonJS).
// A module without execute.js is treated as passthrough.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
function buildGraph(nodes, edges) {
    const nodeMap = new Map();
    const adjacency = new Map();
    const reverseAdj = new Map();
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
function descendantsOf(startId, adjacency) {
    const visited = new Set();
    const stack = [startId];
    while (stack.length > 0) {
        const id = stack.pop();
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
function isReachable(sourceId, targetId, adjacency) {
    const visited = new Set();
    const queue = [sourceId];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === targetId)
            return true;
        if (visited.has(current))
            continue;
        visited.add(current);
        for (const { target } of adjacency.get(current) ?? []) {
            if (!visited.has(target))
                queue.push(target);
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
function resolveInputs(nodeId, reverseAdj, outputs, executed) {
    const incoming = reverseAdj.get(nodeId) ?? [];
    const activeEdges = incoming.filter((e) => executed.has(e.source));
    const result = {};
    for (const edge of activeEdges) {
        const src = outputs.get(edge.source);
        if (!src || typeof src !== "object")
            continue;
        const srcObj = src;
        const hasHandles = typeof edge.sourceHandle === "string" &&
            edge.sourceHandle.length > 0 &&
            typeof edge.targetHandle === "string" &&
            edge.targetHandle.length > 0;
        if (hasHandles) {
            // Port routing: forward only the named field, under the declared
            // target name. Missing source key is exposed as `undefined` so
            // modules can detect "wired but no value" distinctly from "not wired".
            result[edge.targetHandle] = srcObj[edge.sourceHandle];
        }
        else {
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
function loadModuleSync(modulesDir, moduleId) {
    const execPath = join(modulesDir, moduleId, "execute.js");
    if (!existsSync(execPath)) {
        // Passthrough
        return async (inputs) => inputs;
    }
    try {
        const code = readFileSync(execPath, "utf-8");
        const wrapped = `
      const module = { exports: {} };
      const exports = module.exports;
      ${code}
      return module.exports;
    `;
        const factory = new Function("require", "fetch", "console", wrapped);
        const noRequire = (id) => {
            throw new Error(`require('${id}') not available in module sandbox`);
        };
        const exported = factory(noRequire, globalThis.fetch, console);
        if (typeof exported === "function")
            return exported;
        if (exported &&
            typeof exported.default === "function") {
            return exported.default;
        }
        console.warn(`[workflow] module ${moduleId} did not export a function, using passthrough`);
        return async (inputs) => inputs;
    }
    catch (err) {
        console.warn(`[workflow] failed to load module ${moduleId}:`, err);
        return async (inputs) => inputs;
    }
}
async function loadModule(modulesDir, moduleId) {
    return loadModuleSync(modulesDir, moduleId);
}
// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------
export class WorkflowEngine {
    workflow;
    modulesDir;
    manifest;
    llm;
    moduleCache = new Map();
    history = [];
    // Persistent output cache across runs. Populated by run() and
    // triggerFromNode(), read by triggerFromNode() to reuse upstream values
    // without re-executing ancestors.
    lastOutputs = new Map();
    hasRun = false;
    // Mutex: serialize run() and triggerFromNode() to prevent concurrent
    // mutations of lastOutputs.
    runLock = Promise.resolve();
    constructor(workflow, options) {
        this.workflow = workflow;
        this.modulesDir = options.modulesDir;
        this.manifest = options.manifest;
        this.llm = options.llm;
    }
    getHistory() {
        return [...this.history];
    }
    /** Snapshot of the last known outputs for every executed node. */
    getLastOutputs() {
        const out = {};
        for (const [id, v] of this.lastOutputs)
            out[id] = v;
        return out;
    }
    async withLock(fn) {
        const prev = this.runLock;
        let release;
        const gate = new Promise((r) => (release = r));
        this.runLock = prev.then(() => gate).catch(() => gate);
        try {
            await prev;
        }
        catch {
            // previous run errored — we still proceed
        }
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
    async run(message, options = {}) {
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
    async triggerFromNode(nodeId, portValues, options = {}) {
        return this.withLock(() => this._triggerFromNode(nodeId, portValues, options));
    }
    // -------------------------------------------------------------------------
    // Internal: full workflow run (classic chat message entry)
    // -------------------------------------------------------------------------
    async _runFull(message, options) {
        const emit = this.makeEmitter(options.onEvent);
        this.history.push({ role: "user", content: message });
        const { nodes, edges, entrypoint } = this.workflow;
        const graph = buildGraph(nodes, edges);
        const { nodeMap, adjacency, reverseAdj } = graph;
        const outputs = new Map();
        const executed = new Set();
        // Determine roots: nodes without incoming edges.
        const roots = [];
        for (const [nodeId] of nodeMap) {
            if ((reverseAdj.get(nodeId) ?? []).length === 0)
                roots.push(nodeId);
        }
        // If no roots (cyclic) and entrypoint provided, use it.
        if (roots.length === 0 && entrypoint && nodeMap.has(entrypoint)) {
            roots.push(entrypoint);
        }
        // Entrypoint node gets the message as passthrough input.
        const entryIds = new Set(entrypoint && nodeMap.has(entrypoint) ? [entrypoint] : roots);
        const initialReady = roots.length > 0 ? [...roots] : entrypoint ? [entrypoint] : [];
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
        console.log(`[workflow] run complete — executed=[${executionOrder.join(", ")}] content="${content.slice(0, 80)}"`);
        this.history.push({ role: "assistant", content });
        // Persist outputs for future reactive triggers
        this.lastOutputs = new Map(outputs);
        this.hasRun = true;
        const nodeOutputs = {};
        for (const [id, out] of outputs)
            nodeOutputs[id] = out;
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
    async _triggerFromNode(startId, portValues, options) {
        if (!this.hasRun) {
            throw new Error("triggerFromNode: no previous run — call run() first to warm the output cache");
        }
        const emit = this.makeEmitter(options.onEvent);
        const { nodes, edges } = this.workflow;
        const graph = buildGraph(nodes, edges);
        const { nodeMap, adjacency, reverseAdj } = graph;
        if (!nodeMap.has(startId)) {
            throw new Error(`triggerFromNode: node "${startId}" not found in workflow`);
        }
        // Validate portValues against declared ports if any — warn, don't throw.
        const declaredPorts = nodeMap.get(startId)?.data?.ports;
        if (declaredPorts && typeof declaredPorts === "object") {
            const known = new Set(Object.keys(declaredPorts));
            for (const key of Object.keys(portValues)) {
                if (!known.has(key)) {
                    console.warn(`[workflow] triggerFromNode: port "${key}" not declared on node "${startId}"`);
                }
            }
        }
        // Log the interaction as a system entry (not a user message).
        this.history.push({
            role: "system",
            content: `[widget ${startId} → ${JSON.stringify(portValues)}]`,
        });
        // Seed outputs from the cache and merge portValues into startId's entry.
        const outputs = new Map(this.lastOutputs);
        const prevStartOut = this.lastOutputs.get(startId);
        const mergedStartOut = {
            ...(prevStartOut && typeof prevStartOut === "object"
                ? prevStartOut
                : {}),
            ...portValues,
        };
        outputs.set(startId, mergedStartOut);
        // Compute downstream subgraph.
        const subgraph = descendantsOf(startId, adjacency);
        // Seed executed with everything OUTSIDE the subgraph (they are
        // considered already-done, backed by lastOutputs). startId is also
        // marked executed so its merged output is used by descendants.
        const executed = new Set();
        for (const [id] of nodeMap) {
            if (!subgraph.has(id))
                executed.add(id);
        }
        // No descendants — nothing to re-run. Still persist the new startId
        // output and emit workflow_complete immediately.
        if (subgraph.size === 0) {
            this.lastOutputs.set(startId, mergedStartOut);
            const nodeOutputs = {};
            for (const [id, v] of this.lastOutputs)
                nodeOutputs[id] = v;
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
        const initialReady = [];
        for (const id of subgraph) {
            const incoming = reverseAdj.get(id) ?? [];
            // Must have at least one incoming from startId or an executed source.
            const hasAnyExecutedPred = incoming.some((e) => executed.has(e.source));
            const allResolved = incoming.every((e) => {
                if (executed.has(e.source))
                    return true;
                return isReachable(id, e.source, adjacency);
            });
            if (hasAnyExecutedPred && allResolved)
                initialReady.push(id);
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
        console.log(`[workflow] trigger from ${startId} complete — re-executed=[${executionOrder.join(", ")}] content="${content.slice(0, 80)}"`);
        // Merge the re-executed outputs back into lastOutputs. Nodes
        // outside the subgraph keep their previous value untouched.
        this.lastOutputs.set(startId, mergedStartOut);
        for (const id of subgraph) {
            if (outputs.has(id))
                this.lastOutputs.set(id, outputs.get(id));
        }
        const nodeOutputs = {};
        for (const [id, v] of this.lastOutputs)
            nodeOutputs[id] = v;
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
    async executeBatches(params) {
        const { nodeMap, adjacency, reverseAdj, outputs, executed, allowedNodes, entryInputs, emit, } = params;
        const executionOrder = [];
        const isAllowed = (id) => allowedNodes === null || allowedNodes.has(id);
        let readyQueue = params.initialReady.filter((id) => isAllowed(id));
        while (readyQueue.length > 0) {
            const batch = readyQueue;
            const batchResults = await Promise.all(batch.map(async (nodeId) => {
                const node = nodeMap.get(nodeId);
                if (!node || executed.has(nodeId))
                    return { nodeId, output: null, skip: true };
                let inputs = resolveInputs(nodeId, reverseAdj, outputs, executed);
                const entry = entryInputs(nodeId);
                if (entry && Object.keys(inputs).length === 0) {
                    inputs = entry;
                }
                emit({
                    type: "node_start",
                    nodeId,
                    label: typeof node.data?.label === "string"
                        ? node.data.label
                        : undefined,
                    moduleId: node.data?.moduleId,
                });
                const startTs = Date.now();
                try {
                    const output = await this.executeNode(node, inputs);
                    const durationMs = Date.now() - startTs;
                    emit({ type: "node_complete", nodeId, output, durationMs });
                    return { nodeId, output, skip: false };
                }
                catch (err) {
                    const durationMs = Date.now() - startTs;
                    const msg = err instanceof Error ? err.message : String(err);
                    emit({ type: "node_error", nodeId, error: msg, durationMs });
                    throw err;
                }
            }));
            for (const r of batchResults) {
                if (r.skip)
                    continue;
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
            const nextReady = [];
            for (const [nodeId] of nodeMap) {
                if (executed.has(nodeId))
                    continue;
                if (!isAllowed(nodeId))
                    continue;
                const incoming = reverseAdj.get(nodeId) ?? [];
                if (incoming.length === 0)
                    continue;
                const allResolved = incoming.every((e) => {
                    if (executed.has(e.source))
                        return true;
                    return isReachable(nodeId, e.source, adjacency);
                });
                const hasAnyExecutedPred = incoming.some((e) => executed.has(e.source));
                if (allResolved && hasAnyExecutedPred)
                    nextReady.push(nodeId);
            }
            readyQueue = nextReady;
        }
        return executionOrder;
    }
    makeEmitter(onEvent) {
        return (e) => {
            if (!onEvent)
                return;
            try {
                onEvent(e);
            }
            catch (err) {
                console.warn("[workflow] onEvent threw:", err);
            }
        };
    }
    async executeNode(node, inputs) {
        const moduleId = node.data?.moduleId;
        const inputKeys = Object.keys(inputs).join(",") || "(none)";
        if (!moduleId) {
            console.log(`[workflow] exec ${node.id} (passthrough) inputs={${inputKeys}}`);
            return inputs;
        }
        let fn = this.moduleCache.get(moduleId);
        if (!fn) {
            fn = await loadModule(this.modulesDir, moduleId);
            this.moduleCache.set(moduleId, fn);
        }
        const params = node.data?.config ?? {};
        const context = {
            manifest: this.manifest,
            llm: this.llm,
            nodeId: node.id,
            history: [...this.history],
        };
        console.log(`[workflow] exec ${node.id} (module=${moduleId}) inputs={${inputKeys}} hasLLM=${!!this.llm}`);
        try {
            const result = await fn(inputs, params, context);
            const out = result && typeof result === "object"
                ? result
                : { value: result };
            const outKeys = Object.keys(out).join(",") || "(none)";
            console.log(`[workflow] exec ${node.id} → output={${outKeys}}`);
            return out;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[workflow] exec ${node.id} ERROR:`, msg);
            throw new Error(`[module:${moduleId}] ${msg}`);
        }
    }
    extractContent(outputs, adjacency, executionOrder) {
        const getField = (out, key) => {
            if (!out || typeof out !== "object")
                return null;
            const v = out[key];
            return typeof v === "string" && v !== "" ? v : null;
        };
        // Priority 1: `response` from any executed node (LLM modules emit
        // this — agent-core, etc.). Walk in reverse execution order so the
        // most recent LLM response wins in cyclic workflows.
        for (let i = executionOrder.length - 1; i >= 0; i--) {
            const id = executionOrder[i];
            const v = getField(outputs.get(id), "response");
            if (v)
                return v;
        }
        // Priority 2: `content` field anywhere (newest first).
        for (let i = executionOrder.length - 1; i >= 0; i--) {
            const id = executionOrder[i];
            const v = getField(outputs.get(id), "content");
            if (v)
                return v;
        }
        // Priority 3: sink nodes (no outgoing edges) with message/text.
        const sinks = [];
        for (const [nodeId, edges] of adjacency) {
            if (edges.length === 0 && outputs.has(nodeId))
                sinks.push(nodeId);
        }
        for (const id of sinks) {
            const out = outputs.get(id);
            const m = getField(out, "message") ?? getField(out, "text");
            if (m)
                return m;
        }
        // Last resort: last executed output, stringified.
        const lastKey = executionOrder[executionOrder.length - 1];
        const last = lastKey ? outputs.get(lastKey) : undefined;
        if (typeof last === "string")
            return last;
        return last ? JSON.stringify(last) : "";
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function loadWorkflowDefinition(workflowPath) {
    if (!existsSync(workflowPath))
        return null;
    try {
        const raw = readFileSync(workflowPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!parsed.nodes || !Array.isArray(parsed.nodes))
            return null;
        return {
            entrypoint: parsed.entrypoint,
            nodes: parsed.nodes,
            edges: parsed.edges ?? [],
        };
    }
    catch (err) {
        console.warn(`[workflow] failed to parse ${workflowPath}:`, err);
        return null;
    }
}
export function createWorkflowEngine(options) {
    const def = loadWorkflowDefinition(options.workflowPath);
    if (!def)
        return null;
    const modulesDir = resolve(options.modulesDir);
    return new WorkflowEngine(def, {
        modulesDir,
        manifest: options.manifest,
        llm: options.llm,
    });
}
// Helper to resolve default paths relative to a manifest directory
export function defaultWorkflowPaths(manifestPath) {
    const dir = dirname(resolve(manifestPath));
    return {
        workflowPath: join(dir, "workflow.json"),
        modulesDir: join(dir, "modules"),
    };
}
//# sourceMappingURL=workflow-engine.js.map