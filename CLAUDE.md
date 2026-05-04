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
  llm.ts             # createLLM() + getLLMClient() — client OpenAI-compatible (chat + embeddings)
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

### Input resolution hierarchy (manifest v2)

Pour chaque input declare dans `node.data.ports.inputs`, `executeNode`
resout la valeur dans l'ordre (plus specifique au moins) :

1. **`port.value`** — constante figee dans la sidebar (ecrase les edges)
2. **Edge amont** — valeur deja posee par `resolveInputs`
3. **`node.data.config[id]`** — override sauve depuis l'onglet "Parametres" du workflow (scope `param-admin` / `param-user`)
4. **`port.default`** — fallback du manifest
5. `undefined` sinon

Fallback supplementaire : toute cle restante de `node.data.config` est
exposee comme input. Permet aux modules migres `(inputs, context)` de
lire `inputs.foo` sans dependre d'une declaration explicite dans
`node.data.ports.inputs` (compat workflow.json legacy).

### Params interpolation (legacy, pour modules non migres)

`executeNode` interpole `node.data.config` et le passe en 2e arg aux
modules pre-v2 :
- `buildNamedInputs(node, inputs)` cree une vue label-keyee depuis `node.data.ports.inputs`
- `interpolateParams(params, view)` remplace `{{name}}` dans les strings
- Objets/arrays JSON-stringifies, cles manquantes → chaine vide
- Les inputs eux-memes ne sont pas modifies (le module recoit les inputs bruts)

### Modules

Fichiers `modules/<id>/execute.js` en CommonJS. Signature preferee (v2) :
```js
module.exports = async function execute(inputs, context) {
  // inputs  — tout y est : edges amont, constantes figees, overrides
  //           param-admin/param-user, defaults du manifest
  // context — { manifest, llm?, nodeId, history, convert, log,
  //             agentId, platformUrl, sessionId }
  return { response: "..." };
};
```
Signature legacy `(inputs, params, context)` toujours acceptee — le SDK
fournit `params` = `node.data.config` interpole pour compat.

Charges via `new Function` shim (pas import/require) car les agents ont `"type": "module"`.
Sans execute.js = passthrough.

### LLM client

Le SDK expose deux helpers depuis `@agenxia/sdk/llm` :

- **`getLLMClient(overrides?)`** (recommandé) — auto-detecte le mode :
  - **Mode plateforme** : si `PLATFORM_URL` + `AGENT_PLATFORM_TOKEN` sont présents (injectés par le daemon CLI ou par Coolify au démarrage), route les appels vers le proxy plateforme `${PLATFORM_URL}/api/llm/v1/chat/completions`. L'agent n'a aucun secret à gérer.
  - **Mode standalone** : fallback sur `LLM_API_URL` + `LLM_API_KEY` du `.env` local — utile pour exécuter un agent hors de la plateforme.
- **`createLLM({ apiUrl, apiKey, model, ... })`** — client OpenAI-compat bas niveau, à utiliser quand on veut piloter manuellement l'URL et la clé (ex. provider externe spécifique).

Le client retourné expose deux méthodes :

- **`chat(messages, overrides?)`** → `{ content, model, usage? }` — POST `/v1/chat/completions`, format OpenAI strict (`messages: [{ role, content }]`).
- **`embed(input, overrides?)`** → `{ embeddings: number[][], model, usage? }` — POST `/v1/embeddings`. `input` peut être `string` ou `string[]` ; `embeddings` est **toujours** un tableau de vecteurs (longueur 1 pour un input unique).

**Piège** : le `model` par défaut de `getLLMClient` (`llama-3.3-70b`) est un chat model. Pour `embed()` il faut passer un embedding model en override, soit à la construction (`getLLMClient({ model: 'text-embedding-3-small' })`), soit à l'appel (`client.embed(input, { model: 'text-embedding-3-small' })`).

Dans un node `execute.js`, `context.llm` est instancié automatiquement via `getLLMClient` quand le node a une `model` définie ; sinon `undefined`. Params (model, temperature, max_tokens, system_prompt) lus depuis le workflow node config en priorité, env vars en fallback.

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
- Ne pas casser : format workflow.json, protocole A2A JSON-RPC
- Signature module : `(inputs, context)` pour les nouveaux modules, `(inputs, params, context)` reste supporte pour compat
