// Main agent server factory

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import type { AgentManifest, A2AResult } from "./types.js";
import { A2A_ERROR_CODES } from "./a2a/types.js";
import { generateAgentCard } from "./agent-card.js";
import { generateDocs } from "./docs.js";
import { createLLM } from "./llm.js";
import type { LLMOptions } from "./llm.js";
import {
  createWorkflowEngine,
  defaultWorkflowPaths,
  type WorkflowEngine,
} from "./workflow-engine.js";

export interface ProcessContext {
  manifest: AgentManifest;
  llm?: ReturnType<typeof createLLM>;
  params: Record<string, unknown>;
  method: string;
  callerId: string;
  depth: number;
  requestId: string;
}

export type ProcessFunction = (ctx: ProcessContext) => Promise<A2AResult>;

export interface ServerOptions {
  manifestPath?: string;
  processPath?: string;
  port?: number;
  host?: string;
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
export async function createAgentServer(
  options: ServerOptions = {},
): Promise<void> {
  const manifestPath = resolve(options.manifestPath ?? "./agenxia.json");
  const processPath = resolve(options.processPath ?? "./process.js");
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

  // 2. Import process function
  let processFunc: ProcessFunction | null = null;
  try {
    const mod = (await import(pathToFileURL(processPath).href)) as {
      default?: ProcessFunction;
      process?: ProcessFunction;
    };
    processFunc = mod.default ?? mod.process ?? null;
  } catch {
    console.warn(`Warning: Could not import ${processPath}`);
  }

  // 3. Create LLM client if env vars available (LLM is OPTIONAL)
  let llm: ReturnType<typeof createLLM> | undefined;
  const config = manifest.config;
  const apiUrl = process.env.LLM_API_URL ?? "";
  const apiKey = process.env.LLM_API_KEY ?? "";
  if (apiUrl && apiKey) {
    const llmOptions: LLMOptions = {
      apiUrl,
      apiKey,
      model: config?.model ?? "gpt-4o-mini",
      systemPrompt: config?.system_prompt,
      temperature: config?.temperature,
      maxTokens: config?.max_tokens,
    };
    llm = createLLM(llmOptions);
  }

  // 4. Try to load workflow.json — if found, the engine replaces processFunc
  const { workflowPath, modulesDir } = defaultWorkflowPaths(manifestPath);
  let workflowEngine: WorkflowEngine | null = null;
  try {
    workflowEngine = createWorkflowEngine({
      workflowPath,
      modulesDir,
      manifest,
      llm,
    });
    if (workflowEngine) {
      console.log(`[workflow] loaded ${workflowPath}`);
    }
  } catch (err) {
    console.warn(`[workflow] failed to initialize:`, err);
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
    const html = generateDocs(card as any, deployUrl);
    reply.type("text/html").send(html);
  });

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
      let result: A2AResult;
      if (workflowEngine) {
        // Extract message from A2A params. Supported shapes:
        //   { message: "..." } | { input: "..." } | { messages: [{content}] }
        const params = body.params ?? {};
        let msg = "";
        if (typeof params.message === "string") msg = params.message;
        else if (typeof params.input === "string") msg = params.input;
        else if (Array.isArray((params as Record<string, unknown>).messages)) {
          const msgs = (params as { messages: Array<{ content?: string }> })
            .messages;
          msg = msgs[msgs.length - 1]?.content ?? "";
        }
        const run = await workflowEngine.run(msg);
        result = {
          content: run.content,
          messages: run.messages,
        } as unknown as A2AResult;
      } else if (processFunc) {
        result = await processFunc({
          manifest,
          llm,
          params: body.params ?? {},
          method: body.method,
          callerId,
          depth,
          requestId,
        });
      } else {
        throw new Error("No executor available");
      }
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

  // 6. Start server
  await app.listen({ port, host });
  console.log(`Agent "${manifest.name}" running on http://${host}:${port}`);
}
