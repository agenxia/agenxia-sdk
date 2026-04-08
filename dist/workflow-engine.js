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
/** Merge inputs from upstream node outputs. */
function resolveInputs(nodeId, reverseAdj, outputs, executed) {
    const incoming = reverseAdj.get(nodeId) ?? [];
    // Only consider incoming edges from executed nodes (cycles: back-edges ignored)
    const activeEdges = incoming.filter((e) => executed.has(e.source));
    if (activeEdges.length === 0)
        return {};
    if (activeEdges.length === 1) {
        const out = outputs.get(activeEdges[0].source);
        return out && typeof out === "object"
            ? out
            : {};
    }
    const merged = {};
    for (const edge of activeEdges) {
        const src = outputs.get(edge.source);
        if (src && typeof src === "object") {
            Object.assign(merged, src);
        }
    }
    return merged;
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
    constructor(workflow, options) {
        this.workflow = workflow;
        this.modulesDir = options.modulesDir;
        this.manifest = options.manifest;
        this.llm = options.llm;
    }
    getHistory() {
        return [...this.history];
    }
    async run(message) {
        this.history.push({ role: "user", content: message });
        const { nodes, edges, entrypoint } = this.workflow;
        const graph = buildGraph(nodes, edges);
        const { nodeMap, adjacency, reverseAdj } = graph;
        const outputs = new Map();
        const executed = new Set();
        const executionOrder = [];
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
        let readyQueue = roots.length > 0 ? [...roots] : entrypoint ? [entrypoint] : [];
        if (readyQueue.length === 0) {
            throw new Error("Workflow has no executable entry node");
        }
        while (readyQueue.length > 0) {
            const batch = readyQueue;
            const batchResults = await Promise.all(batch.map(async (nodeId) => {
                const node = nodeMap.get(nodeId);
                if (!node || executed.has(nodeId))
                    return { nodeId, output: null, skip: true };
                let inputs = resolveInputs(nodeId, reverseAdj, outputs, executed);
                // Entrypoint / roots receive the message
                if (entryIds.has(nodeId) && Object.keys(inputs).length === 0) {
                    inputs = { message };
                }
                const output = await this.executeNode(node, inputs);
                return { nodeId, output, skip: false };
            }));
            for (const r of batchResults) {
                if (r.skip)
                    continue;
                outputs.set(r.nodeId, r.output);
                executed.add(r.nodeId);
                executionOrder.push(r.nodeId);
            }
            // Next ready nodes
            const nextReady = [];
            for (const [nodeId] of nodeMap) {
                if (executed.has(nodeId))
                    continue;
                const incoming = reverseAdj.get(nodeId) ?? [];
                if (incoming.length === 0)
                    continue;
                const allResolved = incoming.every((e) => {
                    if (executed.has(e.source))
                        return true;
                    // Back-edge: target is reachable from source -> we are upstream of source
                    return isReachable(nodeId, e.source, adjacency);
                });
                const hasAnyExecutedPred = incoming.some((e) => executed.has(e.source));
                if (allResolved && hasAnyExecutedPred)
                    nextReady.push(nodeId);
            }
            readyQueue = nextReady;
        }
        // Extract response: prefer `response` field from any executed node
        // (LLM modules emit it), then fall back to sinks.
        const content = this.extractContent(outputs, adjacency, executionOrder);
        console.log(`[workflow] run complete — executed=[${executionOrder.join(", ")}] content="${content.slice(0, 80)}"`);
        this.history.push({ role: "assistant", content });
        return { content, messages: [...this.history] };
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