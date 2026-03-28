// Generate an AgentCard from the agenxia.json manifest
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
/**
 * Scan api/ directory for route files and derive HTTP endpoints.
 */
function scanRoutes(rootDir) {
    const apiDir = join(rootDir, "api");
    const routes = [];
    try {
        const entries = readdirSync(apiDir, { recursive: true });
        for (const entry of entries) {
            const fullPath = join(apiDir, String(entry));
            if (statSync(fullPath).isDirectory())
                continue;
            if (extname(String(entry)) !== ".js")
                continue;
            const name = basename(String(entry), ".js");
            const entryStr = String(entry);
            const relDir = entryStr.replace(/[\/][^\/]+$/, "");
            const dirPrefix = relDir === entryStr ? "" : `/${relDir.replace(/\\/g, "/")}`;
            const routePath = `/api${dirPrefix}/${name}`;
            let method = "POST";
            if (["health", "status", "docs", "info"].includes(name))
                method = "GET";
            if (name === "a2a")
                method = "POST";
            routes.push({ method, path: routePath, file: `api/${entryStr}` });
        }
    }
    catch {
        // api/ directory may not exist
    }
    return routes;
}
/**
 * Generate the full agent-card object from agenxia.json.
 */
export function generateAgentCard(options = {}) {
    const rootDir = options.rootDir ?? process.cwd();
    let manifest;
    if (options.manifest) {
        manifest = options.manifest;
    }
    else {
        try {
            const raw = readFileSync(join(rootDir, "agenxia.json"), "utf-8");
            manifest = JSON.parse(raw);
        }
        catch {
            manifest = { name: "unknown", description: "", type: "agent" };
        }
    }
    const scannedRoutes = scanRoutes(rootDir);
    const endpoints = {
        agent_card: "/.well-known/agent-card.json",
        docs: "/docs",
        health: "/health",
    };
    const hasA2a = scannedRoutes.some((r) => r.path.includes("/a2a"));
    if (hasA2a) {
        endpoints.a2a = "/api/a2a";
        const hasStream = scannedRoutes.some((r) => r.path.includes("/a2a/stream"));
        if (hasStream)
            endpoints.stream = "/api/a2a/stream";
    }
    const api = [
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
    const safeConfig = {};
    if (manifest.config) {
        for (const [key, value] of Object.entries(manifest.config)) {
            if (key.toLowerCase().includes("key") || key.toLowerCase().includes("secret")) {
                safeConfig[key] = "***";
            }
            else {
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
//# sourceMappingURL=agent-card.js.map