// Main agent server factory
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
 * 2. Imports process.js (if it exists)
 * 3. Mounts routes: /health, /.well-known/agent-card.json, /docs, /a2a
 * 4. Creates LLM client if config has LLM settings
 * 5. Starts the Fastify server
 */
export async function createAgentServer(options = {}) {
    const manifestPath = resolve(options.manifestPath ?? "./agenxia.json");
    const processPath = resolve(options.processPath ?? "./process.js");
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
    // 2. Import process function
    let processFunc = null;
    try {
        const mod = (await import(pathToFileURL(processPath).href));
        processFunc = mod.default ?? mod.process ?? null;
    }
    catch {
        console.warn(`Warning: Could not import ${processPath}`);
    }
    // 3. Load workflow.json — it is the source of truth for module params,
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
        if (!workflowEngine && !processFunc) {
            return reply.send({
                jsonrpc: "2.0",
                id: body.id,
                error: {
                    code: A2A_ERROR_CODES.INTERNAL_ERROR,
                    message: "No workflow.json and no process function loaded",
                },
            });
        }
        try {
            let result;
            if (workflowEngine) {
                // Extract message from A2A params. Supported shapes:
                //   { message: "..." } | { input: "..." } | { messages: [{content}] }
                const params = body.params ?? {};
                let msg = "";
                if (typeof params.message === "string")
                    msg = params.message;
                else if (typeof params.input === "string")
                    msg = params.input;
                else if (Array.isArray(params.messages)) {
                    const msgs = params
                        .messages;
                    msg = msgs[msgs.length - 1]?.content ?? "";
                }
                const run = await workflowEngine.run(msg);
                result = {
                    content: run.content,
                    messages: run.messages,
                };
            }
            else if (processFunc) {
                result = await processFunc({
                    manifest,
                    llm,
                    params: body.params ?? {},
                    method: body.method,
                    callerId,
                    depth,
                    requestId,
                });
            }
            else {
                throw new Error("No executor available");
            }
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
    // 6. Start server
    await app.listen({ port, host });
    console.log(`Agent "${manifest.name}" running on http://${host}:${port}`);
}
//# sourceMappingURL=server.js.map