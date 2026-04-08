# @agenxia/sdk

Declarative agent runtime. Embed a workflow engine in your agent, expose it
via A2A (JSON-RPC 2.0), stream execution events over SSE, and let interactive
widgets drive reactive re-execution of downstream nodes.

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

### `chat` — classic workflow run

```json
POST /a2a
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "chat",
  "params": { "message": "Bonjour" }
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

### `widget_trigger` — reactive re-execution from a widget interaction

When an interactive widget (calendar, form, picker…) emits new values on its
output ports, the frontend sends a `widget_trigger` request. The engine
merges `portValues` into the widget's cached output and re-executes **only
the downstream subgraph**. Upstream connectors (fetch, DB query, LLM) keep
their cached outputs and are never re-run.

```json
POST /a2a
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "widget_trigger",
  "params": {
    "nodeId": "widget-calendar-1",
    "portValues": { "selection": { "date": "2026-04-09" } }
  }
}
```

Preconditions:

- At least one `chat` (or equivalent `run()`) must have executed before —
  the engine needs the warmed output cache to resolve inputs for descendants
  whose other predecessors live upstream of the widget.
- `nodeId` must exist in `workflow.json`.

The response shape is identical to `chat`: `{ content, messages, nodeOutputs }`.

### Streaming — `POST /a2a/stream`

Same body as `/a2a`, returns `text/event-stream`. Works for both `chat` and
`widget_trigger`. Events emitted:

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

For `widget_trigger`, events are scoped to the re-executed subgraph: the
source widget node and all out-of-subgraph nodes stay silent.

## Programmatic API

```ts
import { WorkflowEngine, createWorkflowEngine } from "@agenxia/sdk";

const engine = createWorkflowEngine({
  workflowPath: "./workflow.json",
  modulesDir: "./modules",
  manifest: { name: "my-agent" },
  // llm: optional
});

// Full run
const r1 = await engine.run("Bonjour");

// Reactive trigger from a widget
const r2 = await engine.triggerFromNode("widget-calendar-1", {
  selection: { date: "2026-04-09" },
});

// Inspect cached outputs
const cache = engine.getLastOutputs();
```

### Streaming from code

```ts
await engine.run("Bonjour", {
  onEvent: (event) => {
    console.log(event.type, event);
  },
});
```

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
that don't simply ignore it. The SDK creates the LLM client only when both
`LLM_API_URL` and `LLM_API_KEY` are available — either from a workflow node
config (priority) or from environment variables (fallback).

Modules without `execute.js` are treated as passthrough — they re-emit their
inputs. This is the default for UI widgets.

## Reactive widget pattern

A typical interactive-widget workflow looks like this:

```
[Fetch ICS] → [widget-calendar] → [widget-selector] → [Display]
```

1. First `chat` run: `Fetch ICS` hits the network, `widget-calendar` is a
   passthrough that receives `{ events: [...] }`, downstream nodes see the
   events list. The user gets an initial UI rendering.
2. User clicks a date in the calendar. Frontend sends:
   ```json
   { "method": "widget_trigger",
     "params": { "nodeId": "widget-calendar",
                 "portValues": { "selection": { "date": "2026-04-09" } } } }
   ```
3. Engine merges `{ selection: {...} }` into the cached output of
   `widget-calendar` (preserving `events: [...]`), then re-executes only
   `widget-selector` and `Display`. `Fetch ICS` stays cached.
4. Subsequent clicks (10, 100, 1000…) cost exactly one downstream re-run
   each. `Fetch ICS` runs exactly once for the entire session.

## License

MIT
