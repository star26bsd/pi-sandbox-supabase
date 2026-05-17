/**
 * Tests for destructive-gate.ts — pattern detection, state management,
 * mode enforcement, and status formatting.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PendingRequest, ApprovalRecord, ResolvedOptions } from "../types.js";
import {
  canonicalizeArgsForApproval,
  withAutomationFlags,
  isDestructive,
  checkDestructive,
  readState,
  writeState,
  defaultState,
  readConfigMode,
  formatModeIndicator,
  generateId,
} from "../destructive-gate.js";

const defaults: ResolvedOptions = {
  supabaseDir: "/tmp/supabase-bash-test-dir-" + Date.now(),
  stateFile: ".pi/supabase-bash-state.json",
  defaultTimeout: 120,
  npxBin: "npx",
  supabaseCmd: "supabase",
  customDestructivePatterns: [],
};

after(() => {
  // Clean up test directories
  try { rmSync(join(defaults.supabaseDir, ".pi"), { recursive: true, force: true }); } catch {}
});

/* ── isDestructive ──────────────────────────────────────────────── */

describe("isDestructive", () => {
  test("db reset is destructive", () => {
    assert.ok(isDestructive(["db", "reset"], []));
    assert.ok(isDestructive(["db", "reset", "--local"], []));
  });

  test("stop is destructive", () => {
    assert.ok(isDestructive(["stop"], []));
  });

  test("declarative sync --apply is destructive", () => {
    assert.ok(isDestructive(["db", "schema", "declarative", "sync", "--apply"], []));
    assert.ok(isDestructive(["db", "schema", "declarative", "--apply", "sync"], []));
  });

  test("declarative sync without --apply is NOT destructive", () => {
    assert.ok(!isDestructive(["db", "schema", "declarative", "sync"], []));
  });

  test("status is NOT destructive", () => {
    assert.ok(!isDestructive(["status"], []));
  });

  test("--help is NOT destructive", () => {
    assert.ok(!isDestructive(["--help"], []));
  });

  test("--version is NOT destructive", () => {
    assert.ok(!isDestructive(["--version"], []));
  });

  test("empty args is NOT destructive", () => {
    assert.ok(!isDestructive([], []));
  });

  test("custom destructive patterns are checked against canonical args", () => {
    const custom = [(args: string[]) => args.includes("--force")];
    assert.ok(isDestructive(["migrate", "--force", "--agent", "yes", "--yes"], custom));
    assert.ok(!isDestructive(["migrate"], custom));
  });

  test("automation flags do not change destructive detection", () => {
    assert.ok(isDestructive(["db", "reset", "--local", "--agent", "yes", "--yes"], []));
    assert.ok(!isDestructive(["status", "--agent", "yes"], []));
  });
});

/* ── automation flags / approval canonicalization ───────────────── */

describe("automation flags and approval canonicalization", () => {
  test("canonicalizeArgsForApproval removes --yes and --agent forms", () => {
    assert.deepEqual(
      canonicalizeArgsForApproval(["db", "reset", "--local", "--yes", "--agent", "yes", "--debug"]),
      ["db", "reset", "--local", "--debug"],
    );
    assert.deepEqual(
      canonicalizeArgsForApproval(["status", "--agent=yes"]),
      ["status"],
    );
  });

  test("withAutomationFlags adds --agent yes to all commands", () => {
    assert.deepEqual(withAutomationFlags(["status"], []), ["status", "--agent", "yes"]);
  });

  test("withAutomationFlags adds --yes only for destructive commands", () => {
    assert.deepEqual(
      withAutomationFlags(["db", "reset", "--local"], []),
      ["db", "reset", "--local", "--agent", "yes", "--yes"],
    );
    assert.deepEqual(
      withAutomationFlags(["db", "schema", "declarative", "sync"], []),
      ["db", "schema", "declarative", "sync", "--agent", "yes"],
    );
  });

  test("withAutomationFlags preserves explicit automation flags", () => {
    assert.deepEqual(
      withAutomationFlags(["db", "reset", "--local", "--agent", "no", "--yes"], []),
      ["db", "reset", "--local", "--agent", "no", "--yes"],
    );
  });
});

/* ── generateId ─────────────────────────────────────────────────── */

describe("generateId", () => {
  test("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateId());
    }
    assert.equal(ids.size, 100, "all IDs should be unique");
  });
});

/* ── readState / writeState ─────────────────────────────────────── */

describe("readState / writeState", () => {
  const tmpDir = "/tmp/supabase-bash-test-state-" + Date.now();

  after(() => {
    try { rmSync(join(tmpDir, ".pi"), { recursive: true, force: true }); } catch {}
  });

  test("defaults to ask mode for missing file", () => {
    const statePath = join(tmpDir, ".pi/supabase-bash-state.json");
    const state = readState(statePath);
    assert.equal(state.mode, "ask");
    assert.deepEqual(state.pendingRequests, []);
    assert.deepEqual(state.approvals, []);
  });

  test("defaults to ask mode for malformed JSON", () => {
    const dir = join(tmpDir, "malformed-state");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(statePath, "{ bad json", "utf-8");
    const state = readState(statePath);
    assert.equal(state.mode, "ask");
    assert.deepEqual(state.pendingRequests, []);
  });

  test("reads valid state file", () => {
    const dir = join(tmpDir, "valid-state");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    writeState({ mode: "yes", pendingRequests: [], approvals: [] }, statePath);
    const state = readState(statePath);
    assert.equal(state.mode, "yes");
  });

  test("defaults mode to ask for invalid mode value", () => {
    const dir = join(tmpDir, "bad-mode");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ mode: "invalid", pendingRequests: [], approvals: [] }), "utf-8");
    const state = readState(statePath);
    assert.equal(state.mode, "ask");
  });

  test("writeState creates directory if needed", () => {
    const dir = join(tmpDir, "new-dir");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    writeState(defaultState(), statePath);
    assert.ok(existsSync(statePath));
  });

  test("writeState persists all fields", () => {
    const dir = join(tmpDir, "persist");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    const testState = {
      mode: "no" as const,
      pendingRequests: [{
        id: "abc123",
        command: "db reset",
        args: ["db", "reset"],
        createdTstamp: "2025-01-01T00:00:00.000Z",
        parentQuestion: "Approve?",
      }],
      approvals: [{
        id: "def456",
        command: "stop",
        args: ["stop"],
        approvedTstamp: "2025-01-01T00:00:00.000Z",
      }],
    };
    writeState(testState, statePath);
    const state = readState(statePath);
    assert.equal(state.mode, "no");
    assert.equal(state.pendingRequests.length, 1);
    assert.equal(state.pendingRequests[0].id, "abc123");
    assert.equal(state.approvals.length, 1);
    assert.equal(state.approvals[0].id, "def456");
  });

  test("drops pending requests missing required fields", () => {
    const dir = join(tmpDir, "partial-pending");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        mode: "ask",
        pendingRequests: [
          { id: "a", args: ["db", "reset"] },
          {
            id: "b",
            command: "db reset",
            args: ["db", "reset"],
            createdTstamp: "2025-01-01T00:00:00.000Z",
            parentQuestion: "Approve?",
          },
        ],
        approvals: [],
      }),
      "utf-8",
    );
    const state = readState(statePath);
    assert.equal(state.pendingRequests.length, 1, "only complete request accepted");
    assert.equal(state.pendingRequests[0].id, "b");
  });

  test("drops approvals missing required fields", () => {
    const dir = join(tmpDir, "partial-approvals");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        mode: "ask",
        pendingRequests: [],
        approvals: [
          { id: "a", args: ["db", "reset"] },
          {
            id: "b",
            command: "db reset",
            args: ["db", "reset"],
            approvedTstamp: "2025-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf-8",
    );
    const state = readState(statePath);
    assert.equal(state.approvals.length, 1, "only complete approval accepted");
    assert.equal(state.approvals[0].id, "b");
  });

  test("partial approval cannot match destructive command in ask mode", () => {
    const dir = join(tmpDir, "partial-approval-check");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        mode: "ask",
        pendingRequests: [],
        approvals: [{ id: "partial", args: ["db", "reset"] }],
      }),
      "utf-8",
    );
    const opts = { ...defaults, supabaseDir: dir };
    const result = checkDestructive(["db", "reset"], opts, dir);
    assert.ok(result, "partial approval should not match");
    assert.equal(result?.details?.action, "approval_required");
  });

  test("numeric mode value defaults to ask", () => {
    const dir = join(tmpDir, "numeric-mode");
    const statePath = join(dir, ".pi/supabase-bash-state.json");
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ mode: 123, pendingRequests: [], approvals: [] }),
      "utf-8",
    );
    const state = readState(statePath);
    assert.equal(state.mode, "ask");
  });
});

/* ── readConfigMode ─────────────────────────────────────────────── */

describe("readConfigMode", () => {
  const dir = "/tmp/supabase-test-config-gate-" + Date.now();

  after(() => {
    try { rmSync(join(dir, ".pi"), { recursive: true, force: true }); } catch {}
  });

  test("defaults to ask for missing sandbox.json", () => {
    const mode = readConfigMode(dir);
    assert.equal(mode, "ask");
  });

  test("reads 'yes' from sandbox.json", () => {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "sandbox.json"), JSON.stringify({ destructiveDbOps: "yes" }), "utf-8");
    const mode = readConfigMode(dir);
    assert.equal(mode, "yes");
  });

  test("reads 'no' from sandbox.json", () => {
    writeFileSync(join(dir, ".pi", "sandbox.json"), JSON.stringify({ destructiveDbOps: "no" }), "utf-8");
    const mode = readConfigMode(dir);
    assert.equal(mode, "no");
  });
});

/* ── formatModeIndicator ────────────────────────────────────────── */

describe("formatModeIndicator", () => {
  test("returns 'DB: ask' for ask mode", () => {
    assert.equal(formatModeIndicator("ask"), "DB: ask");
  });

  test("returns 'DB: yes' for yes mode", () => {
    assert.equal(formatModeIndicator("yes"), "DB: yes");
  });

  test("returns 'DB: no' for no mode", () => {
    assert.equal(formatModeIndicator("no"), "DB: no");
  });

  test("includes pending count in ask mode", () => {
    assert.equal(formatModeIndicator("ask", 3), "DB: ask (3 pending)");
  });

  test("omits pending count when zero", () => {
    assert.equal(formatModeIndicator("ask", 0), "DB: ask");
  });

  test("all modes produce distinct indicators", () => {
    const indicators = new Set([
      formatModeIndicator("ask"),
      formatModeIndicator("yes"),
      formatModeIndicator("no"),
    ]);
    assert.equal(indicators.size, 3, "all three modes should have distinct indicators");
  });
});

/* ── checkDestructive — file-backed mode enforcement ────────────── */

describe("checkDestructive — file-backed mode enforcement", () => {
  const testDir = "/tmp/supabase-bash-test-check-" + Date.now();
  const statePath = join(testDir, ".pi/supabase-bash-state.json");

  function setupState(
    mode: "ask" | "yes" | "no",
    pendingRequests: PendingRequest[] = [],
    approvals: ApprovalRecord[] = [],
  ) {
    writeState({ mode, pendingRequests, approvals }, statePath);
  }

  const opts = { ...defaults, supabaseDir: testDir };

  after(() => {
    try { rmSync(join(testDir, ".pi"), { recursive: true, force: true }); } catch {}
  });

  test("no mode: blocks destructive unconditionally", () => {
    setupState("no");
    const result = checkDestructive(["db", "reset"], opts, testDir);
    assert.ok(result, "should return a refusal");
    assert.equal(result?.isError, true);
    assert.equal((result?.details as any)?.action, "blocked");
  });

  test("no mode: blocks stop", () => {
    setupState("no");
    const result = checkDestructive(["stop"], opts, testDir);
    assert.ok(result);
    assert.equal((result?.details as any)?.action, "blocked");
  });

  test("ask mode: blocks without approval", () => {
    setupState("ask");
    const result = checkDestructive(["db", "reset"], opts, testDir);
    assert.ok(result, "should return a refusal");
    assert.equal(result?.isError, true);
    const details = result?.details as any;
    assert.equal(details?.action, "approval_required");
    assert.ok(typeof details?.requestId === "string" && details.requestId.length > 0, "should have requestId");
    assert.ok(typeof details?.parentQuestion === "string" && details.parentQuestion.length > 0, "should have parentQuestion");
  });

  test("ask mode: creates pending request in state file", () => {
    setupState("ask");
    checkDestructive(["db", "reset"], opts, testDir);
    const state = readState(statePath);
    assert.equal(state.pendingRequests.length, 1);
    assert.deepEqual(state.pendingRequests[0].args, ["db", "reset"]);
  });

  test("ask mode: stores canonical request args without automation flags", () => {
    setupState("ask");
    checkDestructive(["db", "reset", "--local", "--agent", "yes", "--yes"], opts, testDir);
    const state = readState(statePath);
    assert.equal(state.pendingRequests.length, 1);
    assert.deepEqual(state.pendingRequests[0].args, ["db", "reset", "--local"]);
  });

  test("ask mode: reuses existing pending request (same args)", () => {
    setupState("ask");
    const result1 = checkDestructive(["db", "reset"], opts, testDir);
    const details1 = result1?.details as any;
    const result2 = checkDestructive(["db", "reset"], opts, testDir);
    const details2 = result2?.details as any;
    assert.equal(details1?.requestId, details2?.requestId);
    const state = readState(statePath);
    assert.equal(state.pendingRequests.length, 1);
  });

  test("ask mode: reuses existing pending request across automation flag variants", () => {
    setupState("ask");
    const result1 = checkDestructive(["db", "reset", "--local"], opts, testDir);
    const details1 = result1?.details as any;
    const result2 = checkDestructive(["db", "reset", "--local", "--yes", "--agent", "yes"], opts, testDir);
    const details2 = result2?.details as any;
    assert.equal(details1?.requestId, details2?.requestId);
    const state = readState(statePath);
    assert.equal(state.pendingRequests.length, 1);
  });

  test("ask mode: approval consumed and command proceeds", () => {
    setupState("ask", [], [{
      id: "test-approval",
      command: "db reset",
      args: ["db", "reset"],
      approvedTstamp: "2025-01-01T00:00:00.000Z",
    }]);
    const result = checkDestructive(["db", "reset"], opts, testDir);
    assert.ok(!result, "should allow with matching approval");
    const state = readState(statePath);
    assert.equal(state.approvals.length, 0, "approval should be consumed");
  });

  test("ask mode: approval consumed even without prior pending request", () => {
    setupState("ask", [], [{
      id: "test-approval2",
      command: "stop",
      args: ["stop"],
      approvedTstamp: "2025-01-01T00:00:00.000Z",
    }]);
    const result = checkDestructive(["stop"], opts, testDir);
    assert.ok(!result, "should allow with approval even without prior request");
  });

  test("ask mode: canonical approval matches command with automation flags", () => {
    setupState("ask", [], [{
      id: "test-approval-canonical",
      command: "db reset --local",
      args: ["db", "reset", "--local"],
      approvedTstamp: "2025-01-01T00:00:00.000Z",
    }]);
    const result = checkDestructive(["db", "reset", "--local", "--yes", "--agent", "yes"], opts, testDir);
    assert.ok(!result, "should allow with matching canonical approval");
  });

  test("yes mode: allows destructive immediately", () => {
    setupState("yes");
    const result = checkDestructive(["db", "reset"], opts, testDir);
    assert.ok(!result, "should allow without approval in yes mode");
  });

  test("yes mode: allows stop", () => {
    setupState("yes");
    const result = checkDestructive(["stop"], opts, testDir);
    assert.ok(!result);
  });

  test("non-destructive commands are never blocked in any mode", () => {
    for (const mode of ["no", "ask", "yes"] as const) {
      setupState(mode);
      assert.ok(!checkDestructive(["status"], opts, testDir), `${mode}: status should pass`);
      assert.ok(!checkDestructive(["--help"], opts, testDir), `${mode}: --help should pass`);
      assert.ok(!checkDestructive(["--version"], opts, testDir), `${mode}: --version should pass`);
      assert.ok(!checkDestructive([], opts, testDir), `${mode}: empty should pass`);
      assert.ok(!checkDestructive(["db", "schema", "declarative", "sync"], opts, testDir), `${mode}: sync without --apply should pass`);
    }
  });

  test("declarative sync --apply is detected as destructive in ask mode", () => {
    setupState("ask");
    const result = checkDestructive(["db", "schema", "declarative", "sync", "--apply"], opts, testDir);
    assert.ok(result);
    assert.equal((result?.details as any)?.action, "approval_required");
  });

  test("declarative sync --apply is allowed in yes mode", () => {
    setupState("yes");
    const result = checkDestructive(["db", "schema", "declarative", "sync", "--apply"], opts, testDir);
    assert.ok(!result, "yes mode should allow --apply");
  });

  test("ask mode with matching approval for --apply", () => {
    setupState("ask", [], [{
      id: "test-approval-apply",
      command: "db schema declarative sync --apply",
      args: ["db", "schema", "declarative", "sync", "--apply"],
      approvedTstamp: "2025-01-01T00:00:00.000Z",
    }]);
    const result = checkDestructive(["db", "schema", "declarative", "sync", "--apply"], opts, testDir);
    assert.ok(!result, "should allow with matching approval");
  });
});
