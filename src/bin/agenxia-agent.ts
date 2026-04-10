#!/usr/bin/env node
// CLI entry point for running an agent

// Load .env from the current working directory before anything else so
// LLM_API_URL / LLM_API_KEY / custom env vars are available to the server.
import "dotenv/config";

import { createAgentServer } from "../server.js";

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const manifestPath = getArg("manifest");
const port = getArg("port") ? parseInt(getArg("port")!, 10) : undefined;

createAgentServer({ manifestPath, port }).catch((err) => {
  console.error("Failed to start agent:", err);
  process.exit(1);
});
