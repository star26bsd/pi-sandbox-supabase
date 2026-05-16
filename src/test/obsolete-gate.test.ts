/**
 * Tests for obsolete-gate.ts — pattern detection and refusal behavior.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isObsolete, checkObsolete } from "../obsolete-gate.js";

/* ── isObsolete ─────────────────────────────────────────────────── */

describe("isObsolete", () => {
  test("db diff is obsolete", () => {
    assert.ok(isObsolete(["db", "diff"]));
    assert.ok(isObsolete(["db", "diff", "--schema", "public"]));
    assert.ok(isObsolete(["db", "diff", "--use-migrate"]));
  });

  test("non-diff commands are NOT obsolete", () => {
    assert.ok(!isObsolete(["db", "status"]));
    assert.ok(!isObsolete(["db", "reset"]));
    assert.ok(!isObsolete(["status"]));
    assert.ok(!isObsolete(["--help"]));
    assert.ok(!isObsolete([]));
  });
});

/* ── checkObsolete ──────────────────────────────────────────────── */

describe("checkObsolete", () => {
  test("returns refusal for db diff", () => {
    const result = checkObsolete(["db", "diff"]);
    assert.ok(result, "should return a refusal");
    assert.equal(result?.isError, true);
    assert.equal(result?.details?.obsolete, true);
    assert.equal(result?.details?.action, "obsolete");
    assert.ok(
      result?.content?.[0]?.text?.includes("db diff obsolete, use pg-delta instead."),
      "should contain deprecation message",
    );
  });

  test("returns refusal for db diff with extra flags", () => {
    const result = checkObsolete(["db", "diff", "--schema", "public"]);
    assert.ok(result, "should return a refusal");
    assert.ok(result?.content?.[0]?.text?.includes("db diff obsolete"));
  });

  test("returns undefined for non-obsolete commands", () => {
    assert.equal(checkObsolete(["status"]), undefined);
    assert.equal(checkObsolete([]), undefined);
    assert.equal(checkObsolete(["db", "reset"]), undefined);
  });
});
