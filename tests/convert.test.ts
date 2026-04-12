// Tests for port type conversion (src/convert.ts).
// Run: node --test tests/convert.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { convert } from "../dist/convert.js";

// Identity
test("same type returns value as-is", () => {
  assert.equal(convert("hello", "text", "text"), "hello");
  assert.equal(convert(42, "number", "number"), 42);
  assert.deepEqual(convert([1], "array", "array"), [1]);
});

// Null/undefined
test("null/undefined → boolean returns false", () => {
  assert.equal(convert(null, "text", "boolean"), false);
  assert.equal(convert(undefined, "json", "boolean"), false);
});
test("null/undefined → number returns 0", () => {
  assert.equal(convert(null, "text", "number"), 0);
});
test("null/undefined → other returns null", () => {
  assert.equal(convert(null, "text", "json"), null);
  assert.equal(convert(undefined, "number", "text"), null);
});

// text → X
test("text → json parses valid JSON", () => {
  assert.deepEqual(convert('{"a":1}', "text", "json"), { a: 1 });
});
test("text → json wraps invalid JSON", () => {
  assert.deepEqual(convert("hello", "text", "json"), { text: "hello" });
});
test("text → array parses JSON array", () => {
  assert.deepEqual(convert("[1,2]", "text", "array"), [1, 2]);
});
test("text → array splits lines for non-JSON", () => {
  assert.deepEqual(convert("a\nb\n\nc", "text", "array"), ["a", "b", "c"]);
});
test("text → number parses float", () => {
  assert.equal(convert("3.14", "text", "number"), 3.14);
});
test("text → number returns 0 for NaN", () => {
  assert.equal(convert("abc", "text", "number"), 0);
});
test("text → boolean: non-empty string → true", () => {
  assert.equal(convert("hello", "text", "boolean"), true);
  assert.equal(convert("true", "text", "boolean"), true);
  assert.equal(convert("1", "text", "boolean"), true);
});

// json → X
test("json → text stringifies", () => {
  assert.equal(convert({ a: 1 }, "json", "text"), '{\n  "a": 1\n}');
});
test("json → array: array identity", () => {
  assert.deepEqual(convert([1, 2], "json", "array"), [1, 2]);
});
test("json → array: object → entries", () => {
  assert.deepEqual(convert({ a: 1 }, "json", "array"), [["a", 1]]);
});
test("json → number: number identity", () => {
  assert.equal(convert(42, "json", "number"), 42);
});
test("json → number: object → key count", () => {
  assert.equal(convert({ a: 1, b: 2 }, "json", "number"), 2);
});
test("json → boolean: truthy", () => {
  assert.equal(convert({}, "json", "boolean"), true);
  assert.equal(convert(0, "json", "boolean"), false);
});

// array → X
test("array → text joins with newlines", () => {
  assert.equal(convert(["a", "b"], "array", "text"), "a\nb");
});
test("array → number is length", () => {
  assert.equal(convert([1, 2, 3], "array", "number"), 3);
});
test("array → boolean: non-empty → true", () => {
  assert.equal(convert([1], "array", "boolean"), true);
  assert.equal(convert([], "array", "boolean"), false);
});

// number → X
test("number → text stringifies", () => {
  assert.equal(convert(42, "number", "text"), "42");
});
test("number → json wraps", () => {
  assert.deepEqual(convert(5, "number", "json"), { value: 5 });
});
test("number → array wraps", () => {
  assert.deepEqual(convert(5, "number", "array"), [5]);
});
test("number → boolean: 0 → false, 1 → true", () => {
  assert.equal(convert(0, "number", "boolean"), false);
  assert.equal(convert(1, "number", "boolean"), true);
});

// boolean → X
test("boolean → text", () => {
  assert.equal(convert(true, "boolean", "text"), "true");
  assert.equal(convert(false, "boolean", "text"), "false");
});
test("boolean → number", () => {
  assert.equal(convert(true, "boolean", "number"), 1);
  assert.equal(convert(false, "boolean", "number"), 0);
});

// any → X (type guessing)
test("any → text: string identity", () => {
  assert.equal(convert("hi", "any", "text"), "hi");
});
test("any → text: object stringifies", () => {
  assert.equal(convert({ a: 1 }, "any", "text"), '{\n  "a": 1\n}');
});
test("any → number from string", () => {
  assert.equal(convert("42", "any", "number"), 42);
});
test("any → boolean from number", () => {
  assert.equal(convert(0, "any", "boolean"), false);
  assert.equal(convert(1, "any", "boolean"), true);
});
test("any → array from array identity", () => {
  assert.deepEqual(convert([1, 2], "any", "array"), [1, 2]);
});

// X → any is identity
test("text → any is identity", () => {
  assert.equal(convert("hi", "text", "any"), "hi");
});
test("json → any is identity", () => {
  const obj = { a: 1 };
  assert.equal(convert(obj, "json", "any"), obj);
});

// context.convert integration (via workflow engine module execution)
test("convert is available on module context", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { WorkflowEngine } = await import("../dist/workflow-engine.js");

  const dir = mkdtempSync(join(tmpdir(), "conv-ctx-"));
  const modulesDir = join(dir, "modules", "checker");
  mkdirSync(modulesDir, { recursive: true });
  writeFileSync(
    join(modulesDir, "execute.js"),
    `module.exports = async function(inputs, params, context) {
      const result = context.convert("42", "text", "number");
      return { response: "converted=" + result + " type=" + typeof result };
    };`,
  );

  const engine = new WorkflowEngine(
    {
      entrypoint: "C",
      nodes: [{ id: "C", data: { moduleId: "checker" } }],
      edges: [],
    },
    { modulesDir: join(dir, "modules"), manifest: { name: "conv" } },
  );

  const r = await engine.start();
  assert.equal(r.content, "converted=42 type=number");
  rmSync(dir, { recursive: true, force: true });
});
