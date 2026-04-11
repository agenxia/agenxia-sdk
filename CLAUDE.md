# CLAUDE.md — @agenxia/sdk

## What is this

Declarative agent runtime. Un agent = un workflow.json + des modules.
Le SDK l'expose via A2A (JSON-RPC 2.0) et execute le workflow localement.

## Build & test

```bash
npx tsc                                  # build (TS strict, ES2022, Node16 modules)
node --test tests/workflow-engine.test.ts # 10 tests engine
node --test tests/interpolate-params.test.ts # 11 tests interpolation
```

Pas de linter configure dans le repo (pas de eslint.config.js).

## Architecture

```
src/
  server.ts          # Fastify — routes /health /docs /a2a /a2a/stream /api/sync
  workflow-engine.ts  # WorkflowEngine class — DAG executor with caching
  llm.ts             # createLLM() — client OpenAI-compatible (optionnel)
  types.ts           # AgentManifest, PortDefinition, MethodDefinition
  agent-card.ts      # Agent discovery card generator
  docs.ts            # HTML doc generator
  index.ts           # Barrel exports
  bin/agenxia-agent.ts  # CLI: agenxia-agent [--manifest path] [--port num]
  a2a/               # A2A protocol: client, handlers, middleware, types
tests/
  workflow-engine.test.ts      # start(), port routing, reactive, getState
  interpolate-params.test.ts   # buildNamedInputs, interpolateParams
```

## Key concepts

### Single execution primitive: `engine.start(nodeId?, values?, options?)`

- `nodeId` defaut = workflow.entrypoint
- `values` merge par-dessus resolveInputs du start node
- Le start node EST execute (passthrough ou module)
- Seuls startId + descendants sont re-executes ; upstream reste cache (lastOutputs)
- Premier appel = run from scratch ; appels suivants = reactive re-execution
- Mutex interne serialise les appels concurrents

### Port routing dans resolveInputs

- Edge avec sourceHandle + targetHandle : `target.inputs[targetHandle] = source.output[sourceHandle]`
- Edge sans handles : merge brut (fallback legacy)
- Cle manquante cote source : la cle target est presente avec valeur `undefined`
- Conflit sur meme targetHandle : derniere edge gagne

### Params interpolation

`executeNode` interpole `node.data.config` avant de le passer au module :
- `buildNamedInputs(node, inputs)` cree une vue label-keyee depuis `node.data.ports.inputs`
- `interpolateParams(params, view)` remplace `{{name}}` dans les strings
- Objets/arrays JSON-stringifies, cles manquantes → chaine vide
- Les inputs eux-memes ne sont pas modifies (le module recoit les inputs bruts)

### Modules

Fichiers `modules/<id>/execute.js` en CommonJS :
```js
module.exports = async function execute(inputs, params, context) {
  // inputs  — outputs upstream routes par port
  // params  — node.data.config interpole
  // context — { manifest, llm?, nodeId, history }
  return { response: "..." };
};
```
Charges via `new Function` shim (pas import/require) car les agents ont `"type": "module"`.
Sans execute.js = passthrough.

### LLM optionnel

`context.llm` est `undefined` si pas de LLM_API_URL + LLM_API_KEY.
Params LLM lus depuis le workflow node config (priorite) puis env vars (fallback).

## A2A server (src/server.ts)

Methodes JSON-RPC exposees :
- `start` : `{ nodeId?, values? }` → execute le workflow
- `state` : `{}` → snapshot read-only (content, messages, nodeOutputs)

Routes REST :
- `GET /health` — uptime, version
- `GET /.well-known/agent-card.json` — agent card
- `GET /docs` — HTML documentation
- `POST /a2a` — JSON-RPC 2.0
- `POST /a2a/stream` — SSE streaming (memes events : node_start, node_complete, edge_active, workflow_complete)
- `POST /api/sync` — git pull --ff-only (reseau interne plateforme)

## Version

2.1.0 (package.json). ES module, TypeScript strict.
dist/ est commite (pas de CI build).

## Conventions

- TypeScript strict, pas de `any` sauf cast explicite documente
- Modules CJS dans les agents, SDK en ESM
- Commits en anglais, messages clairs
- `npx tsc` doit passer apres chaque modif
- Tests via `node --test` (pas de framework externe)
- Ne pas toucher : workflow.json format, module execute.js signature, A2A JSON-RPC protocol
