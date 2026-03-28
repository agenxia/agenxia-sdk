#!/usr/bin/env node
// CLI entry point for running an agent
import { createAgentServer } from "../server.js";
const args = process.argv.slice(2);
function getArg(name) {
    const idx = args.indexOf(`--${name}`);
    return idx !== -1 ? args[idx + 1] : undefined;
}
const processPath = getArg("process");
const manifestPath = getArg("manifest");
const port = getArg("port") ? parseInt(getArg("port"), 10) : undefined;
createAgentServer({ processPath, manifestPath, port }).catch((err) => {
    console.error("Failed to start agent:", err);
    process.exit(1);
});
//# sourceMappingURL=agenxia-agent.js.map