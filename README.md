# @agenxia/sdk

Declarative agent runtime. An agent is a **generic workflow executor**:
you ship a `workflow.json`, the SDK exposes it over a single A2A endpoint,
streams execution events over SSE, and lets interactive widgets drive
reactive re-execution of downstream nodes — without re-running upstream
connectors.

## Install

```bash
npm install @agenxia/sdk
```

## Quick start

```bash
# In your agent directory
agenxia-agent
```

Looks for `agenxia.json` (manifest), `workflow.json` (graph), and
`modules/<id>/execute.js` (CommonJS module executors). Loads `.env`
automatically at startup.

## A2A protocol

The agent exposes **one JSON-RPC method**: `start`. It runs the workflow
from a given node with a given set of values. That's it — no `chat`, no
`widget_trigger`. Conversational workflows and widget interactions are
conventions layered on top, not features of the API.

### `start` — execute a workflow

```json
POST /a2a
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "start",
  "params": {
    "nodeId": "wf_node_abc",          // optional, defaults to workflow.entrypoint
    "values": { "message": "Bonjour" } // optional, merged into start node inputs
  }
}
```

Response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": "...",
    "messages": [...],
    "nodeOutputs": { "node1": {...}, "node2": {...} }
  }
}
```

**Semantics:**

- `nodeId` defaults to `workflow.entrypoint`. Must exist in the workflow
  or the server returns `-32602 Invalid params`.
- `values` is merged on top of the start node's computed inputs (upstream
  cached outputs routed via `resolveInputs`, then `values` on top).
- The start node runs its module (or passthrough) with the merged inputs.
- Only the start node and its descendants are (re-)executed. Everything
  else keeps its cached output from the previous `start` call.
- On the first call, the cache is empty — descendants with unresolved
  upstream dependencies are skipped by the scheduler.

**Conversational workflows** are just workflows where a user message
happens to drive execution. The client calls `start` with
`values: { message: "..." }` and the workflow's edges forward the message
to wherever it's needed (e.g. an LLM module like `openai` or `anthropic`
via `sourceHandle: "message" → targetHandle: "message"` routing).

```json
// Conversational convention
{ "method": "start", "params": { "values": { "message": "Bonjour" } } }
```

**Widget interactions** are just workflows where the user clicks
something in a UI node and that click needs to propagate downstream. The
client calls `start` with `nodeId` set to the widget and `values` set to
the new port values the user produced.

```json
// Widget click convention
{ "method": "start",
  "params": { "nodeId": "widget-calendar-1",
              "values": { "selection": { "date": "2026-04-09" } } } }
```

Upstream connectors (fetch ICS, DB query, LLM call) keep their cached
outputs from the initial run and are not re-executed.

### Streaming — `POST /a2a/stream`

Same body as `/a2a`, returns `text/event-stream`. Events emitted:

```
event: node_start
data: { "nodeId": "...", "label": "...", "moduleId": "..." }

event: node_complete
data: { "nodeId": "...", "output": {...}, "durationMs": 123 }

event: edge_active
data: { "source": "...", "target": "...", "sourceHandle": "...", "targetHandle": "..." }

event: workflow_complete
data: { "content": "...", "messages": [...], "nodeOutputs": {...} }
```

When `start` is called with a widget `nodeId`, events are scoped to the
re-executed subgraph: nodes outside the descendant subgraph stay silent.

## Programmatic API

```ts
import { WorkflowEngine, createWorkflowEngine } from "@agenxia/sdk";

const engine = createWorkflowEngine({
  workflowPath: "./workflow.json",
  modulesDir: "./modules",
  manifest: { name: "my-agent" },
  // llm: optional, passed to modules via context.llm
});

// Initial run from the entrypoint (no nodeId, no values)
await engine.start();

// Conversational run: inject a message
await engine.start(undefined, { message: "Bonjour" });

// Widget click: re-run only the widget + its descendants
await engine.start("widget-calendar-1", {
  selection: { date: "2026-04-09" },
});

// Inspect cached outputs
const cache = engine.getLastOutputs();
```

### Streaming from code

```ts
await engine.start(undefined, { message: "Bonjour" }, {
  onEvent: (event) => {
    console.log(event.type, event);
  },
});
```

## Port routing

Edges in `workflow.json` can declare `sourceHandle` and `targetHandle`.
When both are set, only the named field is forwarded, exposed under the
target's declared name:

```json
{
  "source": "connector-ics",
  "sourceHandle": "events",
  "target": "widget-calendar",
  "targetHandle": "events"
}
```

This means:

```js
// inside widget-calendar's execute.js
module.exports = async function (inputs) {
  // inputs === { events: [...] }
  // NOT { events: [...], someOtherConnectorKey: "..." }
};
```

**Visual semantics:**

```
┌──────────────┐  events  ┌────────────────┐  selection  ┌────────┐
│ connector-ics├──────────▶ widget-calendar├─────────────▶ output │
└──────────────┘          └────────────────┘             └────────┘
                                          ^^^ only `selection`
                                          is forwarded to output,
                                          under the target name
                                          `output-in`.
```

After a `widget_trigger` that merges `{selection: {date:...}}` into the
widget's cached output, the `output` node receives exactly
`{ "output-in": { date: ... } }` — the `events` array from the connector
stays confined to the widget and does not leak downstream.

**Edge without handles** (legacy shape `{source, target}`): the entire
upstream output is merged into the target inputs, as before. This keeps
old workflows working without migration.

**Conflict rule:** if two edges target the same `targetHandle`, the edge
listed last in `workflow.json` wins, regardless of execution order.

**Missing source field:** if `source.output[sourceHandle]` is `undefined`,
the target key is still present in `inputs` with value `undefined`.
Modules can distinguish "wired but empty" from "not wired at all".

## Modules

Module executors live in `modules/<moduleId>/execute.js` and use CommonJS:

```js
module.exports = async function execute(inputs, params, context) {
  // inputs  — merged outputs of upstream nodes
  // params  — node.data.config from workflow.json
  // context — { manifest, llm?, nodeId, history }
  return { response: "..." };
};
```

`context.llm` is **optional**. Modules that need a LLM check for it; modules
that don't simply ignore it. The SDK creates the LLM client via
`getLLMClient()`, which auto-detects the runtime mode: platform proxy
(`PLATFORM_URL` + `AGENT_PLATFORM_TOKEN`) or standalone (`LLM_API_URL` +
`LLM_API_KEY`). Workflow node config takes priority over env vars.

The client exposes both `chat()` and `embed()`. Model must be supplied
explicitly (no default) — via `overrides.model`, the `LLM_MODEL` env var,
or the workflow node config:

```ts
import { getLLMClient } from "@agenxia/sdk/llm";

const llm = getLLMClient({ model: "mistral/mistral-small" });
const { content } = await llm.chat([
  { role: "user", content: "Bonjour" },
]);

// For embeddings, pass an embedding model — a chat model won't work.
const { embeddings } = await llm.embed(
  ["premier texte", "second texte"],
  { model: "text-embedding-3-small" },
);
// embeddings.length === 2, each entry is a number[]
```

Modules without `execute.js` are treated as passthrough — they re-emit their
inputs. This is the default for UI widgets.

## Reactive widget pattern

A typical interactive-widget workflow looks like this:

```
[Fetch ICS] → [widget-calendar] → [Display]
        events → events            selection → output-in
```

1. **Initial call**: client sends `start()` (no args). `Fetch ICS` hits the
   network, `widget-calendar` is a passthrough that receives
   `{ events: [...] }`, `Display` receives `{ "output-in": undefined }`
   (the user has not clicked yet). The UI renders an empty selection.
2. **User clicks a date** in the calendar. The frontend sends:
   ```json
   { "method": "start",
     "params": { "nodeId": "widget-calendar",
                 "values": { "selection": { "date": "2026-04-09" } } } }
   ```
3. The engine builds `widget-calendar`'s inputs from its cached upstream
   (`{ events: [...] }`) and merges `values` on top
   (`{ events: [...], selection: {...} }`). The widget passthrough runs
   and returns both keys. Port routing then forwards only the
   `selection` field to `Display` under the name `output-in`.
4. `Display` re-runs with `{ "output-in": { date: "2026-04-09" } }`.
   `Fetch ICS` **does not** re-run — it stays cached.
5. Subsequent clicks (10, 100, 1000…) cost exactly one downstream re-run
   each. `Fetch ICS` runs exactly once for the entire session.

## License

MIT
