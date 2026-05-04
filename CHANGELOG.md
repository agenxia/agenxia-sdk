# Changelog

All notable changes to `@agenxia/sdk`.

## [2.5.0] - 2026-04-27

### Added — `embed()` on the LLM client

`createLLM()` and `getLLMClient()` now return an `LLMClient` exposing both
`chat()` and `embed()`. Same auto-detect logic as before — platform proxy
when `PLATFORM_URL` + `AGENT_PLATFORM_TOKEN` are set, standalone via
`LLM_API_URL` + `LLM_API_KEY` otherwise.

```ts
const llm = getLLMClient({ model: "text-embedding-3-small" });
const { embeddings, usage } = await llm.embed(["hello", "world"]);
// embeddings: number[][] (always, even for a single string input)
```

The default model of `getLLMClient()` (`llama-3.3-70b`) is a chat model;
pass an embedding model explicitly to `embed()` (or to `getLLMClient`)
when you need vectors.

New types: `EmbeddingResponse`, `LLMClient`. No breaking change on
`chat()`.

## [2.0.0] - 2026-04-09

### BREAKING — unified `start(nodeId?, values?)` API

The old `run(message)` / `triggerFromNode(nodeId, portValues)` split on the
engine and the matching `chat` / `widget_trigger` methods on the A2A server
are gone. They were two names for the same operation: "execute a workflow
starting from a node with some initial values". The new API collapses both
into a single primitive.

**Engine:**

```ts
engine.start(nodeId?: string, values?: Record<string, unknown>, options?: StartOptions)
```

- `nodeId` defaults to `workflow.entrypoint`.
- `values` are merged on top of the computed inputs of the start node
  (upstream cached outputs via `resolveInputs`, then `values` on top).
- The start node **is** executed (unlike the old `triggerFromNode` which
  only mutated its cached output). Its module/passthrough runs with the
  merged inputs and produces a fresh output.
- Only the start node and its descendants are re-executed. Nodes outside
  the descendant subgraph keep their cached outputs from `lastOutputs`.
- On the first call `lastOutputs` is empty — the scheduler simply skips
  descendants whose upstream dependencies are unresolved.
- `lastOutputs` is updated with the new outputs of executed nodes.

Removed:
- `WorkflowEngine.run(message, options)`
- `WorkflowEngine.triggerFromNode(nodeId, portValues, options)`
- `WorkflowRunOptions`, `WorkflowTriggerOptions` types
- Internal `_runFull` / `_triggerFromNode` / `hasRun` flag

Added:
- `StartOptions` type (replaces the two old option types)

**A2A server:**

```json
POST /a2a
{ "jsonrpc": "2.0", "id": 1, "method": "start",
  "params": { "nodeId": "wf_node_...", "values": { "message": "..." } } }
```

`nodeId` and `values` are both optional. Unknown methods return
`-32602 Invalid params`. The streaming endpoint `/a2a/stream` accepts
the same method/params.

Removed:
- A2A method `chat` (replaced by `start` with `values.message`)
- A2A method `widget_trigger` (replaced by `start` with `nodeId` + `values`)

**Rationale:** an agent is a generic workflow executor, not a chatbot. A
workflow that happens to contain an `agent-core` node calling a LLM is a
detail of the workflow graph, not a feature of the agent API. The old
`chat` method presupposed conversational semantics at the wrong layer.

**Migration:**

```diff
- await engine.run("hello")
+ await engine.start(undefined, { message: "hello" })

- await engine.triggerFromNode("widget-id", { selection: {...} })
+ await engine.start("widget-id", { selection: {...} })

- curl -d '{"jsonrpc":"2.0","id":1,"method":"chat","params":{"message":"hi"}}'
+ curl -d '{"jsonrpc":"2.0","id":1,"method":"start","params":{"values":{"message":"hi"}}}'

- curl -d '{"jsonrpc":"2.0","id":1,"method":"widget_trigger","params":{"nodeId":"w","portValues":{"selection":{...}}}}'
+ curl -d '{"jsonrpc":"2.0","id":1,"method":"start","params":{"nodeId":"w","values":{"selection":{...}}}}'
```

Conversational workflows continue to work unchanged as long as their edge
leaving the entrypoint (or wherever `message` is produced) uses
`sourceHandle: "message"` and downstream nodes read `inputs.message` — the
standard convention used by the visual editor.

### BREAKING — `resolveInputs` now routes data by port handles

Edges with `sourceHandle` and `targetHandle` now transmit only the named
field, not the full upstream output. This matches the visual semantics of
the workflow editor and fixes a class of data-leak bugs where downstream
nodes received every key of every ancestor.

**New semantics:**

- Edge with both `sourceHandle` and `targetHandle`:
  `target.inputs[targetHandle] = source.output[sourceHandle]`.
  If `source.output[sourceHandle]` is undefined, the key is present on
  the target with value `undefined` — a module can distinguish "wired
  but empty" from "not wired".
- Edge without handles: legacy behavior — the entire source output is
  merged into the target inputs. Workflows generated before port
  routing continue to work untouched.
- Multiple edges writing the same `targetHandle`: last writer wins (edge
  order in the `edges` array decides, regardless of execution order for
  parallel branches).

**Migration guide:**

1. Audit edges in your `workflow.json` files. If they declare
   `sourceHandle`/`targetHandle`, verify that the `targetHandle` names
   match the keys your downstream modules read from `inputs`.
2. Workflows generated by the Agenxia visual editor already respect
   this convention (`events → events`, `message → message`,
   `response → response`, etc.) — no action needed.
3. Hand-written workflows that relied on implicit full-output merging
   through handled edges must either:
   - drop `sourceHandle`/`targetHandle` from those edges to opt into
     legacy merge, or
   - add explicit routing edges per field.

**Why this is fixed now:** the reactive widget mode (1.1.0) exposed the
bug visibly. After `triggerFromNode("widget-calendar", { selection: ... })`,
the widget's cached output contained `{events, selection}`, and downstream
nodes received the whole thing instead of the declared `selection → output-in`
routing — showing the raw connector data instead of the user's clicked date.

### Tests

Seven new port routing tests: simple forwarding, multi-edge merge,
conflicting target (last wins), missing source key (undefined pass-through),
legacy fallback, reactive widget scenario (regression test for the
calendar bug), and mixed handled/unhandled edges on the same target.

Total test count: 17.

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
