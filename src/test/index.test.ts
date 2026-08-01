import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)));\n", "utf-8");
  await writeFile(join(root, ".pi", "supabase-tools.json"), JSON.stringify({
    commands: {
      supabaseCli: [process.execPath, script, "supabase-prefix"],
      denoTest: [process.execPath, script, "--allow-read=.", "deno-prefix"],
    },
    workingDirectory: ".",
    destructiveDbOps: "yes",
    blockedCommands: [{ prefix: ["db", "diff"], reason: "Use declarative sync" }],
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
