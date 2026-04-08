// Tests for WorkflowEngine reactive trigger mode.
// Run with: npx tsx --test tests/workflow-engine.test.ts
// (or compile first with `npx tsc` then: node --test dist-tests/... — here we
// use the already-built dist/workflow-engine.js directly for speed.)

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../dist/workflow-engine.js";

// -----------------------------------------------------------------------------
// Test harness: build a temp modules dir with execute.js files that track
// their own call counts via a shared global.
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
  for (const [id, source] of Object.entries(modules)) {
    const modDir = join(modulesDir, id);
    mkdirSync(modDir, { recursive: true });
    writeFileSync(join(modDir, "execute.js"), source);
  }
  // Counter storage lives on globalThis so sandboxed modules can increment it.
  const key = `__wfe_calls_${Date.now()}_${Math.random()}`;
  (globalThis as Record<string, unknown>)[key] = {};
  const calls = (globalThis as Record<string, unknown>)[key] as Record<
    string,
    number
  >;
  // Inject the counter key into every module by prefixing the source.
  for (const [id, source] of Object.entries(modules)) {
    const modDir = join(modulesDir, id);
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
// 1. Base test: A -> B -> C, trigger from B, C re-runs with new input, A not.
// -----------------------------------------------------------------------------
test("triggerFromNode re-executes only descendants", async () => {
  const h = makeHarness({
    A: `module.exports = async (i, p, c) => {
      __calls.A = (__calls.A || 0) + 1;
      return { out: "A-out" };
    };`,
    B: `module.exports = async (i, p, c) => {
      __calls.B = (__calls.B || 0) + 1;
      return { out: (i.out || "") + "-B" };
    };`,
    C: `module.exports = async (i, p, c) => {
      __calls.C = (__calls.C || 0) + 1;
      return { response: "C saw:" + (i.out || "") };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
        { id: "C", data: { moduleId: "C" } },
      ],
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t1" } },
  );

  await engine.run("hello");
  assert.equal(h.calls.A, 1);
  assert.equal(h.calls.B, 1);
  assert.equal(h.calls.C, 1);

  // Trigger: B emits a new output. Only C should re-run.
  const r = await engine.triggerFromNode("B", { out: "NEW" });
  assert.equal(h.calls.A, 1, "A must not re-run");
  assert.equal(h.calls.B, 1, "B must not re-run");
  assert.equal(h.calls.C, 2, "C must re-run once");
  assert.equal(r.content, "C saw:NEW");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 2. Upstream cache: X -> C, B -> C, trigger from B, C sees cached X.
// -----------------------------------------------------------------------------
test("triggerFromNode merges cached inputs from out-of-subgraph predecessors", async () => {
  const h = makeHarness({
    A: `module.exports = async () => {
      __calls.A = (__calls.A || 0) + 1;
      return { fromB: "A-original" };
    };`,
    B: `module.exports = async (i) => {
      __calls.B = (__calls.B || 0) + 1;
      return { fromB: i.fromB };
    };`,
    X: `module.exports = async () => {
      __calls.X = (__calls.X || 0) + 1;
      return { fromX: "X-value" };
    };`,
    C: `module.exports = async (i) => {
      __calls.C = (__calls.C || 0) + 1;
      return { response: "B=" + i.fromB + " X=" + i.fromX };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
        { id: "X", data: { moduleId: "X" } },
        { id: "C", data: { moduleId: "C" } },
      ],
      edges: [
        { source: "A", target: "B" },
        { source: "B", target: "C" },
        { source: "X", target: "C" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t2" } },
  );

  const r1 = await engine.run("hi");
  assert.equal(r1.content, "B=A-original X=X-value");
  assert.equal(h.calls.X, 1);

  const r2 = await engine.triggerFromNode("B", { fromB: "NEW" });
  assert.equal(h.calls.A, 1, "A not re-run");
  assert.equal(h.calls.X, 1, "X not re-run");
  assert.equal(h.calls.C, 2, "C re-run with merged inputs");
  assert.equal(r2.content, "B=NEW X=X-value");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 3. Widget sink: trigger with no descendants still updates lastOutputs.
// -----------------------------------------------------------------------------
test("triggerFromNode with no descendants updates cache and emits workflow_complete", async () => {
  const h = makeHarness({
    A: `module.exports = async () => {
      __calls.A = (__calls.A || 0) + 1;
      return { value: "root" };
    };`,
    W: `module.exports = async (i) => {
      __calls.W = (__calls.W || 0) + 1;
      return { selection: null };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "W", data: { moduleId: "W" } },
      ],
      edges: [{ source: "A", target: "W" }],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t3" } },
  );

  await engine.run("go");
  assert.equal(h.calls.W, 1);

  const events: string[] = [];
  const r = await engine.triggerFromNode(
    "W",
    { selection: { date: "2026-04-09" } },
    { onEvent: (e) => events.push(e.type) },
  );
  assert.equal(h.calls.W, 1, "W (the widget itself) must not be re-executed");
  assert.ok(events.includes("workflow_complete"));
  assert.deepEqual(
    (r.nodeOutputs as Record<string, { selection: unknown }>).W.selection,
    { date: "2026-04-09" },
  );

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 4. triggerFromNode before any run() must throw.
// -----------------------------------------------------------------------------
test("triggerFromNode without prior run() throws", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ x: 1 });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [{ id: "A", data: { moduleId: "A" } }],
      edges: [],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t4" } },
  );

  await assert.rejects(
    () => engine.triggerFromNode("A", { x: 2 }),
    /no previous run/,
  );

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 5. Chaining: two successive triggerFromNode reuse the merged state.
// -----------------------------------------------------------------------------
test("successive triggerFromNode preserve state between calls", async () => {
  const h = makeHarness({
    W: `module.exports = async () => ({ value: 0 });`,
    // C reads inputs.value and returns { response }
    C: `module.exports = async (i) => ({ response: "value=" + i.value });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "W",
      nodes: [
        { id: "W", data: { moduleId: "W" } },
        { id: "C", data: { moduleId: "C" } },
      ],
      edges: [{ source: "W", target: "C" }],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t5" } },
  );

  const r0 = await engine.run("init");
  assert.equal(r0.content, "value=0");

  const r1 = await engine.triggerFromNode("W", { value: 10 });
  assert.equal(r1.content, "value=10");

  const r2 = await engine.triggerFromNode("W", { value: 42 });
  assert.equal(r2.content, "value=42");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 6. Diamond: A -> B -> D, A -> C -> D. Trigger from B, D re-runs with new B
//    and cached C output. C must not re-run.
// -----------------------------------------------------------------------------
test("diamond graph: trigger from one branch, other branch stays cached", async () => {
  const h = makeHarness({
    A: `module.exports = async () => {
      __calls.A = (__calls.A || 0) + 1;
      return { seed: "s" };
    };`,
    B: `module.exports = async (i) => {
      __calls.B = (__calls.B || 0) + 1;
      return { b: "B:" + i.seed };
    };`,
    C: `module.exports = async (i) => {
      __calls.C = (__calls.C || 0) + 1;
      return { c: "C:" + i.seed };
    };`,
    D: `module.exports = async (i) => {
      __calls.D = (__calls.D || 0) + 1;
      return { response: (i.b || "?") + "+" + (i.c || "?") };
    };`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
        { id: "C", data: { moduleId: "C" } },
        { id: "D", data: { moduleId: "D" } },
      ],
      edges: [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t6" } },
  );

  const r1 = await engine.run("go");
  assert.equal(r1.content, "B:s+C:s");
  assert.equal(h.calls.A, 1);
  assert.equal(h.calls.B, 1);
  assert.equal(h.calls.C, 1);
  assert.equal(h.calls.D, 1);

  const r2 = await engine.triggerFromNode("B", { b: "B-NEW" });
  assert.equal(r2.content, "B-NEW+C:s");
  assert.equal(h.calls.A, 1, "A not re-run");
  assert.equal(h.calls.B, 1, "B not re-run");
  assert.equal(h.calls.C, 1, "C not re-run (out of subgraph)");
  assert.equal(h.calls.D, 2, "D re-run with merged inputs");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 7. Expensive upstream: 10 triggers, upstream counter stays at 1.
// -----------------------------------------------------------------------------
// -----------------------------------------------------------------------------
// 8. Concurrent triggers must be serialized (mutex). Two triggers launched
//    without await complete in order and lastOutputs reflects the last one.
// -----------------------------------------------------------------------------
test("concurrent triggerFromNode calls are serialized", async () => {
  const h = makeHarness({
    W: `module.exports = async () => ({ v: 0 });`,
    // Slow downstream: introduces a delay so the two triggers overlap if
    // the mutex is broken.
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
      edges: [{ source: "W", target: "Slow" }],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t8" } },
  );

  await engine.run("init");

  // Fire both triggers without awaiting between them.
  const p1 = engine.triggerFromNode("W", { v: 1 });
  const p2 = engine.triggerFromNode("W", { v: 2 });
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.equal(r1.content, "v=1");
  assert.equal(r2.content, "v=2");
  assert.equal(h.calls.Slow, 3, "Slow ran 3 times: 1 initial + 2 triggers");

  // Final state reflects the second trigger.
  const last = engine.getLastOutputs() as Record<
    string,
    { v?: number; response?: string }
  >;
  assert.equal(last.W.v, 2);
  assert.equal(last.Slow.response, "v=2");

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 9. Merge preserves existing keys. Widget has initial output {events: [...]},
//    trigger with {selection: {...}}, final lastOutputs[W] has both.
// -----------------------------------------------------------------------------
test("triggerFromNode merge preserves pre-existing widget output keys", async () => {
  const h = makeHarness({
    Fetch: `module.exports = async () => ({ events: [{id: 1}, {id: 2}] });`,
    // Widget is passthrough: it receives events and re-emits them.
    Widget: `module.exports = async (i) => ({ events: i.events });`,
    // Downstream reads both events AND selection from widget output.
    D: `module.exports = async (i) => ({
      response: "evts=" + (i.events ? i.events.length : 0) + " sel=" + JSON.stringify(i.selection || null),
    });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "Fetch",
      nodes: [
        { id: "Fetch", data: { moduleId: "Fetch" } },
        { id: "Widget", data: { moduleId: "Widget" } },
        { id: "D", data: { moduleId: "D" } },
      ],
      edges: [
        { source: "Fetch", target: "Widget" },
        { source: "Widget", target: "D" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t9" } },
  );

  const r0 = await engine.run("init");
  assert.equal(r0.content, "evts=2 sel=null");

  const r = await engine.triggerFromNode("Widget", {
    selection: { date: "2026-04-09" },
  });

  // D should see BOTH keys — events from the initial passthrough + selection
  // from the trigger merge.
  assert.equal(r.content, 'evts=2 sel={"date":"2026-04-09"}');

  const last = engine.getLastOutputs() as Record<
    string,
    { events?: unknown[]; selection?: unknown }
  >;
  assert.ok(Array.isArray(last.Widget.events));
  assert.equal((last.Widget.events as unknown[]).length, 2);
  assert.deepEqual(last.Widget.selection, { date: "2026-04-09" });

  h.cleanup();
});

// -----------------------------------------------------------------------------
// 10. Events are scoped to the subgraph: no node_start for the source widget
//     or for out-of-subgraph nodes.
// -----------------------------------------------------------------------------
test("triggerFromNode emits events only for re-executed descendants", async () => {
  const h = makeHarness({
    A: `module.exports = async () => ({ seed: "s" });`,
    B: `module.exports = async (i) => ({ b: i.seed });`,
    C: `module.exports = async (i) => ({ c: i.seed });`,
    D: `module.exports = async (i) => ({ response: (i.b || "?") + "+" + (i.c || "?") });`,
  });

  const engine = new WorkflowEngine(
    {
      entrypoint: "A",
      nodes: [
        { id: "A", data: { moduleId: "A" } },
        { id: "B", data: { moduleId: "B" } },
        { id: "C", data: { moduleId: "C" } },
        { id: "D", data: { moduleId: "D" } },
      ],
      edges: [
        { source: "A", target: "B" },
        { source: "A", target: "C" },
        { source: "B", target: "D" },
        { source: "C", target: "D" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t10" } },
  );

  await engine.run("go");

  const starts: string[] = [];
  const completes: string[] = [];
  await engine.triggerFromNode(
    "B",
    { b: "NEW" },
    {
      onEvent: (e) => {
        if (e.type === "node_start") starts.push(e.nodeId);
        if (e.type === "node_complete") completes.push(e.nodeId);
      },
    },
  );

  // Only D is a descendant of B and re-executed. B is the source (not
  // re-executed), A and C are out of the subgraph.
  assert.deepEqual(starts, ["D"]);
  assert.deepEqual(completes, ["D"]);

  h.cleanup();
});

test("upstream module is called exactly once across 10 widget triggers", async () => {
  const h = makeHarness({
    Fetch: `module.exports = async () => {
      __calls.Fetch = (__calls.Fetch || 0) + 1;
      return { data: [1, 2, 3] };
    };`,
    Widget: `module.exports = async (i) => {
      __calls.Widget = (__calls.Widget || 0) + 1;
      return { picked: 0 };
    };`,
    Display: `module.exports = async (i) => {
      __calls.Display = (__calls.Display || 0) + 1;
      return { response: "picked=" + i.picked };
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
        { source: "Fetch", target: "Widget" },
        { source: "Widget", target: "Display" },
      ],
    },
    { modulesDir: h.modulesDir, manifest: { name: "t7" } },
  );

  await engine.run("init");
  assert.equal(h.calls.Fetch, 1);

  for (let i = 1; i <= 10; i++) {
    const r = await engine.triggerFromNode("Widget", { picked: i });
    assert.equal(r.content, "picked=" + i);
  }

  assert.equal(h.calls.Fetch, 1, "upstream Fetch called only once");
  assert.equal(
    h.calls.Widget,
    1,
    "Widget never re-executed (it is the trigger)",
  );
  assert.equal(
    h.calls.Display,
    11,
    "Display re-runs on every trigger (1 initial + 10)",
  );

  h.cleanup();
});
