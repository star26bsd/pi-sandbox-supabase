import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { mergeConfig } from "../config.js";
import {
  acquireDenoTestEnvironment,
  parseSupabaseStatusEnvironment,
} from "../environment-profile.js";

let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-supabase-tools-profile-"));
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

function configFor(script: string) {
  return mergeConfig({
    commands: { supabaseCli: [process.execPath, script] },
    denoTestEnvironmentProfiles: {
      local: {
        source: "supabaseStatus",
        variables: {
          API_URL: "SUPABASE_URL",
          ANON_KEY: "SUPABASE_ANON_KEY",
        },
      },
    },
  }, undefined);
}

describe("Supabase status environment parsing", () => {
  test("decodes assignments without shell evaluation", () => {
    const parsed = parseSupabaseStatusEnvironment([
      'API_URL="http://127.0.0.1:54321"',
      "ANON_KEY='literal-value'",
      "SHELL_TEXT=$(never-executed)",
    ].join("\n"));
    assert.equal(parsed.API_URL, "http://127.0.0.1:54321");
    assert.equal(parsed.ANON_KEY, "literal-value");
    assert.equal(parsed.SHELL_TEXT, "$(never-executed)");
  });

  test("rejects malformed and NUL-containing output without repeating it", () => {
    const secret = "do-not-repeat-this-value";
    for (const output of [
      `not an assignment ${secret}`,
      `API_URL=${JSON.stringify(`prefix\0${secret}suffix`)}`,
    ]) {
      assert.throws(
        () => parseSupabaseStatusEnvironment(output),
        (error: Error) => !error.message.includes(secret) && /malformed data/.test(error.message),
      );
    }
  });
});

describe("Deno test environment acquisition", () => {
  test("uses fixed status arguments and maps only configured variables", async () => {
    const script = join(directory, "status.mjs");
    await writeFile(script, [
      'if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["status", "-o", "env"])) process.exit(9);',
      'console.log(\'API_URL="http://local"\');',
      'console.log(\'ANON_KEY="secret-key"\');',
      'console.log(\'UNMAPPED="not-injected"\');',
    ].join("\n"));
    const acquired = await acquireDenoTestEnvironment(
      "local",
      configFor(script),
      directory,
      { INHERITED: "yes" },
    );
    assert.equal(acquired.environment.INHERITED, "yes");
    assert.equal(acquired.environment.SUPABASE_URL, "http://local");
    assert.equal(acquired.environment.SUPABASE_ANON_KEY, "secret-key");
    assert.equal(acquired.environment.UNMAPPED, undefined);
    assert.deepEqual(acquired.redactedValues, ["http://local", "secret-key"]);
  });

  test("does not expose status output when acquisition fails", async () => {
    const script = join(directory, "status-fail.mjs");
    const secret = "raw-status-secret";
    await writeFile(script, `console.error(${JSON.stringify(secret)}); process.exit(7);\n`);
    await assert.rejects(
      acquireDenoTestEnvironment("local", configFor(script), directory, {}),
      (error: Error) => !error.message.includes(secret) && /exit code 7/.test(error.message),
    );
  });

  test("fails safely for unknown profiles and missing sources", async () => {
    const script = join(directory, "status-missing.mjs");
    await writeFile(script, 'console.log(\'API_URL="http://local"\');\n');
    const config = configFor(script);
    await assert.rejects(
      acquireDenoTestEnvironment("unknown", config, directory, {}),
      /Unknown Deno test environment profile 'unknown'/,
    );
    await assert.rejects(
      acquireDenoTestEnvironment("local", config, directory, {}),
      /missing configured source variable\(s\): ANON_KEY/,
    );
  });

  test("applies blocked Supabase command policy before acquisition", async () => {
    const marker = join(directory, "blocked-status-ran");
    const script = join(directory, "blocked-status.mjs");
    await writeFile(script, [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(marker)}, "ran");`,
    ].join("\n"));
    const config = configFor(script);
    config.blockedCommands = [{ prefix: ["status"], reason: "Status disabled" }];
    await assert.rejects(
      acquireDenoTestEnvironment("local", config, directory, {}),
      /blocked by configuration: Status disabled/,
    );
    await assert.rejects(access(marker));
  });

  test("terminates the acquisition process tree when a descendant retains stdio", async () => {
    const script = join(directory, "status-process-tree.mjs");
    const ready = join(directory, "status-process-tree-ready");
    await writeFile(script, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { stdio: "inherit" });',
      `writeFileSync(${JSON.stringify(ready)}, "ready");`,
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const controller = new AbortController();
    const acquisition = acquireDenoTestEnvironment(
      "local", configFor(script), directory, {}, controller.signal,
    );
    await waitForFile(ready);
    const started = Date.now();
    controller.abort();
    await assert.rejects(acquisition, /acquisition aborted/);
    assert.ok(Date.now() - started < 700, "abort must terminate descendants retaining stdio");
  });

  test("uses a bounded fallback when an escaped descendant retains acquisition stdio", async () => {
    const script = join(directory, "status-descendant.mjs");
    const ready = join(directory, "status-descendant-ready");
    await writeFile(script, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], {',
      '  detached: true, stdio: "inherit",',
      '});',
      'descendant.unref();',
      `writeFileSync(${JSON.stringify(ready)}, "ready");`,
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const controller = new AbortController();
    const acquisition = acquireDenoTestEnvironment(
      "local", configFor(script), directory, {}, controller.signal,
    );
    await waitForFile(ready);
    const started = Date.now();
    controller.abort();
    await assert.rejects(acquisition, /acquisition aborted/);
    assert.ok(Date.now() - started < 1_500, "abort must have a bounded settlement fallback");
  });

  test("bounds private acquisition output", async () => {
    const script = join(directory, "status-overflow.mjs");
    await writeFile(script, 'process.stderr.write("x".repeat(70 * 1024));\n');
    await assert.rejects(
      acquireDenoTestEnvironment("local", configFor(script), directory, {}),
      /exceeded its output limit/,
    );
  });
});
