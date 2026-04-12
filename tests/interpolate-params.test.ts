// Tests for buildNamedInputs + interpolateParams
// Run: node --test tests/interpolate-params.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  buildNamedInputs,
  interpolateParams,
  type WorkflowNode,
} from "../dist/workflow-engine.js";

const makeNode = (
  ports: Array<{ id: string; label: string }>,
): WorkflowNode => ({
  id: "n1",
  data: {
    ports: { inputs: ports },
  },
});

test("buildNamedInputs exposes values by label alongside id", () => {
  const node = makeNode([{ id: "input-abc", label: "news" }]);
  const inputs = { "input-abc": ["a", "b"] };
  const view = buildNamedInputs(node, inputs);
  assert.deepEqual(view["news"], ["a", "b"]);
  assert.deepEqual(view["input-abc"], ["a", "b"]);
});

test("buildNamedInputs does not overwrite existing keys (id wins on collision)", () => {
  const node = makeNode([{ id: "news", label: "news" }]);
  const inputs = { news: "hello" };
  const view = buildNamedInputs(node, inputs);
  assert.equal(view["news"], "hello");
});

test("buildNamedInputs ignores ports with empty label", () => {
  const node = makeNode([{ id: "input-1", label: "" }]);
  const inputs = { "input-1": 42 };
  const view = buildNamedInputs(node, inputs);
  assert.equal(view["input-1"], 42);
  assert.equal(Object.keys(view).length, 1);
});

test("interpolateParams replaces {{name}} in a simple string", () => {
  const out = interpolateParams(
    { system_prompt: "Hello {{user}}!" },
    { user: "Olivier" },
  );
  assert.equal(out.system_prompt, "Hello Olivier!");
});

test("interpolateParams stringifies object values as pretty JSON", () => {
  const out = interpolateParams(
    { system_prompt: "News: {{news}}" },
    { news: [{ title: "A" }, { title: "B" }] },
  );
  const expected = `News: ${JSON.stringify([{ title: "A" }, { title: "B" }], null, 2)}`;
  assert.equal(out.system_prompt, expected);
});

test("interpolateParams replaces missing keys with empty string", () => {
  const out = interpolateParams(
    { system_prompt: "Before[{{missing}}]After" },
    {},
  );
  assert.equal(out.system_prompt, "Before[]After");
});

test("interpolateParams is identity when no placeholder is present", () => {
  const input = { system_prompt: "static prompt", temperature: 0.7 };
  const out = interpolateParams(input, { news: "x" });
  assert.equal(out.system_prompt, "static prompt");
  assert.equal(out.temperature, 0.7);
});

test("interpolateParams recurses into nested objects and arrays", () => {
  const out = interpolateParams(
    {
      nested: {
        prompt: "{{name}}",
        list: ["{{name}}", "plain"],
      },
    },
    { name: "Zoe" },
  );
  assert.deepEqual(out.nested, { prompt: "Zoe", list: ["Zoe", "plain"] });
});

test("interpolateParams leaves non-string leaves untouched", () => {
  const out = interpolateParams({ n: 3, b: true, s: "{{x}}" }, { x: "ok" });
  assert.equal(out.n, 3);
  assert.equal(out.b, true);
  assert.equal(out.s, "ok");
});

test("interpolateParams handles labels with spaces", () => {
  const out = interpolateParams(
    { p: "A={{latest news}}" },
    { "latest news": "foo" },
  );
  assert.equal(out.p, "A=foo");
});

test("interpolateParams whitespace inside braces is tolerated", () => {
  const out = interpolateParams({ p: "{{  news  }}" }, { news: "hi" });
  assert.equal(out.p, "hi");
});

// ---------------------------------------------------------------------------
// End-to-end: a workflow that relies on a port default `value` should run
// the downstream module with that value injected as an input, without any
// explicit source node wired to the port.
// ---------------------------------------------------------------------------

import { test as ptest } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../dist/workflow-engine.js";

ptest(
  "engine seeds input port `value` defaults when no edge supplies them",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "wfe-portval-"));
    const modulesDir = join(dir, "modules");
    mkdirSync(join(modulesDir, "echo"), { recursive: true });
    // Module reads inputs.url and echoes it on `response`
    writeFileSync(
      join(modulesDir, "echo", "execute.js"),
      `async function execute(inputs) { return { response: inputs.url || 'MISSING' }; }\nmodule.exports = execute;\n`,
    );
    const wf = {
      entrypoint: "n1",
      nodes: [
        {
          id: "n1",
          data: {
            moduleId: "echo",
            ports: {
              inputs: [
                {
                  id: "url",
                  label: "URL",
                  type: "text",
                  value: "https://example.com/feed.rss",
                },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    const engine = new WorkflowEngine(wf as never, {
      modulesDir,
      manifest: { name: "t" } as never,
    });
    const result = await engine.start();
    assert.equal(result.content, "https://example.com/feed.rss");
    rmSync(dir, { recursive: true, force: true });
  },
);
