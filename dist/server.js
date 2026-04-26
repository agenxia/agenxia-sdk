// Main agent server factory
// Load .env from the agent's cwd before any process.env reads so that
// agents importing createAgentServer directly (not via the CLI) get
// their .env vars automatically. dotenv is idempotent — if .env was
// already loaded by the CLI or the agent itself, this is a no-op.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { A2A_ERROR_CODES } from "./a2a/types.js";
import { generateAgentCard } from "./agent-card.js";
import { generateDocs } from "./docs.js";
import { createLLM } from "./llm.js";
import { WorkflowEngine, defaultWorkflowPaths, loadWorkflowDefinition, } from "./workflow-engine.js";
/**
 * Scan workflow nodes for LLM params. Returns the first node.data.config
 * that carries at least one LLM field. The agent-core node is typically
 * the source, but any module can provide them.
 */
function findLLMParams(def) {
    const LLM_KEYS = [
        "llm_api_url",
        "llm_api_key",
        "model",
        "system_prompt",
        "temperature",
        "max_tokens",
    ];
    // Prefer agent-core explicitly, then any node that has LLM keys.
    const core = def.nodes.find((n) => n.data?.moduleId === "agent-core");
    const candidates = core
        ? [core, ...def.nodes.filter((n) => n !== core)]
        : def.nodes;
    for (const node of candidates) {
        const config = (node.data?.config ?? {});
        if (LLM_KEYS.some((k) => config[k] !== undefined && config[k] !== "")) {
            return config;
        }
    }
    return null;
}
/**
 * Create and start the agent server.
 *
 * 1. Reads agenxia.json
 * 2. Loads workflow.json + LLM config
 * 3. Mounts routes: /health, /.well-known/agent-card.json, /docs, /a2a
 * 4. Starts the Fastify server
 */
export async function createAgentServer(options = {}) {
    const manifestPath = resolve(options.manifestPath ?? "./agenxia.json");
    const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
    const host = options.host ?? "0.0.0.0";
    // 1. Read manifest
    let manifest;
    try {
        const raw = readFileSync(manifestPath, "utf-8");
        manifest = JSON.parse(raw);
    }
    catch {
        console.warn(`Warning: Could not read ${manifestPath}, using defaults`);
        manifest = { name: "unknown-agent", description: "No manifest found" };
    }
    // 2. Load workflow.json — it is the source of truth for module params,
    //    including LLM config. agenxia.json is reserved for external identity.
    const { workflowPath, modulesDir } = defaultWorkflowPaths(manifestPath);
    const workflowDef = loadWorkflowDefinition(workflowPath);
    if (workflowDef) {
        console.log(`[workflow] loaded ${workflowPath}`);
    }
    // 4. Create LLM client. Priority: workflow node config > env vars > none.
    //    LLM is OPTIONAL — agents without any LLM field simply get undefined.
    let llm;
    const workflowParams = workflowDef ? findLLMParams(workflowDef) : null;
    const pick = (key) => {
        const v = workflowParams?.[key];
        return typeof v === "string" && v !== "" ? v : undefined;
    };
    const pickNumber = (key) => {
        const v = workflowParams?.[key];
        return typeof v === "number" ? v : undefined;
    };
    const apiUrl = pick("llm_api_url") ?? process.env.LLM_API_URL ?? "";
    const apiKey = pick("llm_api_key") ?? process.env.LLM_API_KEY ?? "";
    if (apiUrl && apiKey) {
        const llmOptions = {
            apiUrl,
            apiKey,
            model: pick("model") ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
            systemPrompt: pick("system_prompt") ?? process.env.LLM_SYSTEM_PROMPT,
            temperature: pickNumber("temperature"),
            maxTokens: pickNumber("max_tokens"),
        };
        llm = createLLM(llmOptions);
    }
    // 5. Create workflow engine from already-loaded definition
    let workflowEngine = null;
    if (workflowDef) {
        try {
            workflowEngine = new WorkflowEngine(workflowDef, {
                modulesDir,
                manifest,
                llm,
            });
            const count = await workflowEngine.initializeListeners();
            if (count > 0)
                console.log(`[agent] ${count} listener(s) active`);
        }
        catch (err) {
            console.warn(`[workflow] failed to initialize:`, err);
        }
    }
    // 5. Generate agent card
    const rootDir = resolve(manifestPath, "..");
    const deployUrl = process.env.DEPLOY_URL;
    const card = generateAgentCard({ rootDir, deployUrl, manifest });
    // 5. Create Fastify server
    const app = Fastify({ logger: true });
    await app.register(cors, { origin: true });
    // Private Network Access — permet aux pages HTTPS d'appeler http://localhost
    app.addHook("onSend", async (request, reply) => {
        if (request.headers["access-control-request-private-network"] === "true") {
            reply.header("Access-Control-Allow-Private-Network", "true");
        }
    });
    const startTime = Date.now();
    // GET /health
    app.get("/health", async () => ({
        status: "ok",
        agent: manifest.name,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version: manifest.version ?? "1.0.0",
    }));
    // GET /.well-known/agent-card.json
    app.get("/.well-known/agent-card.json", async () => card);
    // GET /docs
    app.get("/docs", async (_req, reply) => {
        const html = generateDocs(card, deployUrl);
        reply.type("text/html").send(html);
    });
    // Extract (nodeId, values) from A2A params for the `start` method.
    const extractStartArgs = (params) => {
        const nodeId = typeof params.nodeId === "string" && params.nodeId.length > 0
            ? params.nodeId
            : undefined;
        const rawValues = params.values;
        const values = rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)
            ? rawValues
            : {};
        return { nodeId, values };
    };
    // POST /a2a — JSON-RPC 2.0
    app.post("/a2a", async (req, reply) => {
        const body = req.body;
        // Validate JSON-RPC
        if (body.jsonrpc !== "2.0" || !body.method) {
            return reply.send({
                jsonrpc: "2.0",
                id: body.id ?? 0,
                error: {
                    code: A2A_ERROR_CODES.INVALID_PARAMS,
                    message: "Invalid JSON-RPC 2.0 request",
                },
            });
        }
        // Extract A2A headers
        const callerId = req.headers["x-agent-id"] ?? "unknown";
        const depth = parseInt(req.headers["x-max-depth"] ?? "10", 10);
        const requestId = req.headers["x-request-id"] ?? crypto.randomUUID();
        if (depth <= 0) {
            return reply.send({
                jsonrpc: "2.0",
                id: body.id,
                error: {
                    code: A2A_ERROR_CODES.MAX_DEPTH_EXCEEDED,
                    message: "Max call depth exceeded",
                },
            });
        }
        if (!workflowEngine) {
            return reply.send({
                jsonrpc: "2.0",
                id: body.id,
                error: {
                    code: A2A_ERROR_CODES.INTERNAL_ERROR,
                    message: "No workflow.json found",
                },
            });
        }
        try {
            let result;
            if (body.method === "state") {
                const snap = workflowEngine.getState();
                result = {
                    content: snap.content,
                    messages: snap.messages,
                    nodeOutputs: snap.nodeOutputs,
                };
                return reply.send({ jsonrpc: "2.0", id: body.id, result });
            }
            if (body.method !== "start") {
                return reply.send({
                    jsonrpc: "2.0",
                    id: body.id,
                    error: {
                        code: A2A_ERROR_CODES.INVALID_PARAMS,
                        message: `Unknown method "${body.method}". Supported: "start", "state".`,
                    },
                });
            }
            const { nodeId, values } = extractStartArgs(body.params ?? {});
            workflowEngine.setRequestContext({
                sessionId: req.headers["x-session-id"],
                agentId: req.headers["x-agent-id"],
                platformUrl: req.headers["x-platform-url"],
            });
            const run = await workflowEngine.start(nodeId, values);
            result = {
                content: run.content,
                messages: run.messages,
                nodeOutputs: run.nodeOutputs,
            };
            return reply.send({ jsonrpc: "2.0", id: body.id, result });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            return reply.send({
                jsonrpc: "2.0",
                id: body.id,
                error: { code: A2A_ERROR_CODES.INTERNAL_ERROR, message },
            });
        }
    });
    // POST /a2a/stream — same body as /a2a, streams WorkflowEvent via SSE.
    // Only supported when workflowEngine is loaded.
    app.post("/a2a/stream", async (req, reply) => {
        if (!workflowEngine) {
            return reply.code(400).send({
                error: "Streaming requires a workflow.json — no engine loaded",
            });
        }
        const body = req.body;
        // Tell Fastify to stop managing this response — we'll write directly
        // to the raw socket. Without hijack, Fastify buffers and may send its
        // own reply after ours, corrupting the SSE stream.
        reply.hijack();
        // SSE headers
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        });
        let closed = false;
        reply.raw.on("close", () => {
            closed = true;
        });
        const writeEvent = (event, data) => {
            if (closed || reply.raw.destroyed)
                return;
            reply.raw.write(`event: ${event}\n`);
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        try {
            const onEvent = (event) => {
                const { type, ...rest } = event;
                writeEvent(type, rest);
            };
            if (body.method && body.method !== "start") {
                throw new Error(`Unknown method "${body.method}". Only "start" is supported.`);
            }
            const { nodeId, values } = extractStartArgs(body.params ?? {});
            workflowEngine.setRequestContext({
                sessionId: req.headers["x-session-id"],
                agentId: req.headers["x-agent-id"],
                platformUrl: req.headers["x-platform-url"],
            });
            await workflowEngine.start(nodeId, values, { onEvent });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            writeEvent("error", { message });
        }
        finally {
            if (!closed && !reply.raw.destroyed)
                reply.raw.end();
        }
    });
    // POST /api/sync — synchronize agent code via git pull
    app.post("/api/sync", async (_request, reply) => {
        const { spawnSync } = await import("node:child_process");
        const cwd = rootDir;
        // Verifier qu'on est dans un repo git
        const check = spawnSync("git", ["rev-parse", "--git-dir"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        if (check.status !== 0) {
            return reply.code(400).send({ error: "Not a git repository" });
        }
        const pull = spawnSync("git", ["pull", "origin", "main", "--ff-only"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const output = (pull.stdout + pull.stderr).trim();
        console.log(`[sync] git pull: ${output}`);
        if (pull.status !== 0) {
            return reply.code(500).send({ error: "git pull failed", output });
        }
        // Reload workflow from disk after pull
        const newDef = loadWorkflowDefinition(workflowPath);
        if (newDef) {
            try {
                // Tear down listeners from the previous workflow first.
                if (workflowEngine)
                    await workflowEngine.disposeListeners();
                workflowEngine = new WorkflowEngine(newDef, {
                    modulesDir,
                    manifest,
                    llm,
                });
                const count = await workflowEngine.initializeListeners();
                console.log(`[sync] workflow reloaded — ${count} listener(s) active`);
            }
            catch (err) {
                console.warn(`[sync] workflow reload failed:`, err);
            }
        }
        return reply.send({ synced: true, output });
    });
    // -------------------------------------------------------------------------
    // REST API — platform → agent communication (no JSON-RPC wrapper)
    // -------------------------------------------------------------------------
    // Helper: set request context headers common to all start paths.
    const setCtxFromHeaders = (req) => {
        if (!workflowEngine)
            return;
        workflowEngine.setRequestContext({
            sessionId: req.headers["x-session-id"],
            agentId: req.headers["x-agent-id"],
            platformUrl: req.headers["x-platform-url"],
        });
    };
    // GET /api/state — read-only snapshot, no execution.
    app.get("/api/state", async (_req, reply) => {
        if (!workflowEngine) {
            return reply.code(400).send({ error: "No workflow.json found" });
        }
        const snap = workflowEngine.getState();
        return reply.send({
            content: snap.content,
            messages: snap.messages,
            nodeOutputs: snap.nodeOutputs,
        });
    });
    // POST /api/start — execute workflow (buffered response).
    app.post("/api/start", async (req, reply) => {
        if (!workflowEngine) {
            return reply.code(400).send({ error: "No workflow.json found" });
        }
        const body = (req.body ?? {});
        const { nodeId, values } = extractStartArgs(body);
        setCtxFromHeaders(req);
        try {
            const run = await workflowEngine.start(nodeId, values);
            return reply.send({
                content: run.content,
                messages: run.messages,
                nodeOutputs: run.nodeOutputs,
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            return reply.code(500).send({ error: message });
        }
    });
    // POST /api/start/stream — execute workflow with SSE event stream.
    app.post("/api/start/stream", async (req, reply) => {
        if (!workflowEngine) {
            return reply.code(400).send({ error: "No workflow.json found" });
        }
        const body = (req.body ?? {});
        const { nodeId, values } = extractStartArgs(body);
        setCtxFromHeaders(req);
        reply.hijack();
        reply.raw.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
            "X-Accel-Buffering": "no",
            "Access-Control-Allow-Origin": "*",
        });
        let closed = false;
        reply.raw.on("close", () => {
            closed = true;
        });
        const writeEvent = (event, data) => {
            if (closed || reply.raw.destroyed)
                return;
            reply.raw.write(`event: ${event}\n`);
            reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
        };
        try {
            await workflowEngine.start(nodeId, values, {
                onEvent: (event) => {
                    const { type, ...rest } = event;
                    writeEvent(type, rest);
                },
            });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : "Internal error";
            writeEvent("error", { message });
        }
        finally {
            if (!closed && !reply.raw.destroyed)
                reply.raw.end();
        }
    });
    // 6. Start server
    await app.listen({ port, host });
    console.log(`Agent "${manifest.name}" running on http://${host}:${port}`);
    // 7. Graceful shutdown — dispose listeners then close Fastify
    const shutdown = async (signal) => {
        console.log(`[agent] received ${signal}, shutting down…`);
        try {
            if (workflowEngine)
                await workflowEngine.disposeListeners();
            await app.close();
        }
        catch (err) {
            console.warn(`[agent] shutdown error:`, err);
        }
        finally {
            process.exit(0);
        }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
}
//# sourceMappingURL=server.js.map