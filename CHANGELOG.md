# Changelog

All notable changes to `@agenxia/sdk`.

## [1.1.0] - 2026-04-09

### Added — reactive mode via `triggerFromNode`

Interactive widgets can now inject values on their output ports and re-execute
only the downstream subgraph without re-running upstream connectors (fetch,
DB, LLM). This is a non-breaking additive feature — `run(message)` behaves
identically.

- `WorkflowEngine.triggerFromNode(nodeId, portValues, options?)` — merges
  `portValues` into the cached output of `nodeId`, computes the strict
  descendant set, and re-executes only those nodes. Requires a prior `run()`
  call to warm the cache; throws otherwise.
- `WorkflowEngine.getLastOutputs()` — snapshot of the last known output for
  every executed node, updated by both `run()` and `triggerFromNode()`.
- Streaming events (`node_start`, `node_complete`, `edge_active`,
  `workflow_complete`) are scoped to the re-executed subgraph — the source
  node and out-of-subgraph nodes stay silent.
- Internal mutex (`withLock`) serializes `run()` and `triggerFromNode()` calls
  to prevent concurrent mutations of the shared output cache.
- A2A handler: `POST /a2a` and `POST /a2a/stream` accept
  `{ method: "widget_trigger", params: { nodeId, portValues } }` as JSON-RPC
  input. Works with both the buffered and the SSE endpoints.
- Types: `WorkflowTriggerOptions` exported from the barrel.

### Tests

Ten unit tests covering: basic descendant re-execution, upstream cache reuse,
diamond graph with partial re-execution, sink widget persistence,
precondition (no run before trigger), trigger chaining, cost budget (upstream
called once across 10 triggers), concurrent trigger serialization, merge
preserving pre-existing keys, and event scoping.

## [1.0.0] - 2026-04-08

Initial release:

- Local workflow engine executing `workflow.json` with BFS batch traversal,
  back-edge detection, and in-memory history.
- CJS module loader (`modules/<id>/execute.js`) via `new Function` shim,
  compatible with agents using `"type": "module"`.
- LLM params resolved from workflow node config first, env vars as fallback.
- SSE streaming via `POST /a2a/stream`.
- A2A JSON-RPC 2.0 endpoint, agent card, docs, health.
- `.env` auto-loading at CLI startup via `dotenv`.
