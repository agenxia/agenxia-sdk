// Verify that importing server.ts auto-loads .env from the cwd.
// Run: node --test tests/dotenv-loading.test.ts

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("createAgentServer reads PORT from .env in the agent cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotenv-test-"));

  // Create a .env with a custom PORT
  writeFileSync(join(dir, ".env"), "PORT=12345\nTEST_SDK_VAR=hello_from_env\n");

  // Create a minimal script that imports createAgentServer's module
  // (which triggers dotenv/config) and prints the env vars.
  writeFileSync(
    join(dir, "probe.mjs"),
    `
    // Change cwd to where .env lives, then import the server module
    // (which does import "dotenv/config" at the top level).
    process.chdir(${JSON.stringify(dir)});
    await import(${JSON.stringify("file://" + join(process.cwd(), "dist/server.js"))});
    // After the import, dotenv should have loaded .env from cwd
    console.log("PORT=" + process.env.PORT);
    console.log("TEST_SDK_VAR=" + process.env.TEST_SDK_VAR);
    process.exit(0);
    `,
  );

  // Save and clear the vars so dotenv can set them
  const savedPort = process.env.PORT;
  const savedVar = process.env.TEST_SDK_VAR;

  try {
    const result = spawnSync("node", [join(dir, "probe.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PORT: undefined,
        TEST_SDK_VAR: undefined,
      } as NodeJS.ProcessEnv,
    });

    const stdout = result.stdout ?? "";
    assert.ok(
      stdout.includes("PORT=12345"),
      `Expected PORT=12345 in output, got: ${stdout.slice(0, 200)}`,
    );
    assert.ok(
      stdout.includes("TEST_SDK_VAR=hello_from_env"),
      `Expected TEST_SDK_VAR=hello_from_env in output, got: ${stdout.slice(0, 200)}`,
    );
  } finally {
    // Restore env
    if (savedPort !== undefined) process.env.PORT = savedPort;
    else delete process.env.PORT;
    if (savedVar !== undefined) process.env.TEST_SDK_VAR = savedVar;
    else delete process.env.TEST_SDK_VAR;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dotenv does not overwrite pre-existing env vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "dotenv-test2-"));

  writeFileSync(join(dir, ".env"), "PORT=99999\n");
  writeFileSync(
    join(dir, "probe.mjs"),
    `
    process.chdir(${JSON.stringify(dir)});
    await import(${JSON.stringify("file://" + join(process.cwd(), "dist/server.js"))});
    console.log("PORT=" + process.env.PORT);
    process.exit(0);
    `,
  );

  try {
    const result = spawnSync("node", [join(dir, "probe.mjs")], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        PORT: "7777", // pre-existing — dotenv must not overwrite
      },
    });

    const stdout = result.stdout ?? "";
    assert.ok(
      stdout.includes("PORT=7777"),
      `Expected PORT=7777 (pre-existing), got: ${stdout.slice(0, 200)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
