#!/usr/bin/env node
// CLI entry point for running an agent
// Note: .env loading is handled by server.ts (via dotenv/config).
import { createAgentServer } from "../server.js";
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
}
const manifestPath = getArg("manifest");
const port = getArg("port") ? parseInt(getArg("port"), 10) : undefined;
createAgentServer({ manifestPath, port }).catch((err) => {
    console.error("Failed to start agent:", err);
    process.exit(1);
});
//# sourceMappingURL=agenxia-agent.js.map