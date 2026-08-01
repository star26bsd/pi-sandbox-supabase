import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  canonicalizeArgsForApproval,
  checkDestructive,
  defaultState,
  ensureState,
  formatModeIndicator,
  isDestructive,
  readState,
  withAutomationFlags,
  writeState,
} from "../destructive-gate.js";
import type { ApprovalRecord, PendingRequest } from "../types.js";

let root: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-supabase-tools-gate-"));
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("destructive command detection", () => {
  test("recognizes built-in destructive commands", () => {
    assert.equal(isDestructive(["db", "reset", "--local"]), true);
    assert.equal(isDestructive(["--debug", "db", "reset", "--local"]), true);
    assert.equal(isDestructive(["stop"]), true);
    assert.equal(isDestructive(["--debug", "stop"]), true);
    assert.equal(
      isDestructive(["db", "schema", "declarative", "sync", "--apply"]),
      true,
    );
  });

  test("does not classify read-only commands", () => {
    assert.equal(isDestructive(["status"]), false);
    assert.equal(isDestructive(["db", "schema", "declarative", "sync"]), false);
    assert.equal(isDestructive([]), false);
  });

  test("canonicalizes automation flags", () => {
    assert.deepEqual(
      canonicalizeArgsForApproval([
        "db", "reset", "--local", "--agent", "yes", "--yes", "--debug",
      ]),
      ["db", "reset", "--local", "--debug"],
    );
    assert.deepEqual(canonicalizeArgsForApproval(["status", "--agent=yes"]), ["status"]);
  });

  test("adds automation flags without duplicating explicit flags", () => {
    assert.deepEqual(withAutomationFlags(["status"]), ["status", "--agent", "yes"]);
    assert.deepEqual(
      withAutomationFlags(["db", "reset", "--local"]),
      ["db", "reset", "--local", "--agent", "yes", "--yes"],
    );
    assert.deepEqual(
      withAutomationFlags(["db", "reset", "--agent=no", "--yes"]),
      ["db", "reset", "--agent=no", "--yes"],
    );
  });
});

describe("state persistence", () => {
  test("initializes a missing state file with configured mode", () => {
    const path = join(root, "initial", ".pi", "state.json");
    const state = ensureState(path, "no");
    assert.equal(state.mode, "no");
    assert.equal(existsSync(path), true);
  });

  test("preserves an existing runtime mode", () => {
    const path = join(root, "preserved", ".pi", "state.json");
    writeState(defaultState("yes"), path);
    assert.equal(ensureState(path, "no").mode, "yes");
  });

  test("uses safe defaults for malformed state", () => {
    const path = join(root, "malformed", ".pi", "state.json");
    mkdirSync(join(root, "malformed", ".pi"), { recursive: true });
    writeFileSync(path, "{ bad json", "utf-8");
    assert.deepEqual(readState(path), defaultState());
  });

  test("drops incomplete request and approval records", () => {
    const path = join(root, "partial", ".pi", "state.json");
    mkdirSync(join(root, "partial", ".pi"), { recursive: true });
    writeFileSync(path, JSON.stringify({
      mode: "ask",
      pendingRequests: [
        { id: "partial", args: ["db", "reset"] },
        {
          id: "complete",
          command: "db reset",
          args: ["db", "reset"],
          createdTstamp: "2025-01-01T00:00:00.000Z",
          parentQuestion: "Approve?",
        },
      ],
      approvals: [{ id: "partial" }],
    }), "utf-8");
    const state = readState(path);
    assert.deepEqual(state.pendingRequests.map((request) => request.id), ["complete"]);
    assert.deepEqual(state.approvals, []);
  });
});

describe("destructive gate", () => {
  const path = () => join(root, "gate", ".pi", "state.json");
  const options = () => ({
    statePath: path(),
    commandPrefix: ["npx", "supabase"],
  });

  function setup(
    mode: "ask" | "yes" | "no",
    pendingRequests: PendingRequest[] = [],
    approvals: ApprovalRecord[] = [],
  ) {
    writeState({ mode, pendingRequests, approvals }, path());
  }

  test("blocks destructive commands in no mode", () => {
    setup("no");
    const result = checkDestructive(["db", "reset"], options());
    assert.equal(result?.details?.action, "blocked");
  });

  test("creates and reuses a canonical approval request in ask mode", () => {
    setup("ask");
    const first = checkDestructive(
      ["db", "reset", "--local", "--agent", "yes", "--yes"],
      options(),
    );
    const second = checkDestructive(["db", "reset", "--local"], options());
    assert.equal(first?.details?.requestId, second?.details?.requestId);
    const state = readState(path());
    assert.equal(state.pendingRequests.length, 1);
    assert.deepEqual(state.pendingRequests[0].args, ["db", "reset", "--local"]);
    assert.match(state.pendingRequests[0].parentQuestion, /npx supabase db reset --local/);
  });

  test("consumes approval and removes its pending request", () => {
    const pending: PendingRequest = {
      id: "approved",
      command: "npx supabase db reset",
      args: ["db", "reset"],
      createdTstamp: "2025-01-01T00:00:00.000Z",
      parentQuestion: "Approve?",
    };
    setup("ask", [pending], [{
      id: "approved",
      command: pending.command,
      args: pending.args,
      approvedTstamp: "2025-01-01T00:01:00.000Z",
    }]);

    assert.equal(checkDestructive(["db", "reset"], options()), undefined);
    assert.deepEqual(readState(path()).pendingRequests, []);
    assert.deepEqual(readState(path()).approvals, []);
  });

  test("does not apply an approval after the configured command prefix changes", () => {
    const pending: PendingRequest = {
      id: "old-prefix",
      command: "trusted-wrapper supabase db reset --local",
      args: ["db", "reset", "--local"],
      createdTstamp: "2025-01-01T00:00:00.000Z",
      parentQuestion: "Approve?",
    };
    setup("ask", [pending], [{
      id: "old-prefix",
      command: pending.command,
      args: pending.args,
      approvedTstamp: "2025-01-01T00:01:00.000Z",
    }]);

    const result = checkDestructive(["db", "reset", "--local"], {
      statePath: path(),
      commandPrefix: ["different-executable"],
    });
    assert.equal(result?.details?.action, "approval_required");
    assert.notEqual(result?.details?.requestId, "old-prefix");

    const state = readState(path());
    assert.equal(state.approvals.length, 1, "old-prefix approval remains unused");
    assert.equal(state.pendingRequests.length, 2, "new prefix gets a separate request");
  });

  test("allows destructive commands in yes mode and non-destructive commands in all modes", () => {
    setup("yes");
    assert.equal(checkDestructive(["stop"], options()), undefined);
    for (const mode of ["ask", "yes", "no"] as const) {
      setup(mode);
      assert.equal(checkDestructive(["status"], options()), undefined);
    }
  });
});

describe("status formatting", () => {
  test("includes pending count only in ask mode", () => {
    assert.equal(formatModeIndicator("ask", 2), "DB: ask (2 pending)");
    assert.equal(formatModeIndicator("ask", 0), "DB: ask");
    assert.equal(formatModeIndicator("yes", 2), "DB: yes");
  });
});
