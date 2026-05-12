/**
 * Tests for tool.ts — spawn argument construction and command description.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildSpawnArgs, describeCommand } from "../tool.js";
import type { ResolvedOptions } from "../types.js";

const defaults: ResolvedOptions = {
  supabaseDir: "supabase/",
  stateFile: ".pi/supabase-bash-state.json",
  defaultTimeout: 120,
  npxBin: "npx",
  supabaseCmd: "supabase",
  customDestructivePatterns: [],
};

describe("buildSpawnArgs", () => {
  test("returns npx binary with supabase prefix + user args", () => {
    const [binary, spawnArgs] = buildSpawnArgs(["status"], defaults);
    assert.equal(binary, "npx");
    assert.deepEqual(spawnArgs, ["supabase", "status"]);
  });

  test("passes empty args (shows help)", () => {
    const [binary, spawnArgs] = buildSpawnArgs([], defaults);
    assert.equal(binary, "npx");
    assert.deepEqual(spawnArgs, ["supabase"]);
  });

  test("preserves spaces as literal argument values", () => {
    const [, spawnArgs] = buildSpawnArgs(["--name", "my migration"], defaults);
    assert.ok(
      spawnArgs.includes("my migration"),
      "space-containing arg preserved literally",
    );
  });

  test("shell metacharacters remain literal values (no shell parsing)", () => {
    const [, spawnArgs] = buildSpawnArgs(["foo; rm -rf /"], defaults);
    assert.ok(
      spawnArgs.includes("foo; rm -rf /"),
      "metacharacters pass as literal arg, not shell-separated",
    );
  });

  test("npx + supabase prefix are hardcoded — input cannot change them", () => {
    const [binary, spawnArgs] = buildSpawnArgs(["--help"], defaults);
    assert.equal(binary, "npx");
    assert.equal(spawnArgs[0], "supabase");
    assert.ok(!spawnArgs[0].includes("npx"), "prefix is not derived from input");
  });

  test("uses configured npxBin and supabaseCmd", () => {
    const custom: ResolvedOptions = {
      ...defaults,
      npxBin: "pnpm",
      supabaseCmd: "supabase-beta",
    };
    const [binary, spawnArgs] = buildSpawnArgs(["status"], custom);
    assert.equal(binary, "pnpm");
    assert.deepEqual(spawnArgs, ["supabase-beta", "status"]);
  });
});

describe("describeCommand", () => {
  test("produces readable command string", () => {
    assert.equal(
      describeCommand(["db", "reset", "--local"], defaults),
      "npx supabase db reset --local",
    );
  });

  test("empty args produces minimal command", () => {
    assert.equal(describeCommand([], defaults), "npx supabase ");
  });

  test("uses configured npxBin and supabaseCmd", () => {
    const custom: ResolvedOptions = {
      ...defaults,
      npxBin: "pnpm",
      supabaseCmd: "supabase-beta",
    };
    assert.equal(
      describeCommand(["status"], custom),
      "pnpm supabase-beta status",
    );
  });
});

describe("input validation", () => {
  test("non-array args throws TypeError", () => {
    assert.throws(
      () => buildSpawnArgs("not-array" as unknown as string[], defaults),
      TypeError,
    );
  });
});
