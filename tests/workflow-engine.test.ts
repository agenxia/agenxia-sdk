// Tests for the unified WorkflowEngine.start() API.
// Run: node --test tests/workflow-engine.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../dist/workflow-engine.js";

// -----------------------------------------------------------------------------
// Test harness: build a temp modules dir with execute.js files that can
// increment a per-test counter object shared via globalThis.
// -----------------------------------------------------------------------------

interface Harness {
  modulesDir: string;
  calls: Record<string, number>;
  cleanup: () => void;
}

function makeHarness(modules: Record<string, string>): Harness {
  const dir = mkdtempSync(join(tmpdir(), "wfe-test-"));
  const modulesDir = join(dir, "modules");
  mkdirSync(modulesDir, { recursive: true });
  const key = `__wfe_calls_${Date.now()}_${Math.random()}`;
  (globalThis as Record<string, unknown>)[key] = {};
  const calls = (globalThis as Record<string, unknown>)[key] as Record<
    string,
    number
  >;
  for (const [id, source] of Object.entries(modules)) {
    const modDir = join(modulesDir, id);
    mkdirSync(modDir, { recursive: true });
    const wrapped = `const __calls = globalThis[${JSON.stringify(key)}];\n${source}`;
    writeFileSync(join(modDir, "execute.js"), wrapped);
  }
  return {
    modulesDir,
    calls,
    cleanup: () => {
      delete (globalThis as Record<string, unknown>)[key];
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// -----------------------------------------------------------------------------
// 1. start() without args runs the whole workflow from workflow.entrypoint.
// -----------------------------------------------------------------------------
test("start() with no args runs the workflow from entrypoint", async () => {
  const h = makeHarness({
    A: `module.exports = async () => {
      __calls.A = (__calls.A || 0) + 1;
      return { v: "A" };
    };`,
    B: `module.exports = async (i) => {
      __calls.B = (__calls.B || 0) + 1;
      return { response: "got=" + i.v };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      edges: [
        { source: "A", sourceHandle: "v", target: "B", targetHandle: "v" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t1" } },
  );

  const r = await engine.start();
  assert.equal(h.calls.A, 1);
  assert.equal(h.calls.B, 1);
  assert.equal(r.content, "got=A");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 2. start(undefined, {message}) — conversational convention.
//    The entrypoint is a passthrough; downstream agent-core reads inputs.message.
// -----------------------------------------------------------------------------
test("start() with values={message} flows through port routing to agent-core", async () => {
  const h = makeHarness({
    entry: `module.exports = async (i) => i;`, // passthrough
    core: `module.exports = async (i) => {
      __calls.core = (__calls.core || 0) + 1;
      return { response: "LLM_ANSWER:" + i.message };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "entry",
      nodes: [
        { id: "entry", data: { moduleId: "entry" } },
        { id: "core", data: { moduleId: "core" } },
      ],
      edges: [
        {
          source: "entry",
          sourceHandle: "message",
          target: "core",
          targetHandle: "message",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t2" } },
  );

  const r = await engine.start(undefined, { message: "bonjour" });
  assert.equal(r.content, "LLM_ANSWER:bonjour");
  assert.equal(h.calls.core, 1);

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 3. Reactive re-execution: start("widget", {selection}) after an initial
//    start() only re-runs the widget and its descendants; upstream is cached.
// -----------------------------------------------------------------------------
test("start(widgetId, values) only re-runs widget + descendants, upstream cached", async () => {
  const h = makeHarness({
    Fetch: `module.exports = async () => {
      __calls.Fetch = (__calls.Fetch || 0) + 1;
      return { events: [{ id: 1 }, { id: 2 }] };
    };`,
    Widget: `module.exports = async (i) => {
      __calls.Widget = (__calls.Widget || 0) + 1;
      return i;
    };`,
    Out: `module.exports = async (i) => {
      __calls.Out = (__calls.Out || 0) + 1;
      return { response: JSON.stringify(i) };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "Fetch",
      nodes: [
        { id: "Fetch", data: { moduleId: "Fetch" } },
        { id: "Widget", data: { moduleId: "Widget" } },
        { id: "Out", data: { moduleId: "Out" } },
      ],
      edges: [
        {
          source: "Fetch",
          sourceHandle: "events",
          target: "Widget",
          targetHandle: "events",
        },
        {
          source: "Widget",
          sourceHandle: "selection",
          target: "Out",
          targetHandle: "output-in",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t3" } },
  );

  await engine.start();
  assert.equal(h.calls.Fetch, 1);
  assert.equal(h.calls.Widget, 1);
  assert.equal(h.calls.Out, 1);

  const r = await engine.start("Widget", {
    selection: { date: "2026-04-09" },
  });
  assert.equal(h.calls.Fetch, 1, "Fetch must stay cached");
  assert.equal(h.calls.Widget, 2, "Widget re-runs with merged inputs");
  assert.equal(h.calls.Out, 2, "Out re-runs with new selection");

  const parsed = JSON.parse(r.content) as Record<string, unknown>;
  assert.deepEqual(parsed, { "output-in": { date: "2026-04-09" } });

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 4. Cost budget: expensive upstream connector called exactly once across
//    10 widget interactions.
// -----------------------------------------------------------------------------
test("upstream connector is called once across 10 widget starts", async () => {
  const h = makeHarness({
    Fetch: `module.exports = async () => {
      __calls.Fetch = (__calls.Fetch || 0) + 1;
      return { data: [1, 2, 3] };
    };`,
    Widget: `module.exports = async (i) => i;`,
    Display: `module.exports = async (i) => {
      __calls.Display = (__calls.Display || 0) + 1;
      return { response: "picked=" + (i.picked ?? "none") };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "Fetch",
      nodes: [
        { id: "Fetch", data: { moduleId: "Fetch" } },
        { id: "Widget", data: { moduleId: "Widget" } },
        { id: "Display", data: { moduleId: "Display" } },
      ],
      edges: [
        {
          source: "Fetch",
          sourceHandle: "data",
          target: "Widget",
          targetHandle: "data",
        },
        {
          source: "Widget",
          sourceHandle: "picked",
          target: "Display",
          targetHandle: "picked",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t4" } },
  );

  await engine.start();
  assert.equal(h.calls.Fetch, 1);

  for (let i = 1; i <= 10; i++) {
    const r = await engine.start("Widget", { picked: i });
    assert.equal(r.content, "picked=" + i);
  }

  assert.equal(h.calls.Fetch, 1, "Fetch called exactly once");
  assert.equal(h.calls.Display, 11, "Display ran 1 + 10 times");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 5. Port routing: A.x → B.y forwards only x under the target name y.
// -----------------------------------------------------------------------------
test("port routing: A.x → B.y forwards only x, under target name y", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ x: 1, noise: 2 });`,
    B: `module.exports = async (i) => ({ response: JSON.stringify(i) });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      edges: [
        { source: "A", sourceHandle: "x", target: "B", targetHandle: "y" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t5" } },
  );

  const r = await engine.start();
  const parsed = JSON.parse(r.content) as Record<string, unknown>;
  assert.deepEqual(parsed, { y: 1 });

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 6. Full calendar scenario: connector → widget → output with port routing
//    events → events and selection → output-in. After user click,
//    output.inputs === { "output-in": { date } }.
// -----------------------------------------------------------------------------
test("full calendar scenario: widget selection reaches output, events stay confined", async () => {
  const h = makeHarness({
    connector: `module.exports = async () => ({
      events: [{ id: 1 }, { id: 2 }],
    });`,
    widget: `module.exports = async (i) => i;`, // passthrough: events + selection
    outnode: `module.exports = async (i) => ({ response: JSON.stringify(i) });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "connector",
      nodes: [
        { id: "connector", data: { moduleId: "connector" } },
        { id: "widget", data: { moduleId: "widget" } },
        { id: "output", data: { moduleId: "outnode" } },
      ],
      edges: [
        {
          source: "connector",
          sourceHandle: "events",
          target: "widget",
          targetHandle: "events",
        },
        {
          source: "widget",
          sourceHandle: "selection",
          target: "output",
          targetHandle: "output-in",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t6" } },
  );

  await engine.start();

  const r = await engine.start("widget", {
    selection: { date: "2026-04-09", kind: "event" },
  });

  const parsed = JSON.parse(r.content) as Record<string, unknown>;
  assert.deepEqual(parsed, {
    "output-in": { date: "2026-04-09", kind: "event" },
  });
  assert.ok(!("events" in parsed), "events must not leak to output");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 7. Concurrency: parallel start() calls are serialized via the mutex so
//    lastOutputs never corrupts.
// -----------------------------------------------------------------------------
test("concurrent start() calls are serialized", async () => {
  const h = makeHarness({
    W: `module.exports = async (i) => i;`,
    Slow: `module.exports = async (i) => {
      __calls.Slow = (__calls.Slow || 0) + 1;
      await new Promise((r) => setTimeout(r, 40));
      return { response: "v=" + i.v };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "W",
      nodes: [
        { id: "W", data: { moduleId: "W" } },
        { id: "Slow", data: { moduleId: "Slow" } },
      ],
      edges: [
        { source: "W", sourceHandle: "v", target: "Slow", targetHandle: "v" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t7" } },
  );

  const [r1, r2] = await Promise.all([
    engine.start(undefined, { v: 1 }),
    engine.start("W", { v: 2 }),
  ]);

  assert.equal(r1.content, "v=1");
  assert.equal(r2.content, "v=2");
  assert.equal(h.calls.Slow, 2);
  const last = engine.getLastOutputs() as Record<
    string,
    { v?: number; response?: string }
  >;
  assert.equal(last.W.v, 2);
  assert.equal(last.Slow.response, "v=2");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 8. Unknown nodeId throws a clear error.
// -----------------------------------------------------------------------------
test("start(unknownNodeId) throws", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ x: 1 });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [{ id: "A", data: { moduleId: "A" } }],
      edges: [],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t8" } },
  );

  await assert.rejects(() => engine.start("Nope", { x: 2 }), /not found/);

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 9. Legacy edges without handles still work via full-output merge.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// 10. getState() — pure getter, no execution. Empty before first start().
// -----------------------------------------------------------------------------
test("getState() returns empty snapshot before first start, last state after", async () => {
  const h = makeHarness({
    A: `module.exports = async () => {
      __calls.A = (__calls.A || 0) + 1;
      return { response: "hello" };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [{ id: "A", data: { moduleId: "A" } }],
      edges: [],
    },
    { modulesDir: h.modulesDir, manifest: { name: "tstate" } },
  );

  // Before any start(): empty state, no execution.
  const empty = engine.getState();
  assert.equal(empty.content, "");
  assert.deepEqual(empty.messages, []);
  assert.deepEqual(empty.nodeOutputs, {});
  assert.equal(h.calls.A ?? 0, 0, "getState must not execute A");

  // After a start(): state is populated.
  await engine.start();
  assert.equal(h.calls.A, 1);

  const s = engine.getState();
  assert.equal(s.content, "hello");
  assert.deepEqual(s.nodeOutputs, { A: { response: "hello", __done: true } });

  // Calling getState() again must not re-execute.
  engine.getState();
  engine.getState();
  assert.equal(
    h.calls.A,
    1,
    "getState must not re-execute on subsequent calls",
  );

  h.cleanup();
});

test("legacy edges without handles fall back to full-output merge", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ a: 1, b: 2 });`,
    B: `module.exports = async (i) => ({ response: JSON.stringify(i) });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      edges: [{ source: "A", target: "B" }],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t9" } },
  );

  const r = await engine.start();
  const parsed = JSON.parse(r.content) as Record<string, unknown>;
  // `__done: true` est systematiquement ajoute par l'engine (system output).
  assert.deepEqual(parsed, { a: 1, b: 2, __done: true });

  h.cleanup();
});

// -----------------------------------------------------------------------------
// System handles: __go gate, __done/__log/__error outputs.
// -----------------------------------------------------------------------------

test("__go gate: skips node when go signal is falsy", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ value: "hello" });`,
    B: `module.exports = async (i) => { __calls.B = (__calls.B || 0) + 1; return { response: String(i.value || "") }; };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      // A.value → B.value (input normal) mais pas de __go → B tourne normalement
      edges: [
        {
          source: "A",
          target: "B",
          sourceHandle: "value",
          targetHandle: "value",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "sys1" } },
  );

  const r = await engine.start();
  assert.equal(r.content, "hello");
  assert.equal(h.calls.B, 1);
  h.cleanup();
});

test("__go gate: node skipped when __go is wired but source is absent", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ value: "hi" });`,
    B: `module.exports = async () => { __calls.B = (__calls.B || 0) + 1; return { response: "ran" }; };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      // A.value → B.value, et un __go cable depuis un "faux" source
      // (A.missing n'existe pas → B.__go = undefined → falsy → skip).
      edges: [
        {
          source: "A",
          target: "B",
          sourceHandle: "value",
          targetHandle: "value",
        },
        {
          source: "A",
          target: "B",
          sourceHandle: "missing",
          targetHandle: "__go",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "sys2" } },
  );

  await engine.start();
  // B skippe — pas d'exec, pas d'output cache.
  assert.equal(h.calls.B, undefined);
  assert.equal(engine.getState().nodeOutputs.B, undefined);
  h.cleanup();
});

test("__go gate: node-source runs when __go is the only input", async () => {
  // Reproduit le cas RSS Le Monde : B n'a aucun input data amont,
  // juste un __go câblé depuis A.__done. B doit s'exécuter.
  const h = makeHarness({
    A: `module.exports = async () => ({ value: "from-A" });`,
    B: `module.exports = async () => { __calls.B = (__calls.B || 0) + 1; return { response: "B-ran" }; };`,
  });
  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      edges: [
        {
          source: "A",
          target: "B",
          sourceHandle: "__done",
          targetHandle: "__go",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "sys6" } },
  );
  const r = await engine.start();
  assert.equal(h.calls.B, 1);
  assert.equal(r.content, "B-ran");
  h.cleanup();
});

test("__done is emitted and can drive another node's __go", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ value: "from-A" });`,
    B: `module.exports = async (i) => { __calls.B = (__calls.B || 0) + 1; return { response: "B:" + (i.value || "") }; };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
      ],
      edges: [
        {
          source: "A",
          target: "B",
          sourceHandle: "value",
          targetHandle: "value",
        },
        {
          source: "A",
          target: "B",
          sourceHandle: "__done",
          targetHandle: "__go",
        },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "sys3" } },
  );

  const r = await engine.start();
  assert.equal(h.calls.B, 1);
  assert.equal(r.content, "B:from-A");
  h.cleanup();
});

test("context.log() accumulates into __log output", async () => {
  const h = makeHarness({
    A: `module.exports = async (_i, _p, ctx) => { ctx.log("line1"); ctx.log("line2", { k: 1 }); return { response: "ok" }; };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [{ id: "A", data: { moduleId: "A" } }],
      edges: [],
    },
    { modulesDir: h.modulesDir, manifest: { name: "sys4" } },
  );

  const r = await engine.start();
  const out = r.nodeOutputs.A as Record<string, unknown>;
  assert.equal(out.__log, 'line1\nline2 {"k":1}');
  assert.equal(out.__done, true);
  h.cleanup();
});

test("__error mirrors out.error when module returns an error field", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ error: "boom" });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [{ id: "A", data: { moduleId: "A" } }],
      edges: [],
    },
    { modulesDir: h.modulesDir, manifest: { name: "sys5" } },
  );

  await engine.start();
  const out = engine.getState().nodeOutputs.A as Record<string, unknown>;
  assert.equal(out.__error, "boom");
  assert.equal(out.__done, true);
  h.cleanup();
});
