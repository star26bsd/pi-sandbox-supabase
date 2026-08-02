import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import supabaseTools from "../index.js";

let root: string;
let tools: Map<string, any>;
let commands: Map<string, any>;
let sentMessages: string[];

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-supabase-tools-extension-"));
  mkdirSync(join(root, ".pi"), { recursive: true });
  const script = join(root, "print-args.mjs");
  const descendantOutput = join(root, "descendant-secret-output");
  const descendantReady = join(root, "descendant-test-ready");
  const descendantCode =
    `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantOutput)}, process.env.TEST_KEY), 500);`;
  await writeFile(script, [
    'import { spawn } from "node:child_process";',
    'import { existsSync, writeFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'if (args[0] === "supabase-prefix" && args[1] === "status" && args[2] === "-o" && args[3] === "env") {',
    `  if (existsSync(${JSON.stringify(join(root, "nul-status-mode"))})) console.log('API_URL="prefix\\u0000TOPSECRETsuffix"');`,
    '  else console.log(\'API_URL="http://local.test"\');',
    '  console.log(\'ANON_KEY="profile-secret-key"\');',
    '} else {',
    `  if (existsSync(${JSON.stringify(join(root, "descendant-test-mode"))})) {`,
    `    spawn(process.execPath, ["-e", ${JSON.stringify(descendantCode)}], { stdio: "inherit", env: process.env });`,
    `    writeFileSync(${JSON.stringify(descendantReady)}, "ready");`,
    '    setInterval(() => {}, 1000);',
    `  } else if (existsSync(${JSON.stringify(join(root, "large-output-mode"))})) process.stdout.write("x".repeat(61 * 1024));`,
    '  else {',
    '    console.log(JSON.stringify(args));',
    '    if (process.env.TEST_URL) console.log(`${process.env.TEST_URL} ${process.env.TEST_KEY}`);',
    '  }',
    '}',
  ].join("\n"), "utf-8");
  await writeFile(join(root, ".pi", "supabase-tools.json"), JSON.stringify({
    commands: {
      supabaseCli: [process.execPath, script, "supabase-prefix"],
      denoTest: [process.execPath, script, "--allow-read=.", "deno-prefix"],
    },
    workingDirectory: ".",
    destructiveDbOps: "yes",
    blockedCommands: [{ prefix: ["db", "diff"], reason: "Use declarative sync" }],
    denoTestEnvironmentProfiles: {
      local: {
        source: "supabaseStatus",
        variables: { API_URL: "TEST_URL", ANON_KEY: "TEST_KEY" },
      },
    },
  }), "utf-8");

  tools = new Map();
  commands = new Map();
  sentMessages = [];
  const mockPi = {
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: any) {
      commands.set(name, command);
    },
    on() {},
    sendUserMessage(message: string) {
      sentMessages.push(message);
    },
  };
  await supabaseTools(mockPi as never);
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await access(path).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for fixture file: ${path}`);
}

function context() {
  return {
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      setStatus() {},
      notify() {},
      select: async () => undefined,
    },
  };
}

describe("registered tools", () => {
  test("registers the clean breaking tool names", () => {
    assert.deepEqual([...tools.keys()], ["supabase_cli", "deno_test"]);
    assert.equal(tools.has("supabase_bash"), false);
  });

  test("runs Supabase arguments after the configured prefix", async () => {
    const result = await tools.get("supabase_cli").execute(
      "call",
      { args: ["status"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(result.content[0].text, /supabase-prefix/);
    assert.match(result.content[0].text, /status/);
    assert.match(result.content[0].text, /--agent/);
    assert.equal(
      existsSync(join(root, ".pi", "supabase-tools-state.json")),
      false,
      "read-only commands should not create gate state",
    );
  });

  test("refuses configured blocked commands without spawning", async () => {
    const result = await tools.get("supabase_cli").execute(
      "call",
      { args: ["db", "diff", "--local"] },
      undefined,
      undefined,
      context(),
    );
    assert.equal(result.details.action, "blocked_by_configuration");
    assert.match(result.content[0].text, /Use declarative sync/);
  });

  test("allows configured Deno permissions but rejects session escalation", async () => {
    const allowed = await tools.get("deno_test").execute(
      "call",
      { args: ["functions/example/index.test.ts"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(allowed.content[0].text, /--allow-read=\./);
    assert.match(allowed.content[0].text, /functions\/example\/index\.test\.ts/);

    const refused = await tools.get("deno_test").execute(
      "call",
      { args: ["--allow-net", "functions/example/index.test.ts"] },
      undefined,
      undefined,
      context(),
    );
    assert.equal(refused.details.action, "deno_permission_blocked");
  });

  test("acquires a configured Deno environment profile and redacts repeated values", async () => {
    const updates: string[] = [];
    const result = await tools.get("deno_test").execute(
      "call",
      { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
      undefined,
      (update: any) => updates.push(update.content[0].text),
      context(),
    );
    assert.equal(updates.length, 0, "profile-backed tests must not stream output");
    assert.doesNotMatch(result.content[0].text, /http:\/\/local\.test|profile-secret-key/);
    assert.match(result.content[0].text, /\[REDACTED\] \[REDACTED\]/);

    await assert.rejects(
      tools.get("deno_test").execute(
        "call",
        { args: ["functions/example/index.test.ts"], environmentProfile: "unknown" },
        undefined,
        undefined,
        context(),
      ),
      /Unknown Deno test environment profile 'unknown'/,
    );
  });

  test("rejects acquired NUL values without exposing them through process launch", async () => {
    const marker = join(root, "nul-status-mode");
    await writeFile(marker, "enabled");
    try {
      await assert.rejects(
        tools.get("deno_test").execute(
          "call",
          { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
          undefined,
          undefined,
          context(),
        ),
        (error: Error) => !error.message.includes("TOPSECRET") && /malformed data/.test(error.message),
      );
    } finally {
      await rm(marker, { force: true });
    }
  });

  test("bounds retained output for profile-backed tests", async () => {
    const marker = join(root, "large-output-mode");
    await writeFile(marker, "enabled");
    try {
      const result = await tools.get("deno_test").execute(
        "call",
        { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
        undefined,
        undefined,
        context(),
      );
      assert.ok(Buffer.byteLength(result.content[0].text) <= 50 * 1024);
      assert.match(result.content[0].text, /^\[output truncated/);
      assert.equal(result.details.outputTruncated, true);
    } finally {
      await rm(marker, { force: true });
    }
  });

  test("aborting a profile-backed test terminates descendants with inherited values", async () => {
    const mode = join(root, "descendant-test-mode");
    const ready = join(root, "descendant-test-ready");
    const output = join(root, "descendant-secret-output");
    await writeFile(mode, "enabled");
    const controller = new AbortController();
    try {
      const execution = tools.get("deno_test").execute(
        "call",
        { args: ["functions/example/index.test.ts"], environmentProfile: "local" },
        controller.signal,
        undefined,
        context(),
      );
      await waitForFile(ready);
      const started = Date.now();
      controller.abort();
      await assert.rejects(execution, /Command aborted/);
      assert.ok(Date.now() - started < 700, "abort must settle after terminating the process tree");
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(existsSync(output), false, "descendant must not retain and write the injected value");
    } finally {
      await Promise.all([mode, ready, output].map((path) => rm(path, { force: true })));
    }
  });

  test("completes the destructive approval workflow", async () => {
    const command = commands.get("destructive-db");
    await command.handler("ask", context());

    const refusal = await tools.get("supabase_cli").execute(
      "call",
      { args: ["db", "reset", "--local"] },
      undefined,
      undefined,
      context(),
    );
    assert.equal(refusal.details.action, "approval_required");

    await command.handler(`approve ${refusal.details.requestId}`, context());
    assert.match(sentMessages.at(-1) ?? "", /rerunning the approved command/);

    const allowed = await tools.get("supabase_cli").execute(
      "call",
      { args: ["db", "reset", "--local"] },
      undefined,
      undefined,
      context(),
    );
    assert.match(allowed.content[0].text, /--yes/);
  });

  test("fails closed when trusted project configuration becomes malformed", async () => {
    const configPath = join(root, ".pi", "supabase-tools.json");
    const valid = await import("node:fs/promises").then(({ readFile }) => readFile(configPath, "utf-8"));
    await writeFile(configPath, "{ malformed", "utf-8");
    try {
      await assert.rejects(
        tools.get("supabase_cli").execute(
          "call",
          { args: ["status"] },
          undefined,
          undefined,
          context(),
        ),
        /Cannot parse/,
      );
    } finally {
      await writeFile(configPath, valid, "utf-8");
    }
  });
});
