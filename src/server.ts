// Main agent server factory

// Load .env from the agent's cwd before any process.env reads so that
// agents importing createAgentServer directly (not via the CLI) get
// their .env vars automatically. dotenv is idempotent — if .env was
// already loaded by the CLI or the agent itself, this is a no-op.
import "dotenv/config";

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AgentManifest, A2AResult } from "./types.js";
import { A2A_ERROR_CODES } from "./a2a/types.js";
import { generateAgentCard } from "./agent-card.js";
import { generateDocs } from "./docs.js";
import { createLLM } from "./llm.js";
import type { LLMOptions } from "./llm.js";
import {
  WorkflowEngine,
  defaultWorkflowPaths,
  loadWorkflowDefinition,
  type WorkflowDefinition,
  type InitNodeMetadata,
} from "./workflow-engine.js";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Scan workflow nodes for LLM params. Returns the first node.data.config
 * that carries at least one LLM field. Any module can provide them.
 */
function findLLMParams(
  def: WorkflowDefinition,
): Record<string, unknown> | null {
  const LLM_KEYS = [
    "llm_api_url",
    "llm_api_key",
    "model",
    "system_prompt",
    "temperature",
    "max_tokens",
  ];
  for (const node of def.nodes) {
    const config = (node.data?.config ?? {}) as Record<string, unknown>;
    if (LLM_KEYS.some((k) => config[k] !== undefined && config[k] !== "")) {
      return config;
    }
  }
  return null;
}

export interface ServerOptions {
  manifestPath?: string;
  port?: number;
  host?: string;
}

/**
 * Create and start the agent server.
 *
 * 1. Reads agenxia.json
 * 2. Loads workflow.json + LLM config
 * 3. Mounts routes: /health, /.well-known/agent-card.json, /docs, /a2a
 * 4. Starts the Fastify server
 */
export async function createAgentServer(
  options: ServerOptions = {},
): Promise<void> {
  const manifestPath = resolve(options.manifestPath ?? "./agenxia.json");
  const port = options.port ?? parseInt(process.env.PORT ?? "3000", 10);
  const host = options.host ?? "0.0.0.0";

  // 1. Read manifest
  let manifest: AgentManifest;
  try {
    const raw = readFileSync(manifestPath, "utf-8");
    manifest = JSON.parse(raw) as AgentManifest;
  } catch {
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
  let llm: ReturnType<typeof createLLM> | undefined;
  const workflowParams = workflowDef ? findLLMParams(workflowDef) : null;
  const pick = (key: string): string | undefined => {
    const v = workflowParams?.[key];
    return typeof v === "string" && v !== "" ? v : undefined;
  };
  const pickNumber = (key: string): number | undefined => {
    const v = workflowParams?.[key];
    return typeof v === "number" ? v : undefined;
  };

  const apiUrl = pick("llm_api_url") ?? process.env.LLM_API_URL ?? "";
  const apiKey = pick("llm_api_key") ?? process.env.LLM_API_KEY ?? "";
  if (apiUrl && apiKey) {
    const llmOptions: LLMOptions = {
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
  let workflowEngine: WorkflowEngine | null = null;
  if (workflowDef) {
    try {
      workflowEngine = new WorkflowEngine(workflowDef, {
        modulesDir,
        manifest,
        llm,
      });
      const count = await workflowEngine.initializeListeners();
      if (count > 0) console.log(`[agent] ${count} listener(s) active`);
    } catch (err) {
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

  // GET / — landing page friendly pour les humains qui hit l'URL agent.
  // L'URL d'un agent reste un endpoint technique (REST API) mais ne
  // doit pas cracher un 404 JSON. On affiche le nom + un lien vers
  // la fiche dans agenxia-web + les endpoints utiles aux devs.
  app.get("/", async (_req, reply) => {
    const platformUrl = (process.env.PLATFORM_URL || "").replace(/\/$/, "");
    const agentId = process.env.AGENT_ID || "";
    const platformLink =
      platformUrl && agentId
        ? `${platformUrl}/agents/${encodeURIComponent(agentId)}/interface`
        : null;
    const name = manifest.name || "Agent";
    const description = manifest.description || "";
    const version = manifest.version ?? "1.0.0";
    const html = `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(name)} — Agenxia</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0a0a0a;
      color: #fafafa;
      padding: 24px;
    }
    .card {
      max-width: 560px;
      width: 100%;
      background: #141414;
      border: 1px solid #262626;
      border-radius: 16px;
      padding: 32px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #4ade80;
      margin-bottom: 16px;
    }
    .status::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #4ade80;
      box-shadow: 0 0 8px #4ade80;
    }
    h1 { margin: 0 0 8px 0; font-size: 24px; font-weight: 600; }
    .desc { color: #a3a3a3; margin: 0 0 24px 0; font-size: 14px; line-height: 1.5; }
    .cta {
      display: inline-block;
      background: #fafafa;
      color: #0a0a0a;
      text-decoration: none;
      padding: 12px 20px;
      border-radius: 8px;
      font-weight: 500;
      font-size: 14px;
    }
    .cta:hover { background: #e5e5e5; }
    .endpoints {
      margin-top: 32px;
      padding-top: 24px;
      border-top: 1px solid #262626;
    }
    .endpoints h2 {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #737373;
      margin: 0 0 12px 0;
    }
    .endpoints ul { list-style: none; padding: 0; margin: 0; }
    .endpoints li { font-size: 13px; padding: 4px 0; }
    .endpoints a { color: #60a5fa; text-decoration: none; font-family: ui-monospace, monospace; }
    .endpoints a:hover { text-decoration: underline; }
    .meta { font-size: 11px; color: #525252; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">running</div>
    <h1>${escapeHtml(name)}</h1>
    ${description ? `<p class="desc">${escapeHtml(description)}</p>` : ""}
    ${
      platformLink
        ? `<a class="cta" href="${escapeHtml(platformLink)}">Ouvrir dans Agenxia →</a>`
        : `<p class="desc"><em>PLATFORM_URL ou AGENT_ID non configurés — pas de lien vers la plateforme.</em></p>`
    }
    <div class="endpoints">
      <h2>Endpoints</h2>
      <ul>
        <li><a href="/health">/health</a> — status</li>
        <li><a href="/.well-known/agent-card.json">/.well-known/agent-card.json</a> — agent card</li>
        <li><a href="/docs">/docs</a> — documentation API</li>
        <li><code style="color:#60a5fa">POST /api/start</code> — démarrer le workflow</li>
        <li><code style="color:#60a5fa">POST /a2a</code> — JSON-RPC inter-agents</li>
      </ul>
    </div>
    <div class="meta">v${escapeHtml(version)}</div>
  </div>
</body>
</html>`;
    reply.type("text/html; charset=utf-8").send(html);
  });

  // GET /.well-known/agent-card.json
  app.get("/.well-known/agent-card.json", async () => card);

  // GET /docs
  app.get("/docs", async (_req, reply) => {
    const html = generateDocs(card as any, deployUrl);
    reply.type("text/html").send(html);
  });

  // Extract (nodeId, values) from A2A params for the `start` method.
  const extractStartArgs = (
    params: Record<string, unknown>,
  ): { nodeId: string | undefined; values: Record<string, unknown> } => {
    const nodeId =
      typeof params.nodeId === "string" && params.nodeId.length > 0
        ? params.nodeId
        : undefined;
    const rawValues = params.values;
    const values =
      rawValues && typeof rawValues === "object" && !Array.isArray(rawValues)
        ? (rawValues as Record<string, unknown>)
        : {};
    return { nodeId, values };
  };

  // Pull user_id from the body (preferred — set by the platform per call)
  // or from a header fallback.
  const extractUserId = (
    body: Record<string, unknown> | undefined,
    headers: Record<string, unknown>,
  ): string | undefined => {
    const fromBody = body?.user_id;
    if (typeof fromBody === "string" && fromBody.length > 0) return fromBody;
    const fromHeader = headers["x-user-id"];
    if (typeof fromHeader === "string" && fromHeader.length > 0)
      return fromHeader;
    return undefined;
  };

  // POST /a2a — JSON-RPC 2.0
  app.post("/a2a", async (req, reply) => {
    const body = req.body as {
      jsonrpc: string;
      id: number | string;
      method: string;
      params?: Record<string, unknown>;
    };

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
    const callerId = (req.headers["x-agent-id"] as string) ?? "unknown";
    const depth = parseInt((req.headers["x-max-depth"] as string) ?? "10", 10);
    const requestId =
      (req.headers["x-request-id"] as string) ?? crypto.randomUUID();

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
      let result: A2AResult;
      if (body.method === "state") {
        const snap = workflowEngine.getState();
        result = {
          content: snap.content,
          messages: snap.messages,
          nodeOutputs: snap.nodeOutputs,
        } as unknown as A2AResult;
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
        sessionId: req.headers["x-session-id"] as string | undefined,
        agentId: req.headers["x-agent-id"] as string | undefined,
        platformUrl: req.headers["x-platform-url"] as string | undefined,
        userId: extractUserId(body.params, req.headers),
      });
      const run = await workflowEngine.start(nodeId, values);
      result = {
        content: run.content,
        messages: run.messages,
        nodeOutputs: run.nodeOutputs,
      } as unknown as A2AResult;
      return reply.send({ jsonrpc: "2.0", id: body.id, result });
    } catch (err) {
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

    const body = req.body as {
      jsonrpc?: string;
      id?: number | string;
      method?: string;
      params?: Record<string, unknown>;
    };

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

    const writeEvent = (event: string, data: unknown): void => {
      if (closed || reply.raw.destroyed) return;
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const onEvent = (event: { type: string; [k: string]: unknown }): void => {
        const { type, ...rest } = event;
        writeEvent(type, rest);
      };
      if (body.method && body.method !== "start") {
        throw new Error(
          `Unknown method "${body.method}". Only "start" is supported.`,
        );
      }
      const { nodeId, values } = extractStartArgs(body.params ?? {});
      workflowEngine.setRequestContext({
        sessionId: req.headers["x-session-id"] as string | undefined,
        agentId: req.headers["x-agent-id"] as string | undefined,
        platformUrl: req.headers["x-platform-url"] as string | undefined,
        userId: extractUserId(body.params, req.headers),
      });
      await workflowEngine.start(nodeId, values, { onEvent });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      writeEvent("error", { message });
    } finally {
      if (!closed && !reply.raw.destroyed) reply.raw.end();
    }
  });

  // POST /api/sync — reload workflow in-memory.
  // Body { pull?: boolean } — when true (default), runs `git pull origin main`
  // first; when false, skips git and reloads from disk only. The CLI daemon
  // calls this with pull:false after writing workflow.json directly, since
  // a git pull would fail on the dirty working tree.
  app.post("/api/sync", async (request, reply) => {
    const body = (request.body ?? {}) as { pull?: boolean };
    const shouldPull = body.pull !== false;

    let output = "";

    if (shouldPull) {
      const { spawnSync } = await import("node:child_process");
      const cwd = rootDir;

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

      output = (pull.stdout + pull.stderr).trim();
      console.log(`[sync] git pull: ${output}`);

      if (pull.status !== 0) {
        return reply.code(500).send({ error: "git pull failed", output });
      }
    } else {
      console.log(`[sync] hot-reload (pull skipped)`);
    }

    // Reload workflow from disk
    const newDef = loadWorkflowDefinition(workflowPath);
    if (newDef) {
      try {
        // Tear down listeners from the previous workflow first.
        if (workflowEngine) await workflowEngine.disposeListeners();
        workflowEngine = new WorkflowEngine(newDef, {
          modulesDir,
          manifest,
          llm,
        });
        const count = await workflowEngine.initializeListeners();
        console.log(`[sync] workflow reloaded — ${count} listener(s) active`);
      } catch (err) {
        console.warn(`[sync] workflow reload failed:`, err);
      }
    }

    return reply.send({ synced: true, output, pulled: shouldPull });
  });

  // -------------------------------------------------------------------------
  // REST API — platform → agent communication (no JSON-RPC wrapper)
  // -------------------------------------------------------------------------

  // Helper: set request context headers common to all start paths.
  const setCtxFromHeaders = (req: {
    headers: Record<string, unknown>;
    body?: unknown;
  }): void => {
    if (!workflowEngine) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    workflowEngine.setRequestContext({
      sessionId: req.headers["x-session-id"] as string | undefined,
      agentId: req.headers["x-agent-id"] as string | undefined,
      platformUrl: req.headers["x-platform-url"] as string | undefined,
      userId: extractUserId(body, req.headers),
    });
  };

  // Fetch the per-(user, agent) module config map from the platform.
  // Returns null silently when the env contract is incomplete (local
  // dev, agents not registered to a platform, etc.) — the engine then
  // resolves inputs against deployment-wide defaults only.
  const fetchUserConfigFromPlatform = async (
    userId: string | undefined,
  ): Promise<Record<string, Record<string, unknown>> | null> => {
    if (!userId) return null;
    const platformUrl = process.env.PLATFORM_URL;
    const agentId = process.env.AGENT_ID;
    const agentToken = process.env.AGENT_PLATFORM_TOKEN;
    if (!platformUrl || !agentId || !agentToken) return null;
    try {
      const url = `${platformUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(agentId)}/user-config?user_id=${encodeURIComponent(userId)}`;
      const res = await fetch(url, {
        headers: {
          "x-agent-id": agentId,
          "x-agent-token": agentToken,
        },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        console.warn(`[user-config] platform returned ${res.status}`);
        return null;
      }
      const data = (await res.json()) as { nodes?: Record<string, unknown> };
      if (!data?.nodes || typeof data.nodes !== "object") return null;
      const out: Record<string, Record<string, unknown>> = {};
      for (const [nodeId, entry] of Object.entries(data.nodes)) {
        const cfg = (entry as { config?: Record<string, unknown> })?.config;
        if (cfg && typeof cfg === "object") out[nodeId] = cfg;
      }
      return out;
    } catch (err) {
      console.warn(
        "[user-config] fetch failed:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  };

  // Same as setCtxFromHeaders, but also fetches the per-user config
  // from the platform and seeds the engine. Returns the list of init
  // nodes that are still pending for this user — the caller decides
  // whether to gate the run on it.
  const applyRunContext = async (req: {
    headers: Record<string, unknown>;
    body?: unknown;
  }): Promise<{ pendingInit: InitNodeMetadata[] }> => {
    if (!workflowEngine) return { pendingInit: [] };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const userId = extractUserId(body, req.headers);
    workflowEngine.setRequestContext({
      sessionId: req.headers["x-session-id"] as string | undefined,
      agentId: req.headers["x-agent-id"] as string | undefined,
      platformUrl: req.headers["x-platform-url"] as string | undefined,
      userId,
    });

    const userConfig = await fetchUserConfigFromPlatform(userId);
    if (userConfig) workflowEngine.setUserConfig(userConfig);
    else workflowEngine.clearUserConfig();

    const pendingInit: InitNodeMetadata[] = [];
    if (userId) {
      const initNodes = workflowEngine.listInitNodes();
      for (const n of initNodes) {
        if (!n.required) continue;
        const cfg = userConfig?.[n.node_id];
        const produces = n.produces ?? [];
        const allFilled =
          produces.length > 0 &&
          cfg &&
          produces.every((k) => cfg[k] !== undefined && cfg[k] !== null);
        if (!allFilled) pendingInit.push(n);
      }
    }
    return { pendingInit };
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
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { nodeId, values } = extractStartArgs(body);
    const { pendingInit } = await applyRunContext(req);
    if (pendingInit.length > 0) {
      return reply.code(412).send({
        error: "Initialization required",
        pending_init: pendingInit,
      });
    }
    try {
      const run = await workflowEngine.start(nodeId, values);
      return reply.send({
        content: run.content,
        messages: run.messages,
        nodeOutputs: run.nodeOutputs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return reply.code(500).send({ error: message });
    }
  });

  // POST /api/start/stream — execute workflow with SSE event stream.
  app.post("/api/start/stream", async (req, reply) => {
    if (!workflowEngine) {
      return reply.code(400).send({ error: "No workflow.json found" });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { nodeId, values } = extractStartArgs(body);
    const { pendingInit } = await applyRunContext(req);
    if (pendingInit.length > 0) {
      return reply.code(412).send({
        error: "Initialization required",
        pending_init: pendingInit,
      });
    }

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

    const writeEvent = (event: string, data: unknown): void => {
      if (closed || reply.raw.destroyed) return;
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
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      writeEvent("error", { message });
    } finally {
      if (!closed && !reply.raw.destroyed) reply.raw.end();
    }
  });

  // POST /api/init — start the init() flow for a node. Body:
  //   { node_id, user_id, callback_url, state_token? }
  // Returns the module's response: { status: 'redirect'|'done'|'error', ... }.
  app.post("/api/init", async (req, reply) => {
    if (!workflowEngine) {
      return reply.code(400).send({ error: "No workflow.json found" });
    }
    const body = (req.body ?? {}) as {
      node_id?: string;
      user_id?: string;
      callback_url?: string;
      state_token?: string;
    };
    if (!body.node_id || !body.user_id || !body.callback_url) {
      return reply.code(400).send({
        error: "node_id, user_id, callback_url are required",
      });
    }
    workflowEngine.setRequestContext({
      agentId: process.env.AGENT_ID,
      platformUrl: process.env.PLATFORM_URL,
      userId: body.user_id,
    });
    const result = await workflowEngine.runModuleInit(body.node_id, {
      phase: "start",
      userId: body.user_id,
      callbackUrl: body.callback_url,
      stateToken: body.state_token,
    });
    return reply.send(result);
  });

  // POST /api/init/complete — second leg of an OAuth init. Body:
  //   { node_id, user_id, code, state }
  app.post("/api/init/complete", async (req, reply) => {
    if (!workflowEngine) {
      return reply.code(400).send({ error: "No workflow.json found" });
    }
    const body = (req.body ?? {}) as {
      node_id?: string;
      user_id?: string;
      code?: string;
      state?: string;
    };
    if (!body.node_id || !body.user_id || !body.code) {
      return reply.code(400).send({
        error: "node_id, user_id, code are required",
      });
    }
    workflowEngine.setRequestContext({
      agentId: process.env.AGENT_ID,
      platformUrl: process.env.PLATFORM_URL,
      userId: body.user_id,
    });
    const result = await workflowEngine.runModuleInit(body.node_id, {
      phase: "complete",
      userId: body.user_id,
      callbackUrl: "",
      code: body.code,
      state: body.state,
    });
    return reply.send(result);
  });

  // GET /api/init/status?user_id=X — list init-bearing nodes and their
  // status for the given user.
  //
  // Source de verite du init_status (par ordre de priorite) :
  //   1. La valeur persistee dans agent_user_module_config (set par le
  //      handler /api/init de la plateforme apres un init() reussi, ou par
  //      le daemon CLI via /api/agents/:id/persist-user-config en mode local).
  //   2. Heuristique `produces` du manifest : "done" si tous les ports
  //      declares dans `produces` sont presents dans la config persistee.
  //      Utile pour les modules OAuth qui peuplent auth_data sans passer
  //      par notre route persist-user-config.
  app.get("/api/init/status", async (req, reply) => {
    if (!workflowEngine) {
      return reply.code(400).send({ error: "No workflow.json found" });
    }
    const userId = (req.query as { user_id?: string })?.user_id;
    const initNodes = workflowEngine.listInitNodes();

    type SetupEntry = {
      config?: Record<string, unknown>;
      init_status?: string;
      init_error?: string | null;
    };
    let userSetup: Record<string, SetupEntry> | null = null;
    if (userId) {
      const platformUrl = process.env.PLATFORM_URL;
      const agentId = process.env.AGENT_ID;
      const agentToken = process.env.AGENT_PLATFORM_TOKEN;
      if (platformUrl && agentId && agentToken) {
        try {
          const url = `${platformUrl.replace(/\/$/, "")}/api/agents/${encodeURIComponent(agentId)}/user-config?user_id=${encodeURIComponent(userId)}`;
          const res = await fetch(url, {
            headers: { "x-agent-id": agentId, "x-agent-token": agentToken },
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data = (await res.json()) as {
              nodes?: Record<string, SetupEntry>;
            };
            if (data?.nodes && typeof data.nodes === "object") {
              userSetup = data.nodes;
            }
          }
        } catch (err) {
          console.warn("[init-status] user-config fetch failed:", err);
        }
      }
    }

    const nodes = initNodes.map((n) => {
      const entry = userSetup?.[n.node_id];
      let initStatus: "done" | "error" | "pending";
      if (entry?.init_status === "done" || entry?.init_status === "error") {
        initStatus = entry.init_status;
      } else {
        const produces = n.produces ?? [];
        const cfg = entry?.config;
        const done =
          produces.length > 0 &&
          cfg &&
          produces.every((k) => cfg[k] !== undefined && cfg[k] !== null);
        initStatus = done ? "done" : "pending";
      }
      return {
        ...n,
        init_status: initStatus,
        init_error: entry?.init_error ?? null,
      };
    });

    return reply.send({
      nodes,
      ready: nodes
        .filter((n) => n.required)
        .every((n) => n.init_status === "done"),
    });
  });

  // 6. Start server
  await app.listen({ port, host });
  console.log(`Agent "${manifest.name}" running on http://${host}:${port}`);

  // 7. Graceful shutdown — dispose listeners then close Fastify
  const shutdown = async (signal: string) => {
    console.log(`[agent] received ${signal}, shutting down…`);
    try {
      if (workflowEngine) await workflowEngine.disposeListeners();
      await app.close();
    } catch (err) {
      console.warn(`[agent] shutdown error:`, err);
    } finally {
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}
