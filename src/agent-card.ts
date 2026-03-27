// Generate an AgentCard from the agenxia.json manifest

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import type { AgentManifest } from "./types.js";

interface AgentCardOutput {
  name: string;
  description: string;
  version: string;
  protocol: string;
  capabilities: string[];
  config: Record<string, unknown>;
  env_vars: string[];
  endpoints: Record<string, string>;
  methods: Array<{
    name: string;
    description?: string;
    params: Record<string, unknown>;
    returns?: Record<string, unknown>;
    example?: { request: unknown; response: unknown };
  }>;
  api: Array<{ method: string; path: string; description: string }>;
  metadata: Record<string, unknown>;
}

/**
 * Scan api/ directory for route files and derive HTTP endpoints.
 */
function scanRoutes(rootDir: string): Array<{ method: string; path: string; file: string }> {
  const apiDir = join(rootDir, "api");
  const routes: Array<{ method: string; path: string; file: string }> = [];

  try {
    const entries = readdirSync(apiDir, { recursive: true }) as string[];
    for (const entry of entries) {
      const fullPath = join(apiDir, String(entry));
      if (statSync(fullPath).isDirectory()) continue;
      if (extname(String(entry)) !== ".js") continue;

      const name = basename(String(entry), ".js");
      const entryStr = String(entry);
      const relDir = entryStr.replace(/[\/][^\/]+$/, "");
      const dirPrefix = relDir === entryStr ? "" : `/${relDir.replace(/\\/g, "/")}`;
      const routePath = `/api${dirPrefix}/${name}`;

      let method = "POST";
      if (["health", "status", "docs", "info"].includes(name)) method = "GET";
      if (name === "a2a") method = "POST";

      routes.push({ method, path: routePath, file: `api/${entryStr}` });
    }
  } catch {
    // api/ directory may not exist
  }

  return routes;
}

/**
 * Generate the full agent-card object from agenxia.json.
 */
export function generateAgentCard(options: {
  rootDir?: string;
  deployUrl?: string;
  manifest?: AgentManifest;
} = {}): AgentCardOutput {
  const rootDir = options.rootDir ?? process.cwd();

  let manifest: AgentManifest;
  if (options.manifest) {
    manifest = options.manifest;
  } else {
    try {
      const raw = readFileSync(join(rootDir, "agenxia.json"), "utf-8");
      manifest = JSON.parse(raw) as AgentManifest;
    } catch {
      manifest = { name: "unknown", description: "", type: "agent" };
    }
  }

  const scannedRoutes = scanRoutes(rootDir);

  const endpoints: Record<string, string> = {
    agent_card: "/.well-known/agent-card.json",
    docs: "/docs",
    health: "/health",
  };

  const hasA2a = scannedRoutes.some((r) => r.path.includes("/a2a"));
  if (hasA2a) {
    endpoints.a2a = "/api/a2a";
    const hasStream = scannedRoutes.some((r) => r.path.includes("/a2a/stream"));
    if (hasStream) endpoints.stream = "/api/a2a/stream";
  }

  const api: Array<{ method: string; path: string; description: string }> = [
    { method: "GET", path: "/health", description: "Health check" },
    { method: "GET", path: "/.well-known/agent-card.json", description: "Agent discovery card" },
    { method: "GET", path: "/docs", description: "API documentation (HTML)" },
  ];

  for (const route of scannedRoutes) {
    const alreadyListed = api.some((a) => a.path === route.path);
    if (!alreadyListed) {
      api.push({
        method: route.method,
        path: route.path,
        description: `Handler: ${route.file}`,
      });
    }
  }

  const methods = (manifest.methods ?? []).map((m) => ({
    name: m.name,
    description: m.description,
    params: m.params ?? {},
    returns: m.returns,
    example: m.example,
  }));

  // Strip sensitive values from config for the card
  const safeConfig: Record<string, unknown> = {};
  if (manifest.config) {
    for (const [key, value] of Object.entries(manifest.config)) {
      if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret")) {
        safeConfig[key] = "***";
      } else {
        safeConfig[key] = value;
      }
    }
  }

  return {
    name: manifest.name ?? "unknown",
    description: manifest.description ?? "",
    version: manifest.version ?? "1.0.0",
    protocol: "a2a-1.0",
    capabilities: manifest.capabilities ?? manifest.features ?? [],
    config: safeConfig,
    env_vars: manifest.env_vars ?? [],
    endpoints,
    methods,
    api,
    metadata: {
      author: "agenxia",
      source_template: manifest.source_template ?? null,
      type: manifest.type ?? "agent",
      ...(options.deployUrl && { deploy_url: options.deployUrl }),
    },
  };
}
