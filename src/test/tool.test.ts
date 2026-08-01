import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { buildSpawnCommand, describeCommand, runCommand } from "../tool.js";

let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-supabase-tools-runner-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("command construction", () => {
  test("appends literal arguments to a fixed prefix", () => {
    assert.deepEqual(
      buildSpawnCommand(["npx", "supabase"], ["db", "query", "select 1; rm -rf /"]),
      ["npx", ["supabase", "db", "query", "select 1; rm -rf /"]],
    );
  });

  test("supports a standalone binary prefix", () => {
    assert.deepEqual(
      buildSpawnCommand(["/opt/homebrew/bin/supabase"], ["status"]),
      ["/opt/homebrew/bin/supabase", ["status"]],
    );
  });

  test("rejects invalid inputs", () => {
    assert.throws(() => buildSpawnCommand([], []), /non-empty array/);
    assert.throws(() => buildSpawnCommand(["deno", "test"], "bad" as never), /args/);
  });

  test("describes commands without changing execution arguments", () => {
    assert.equal(
      describeCommand(["deno", "test"], ["--filter", "creates a row"]),
      "deno test --filter \"creates a row\"",
    );
  });
});

describe("direct process execution", () => {
  test("uses configured prefix, cwd, environment, and streams output", async () => {
    const script = join(directory, "inspect.mjs");
    await writeFile(script, [
      "console.log(process.cwd());",
      "console.log(process.env.TEST_VALUE);",
      "console.log(JSON.stringify(process.argv.slice(2)));",
    ].join("\n"), "utf-8");
    const updates: string[] = [];

    const result = await runCommand({
      prefix: [process.execPath, script, "prefix-value"],
      args: ["literal value", "; rm -rf /"],
      cwd: directory,
      environment: { ...process.env, TEST_VALUE: "configured" },
      timeout: 5,
    }, {
      signal: undefined,
      onUpdate: (update) => updates.push(update.content[0].text),
    });

    assert.match(result.content[0].text, new RegExp(directory));
    assert.match(result.content[0].text, /configured/);
    assert.match(result.content[0].text, /\["prefix-value","literal value","; rm -rf \/"\]/);
    assert.ok(updates.length > 0);
    assert.equal(result.details?.exitCode, 0);
  });

  test("rejects with output when a command exits unsuccessfully", async () => {
    const script = join(directory, "fail.mjs");
    await writeFile(script, "console.error('failure detail'); process.exit(7);\n", "utf-8");
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, script],
        args: [],
        cwd: directory,
        environment: process.env,
        timeout: 5,
      }, { signal: undefined }),
      /exit code 7[\s\S]*failure detail/,
    );
  });

  test("terminates commands after the configured timeout", async () => {
    const script = join(directory, "wait.mjs");
    await writeFile(script, "setInterval(() => {}, 1000);\n", "utf-8");
    await assert.rejects(
      runCommand({
        prefix: [process.execPath, script],
        args: [],
        cwd: directory,
        environment: process.env,
        timeout: 0.02,
      }, { signal: undefined }),
      /timed out/,
    );
  });
});
