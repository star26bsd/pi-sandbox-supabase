import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  findBlockedCommand,
  findDenoPermissionArgument,
  isDenoPermissionArgument,
} from "../command-policy.js";

const rules = [
  { prefix: ["db", "diff"], reason: "Use PG-Delta" },
  { prefix: ["stop"], reason: "Keep the stack running" },
];

describe("blocked Supabase commands", () => {
  test("matches configured sequences with surrounding flags", () => {
    assert.equal(findBlockedCommand(["db", "diff", "--local"], rules)?.reason, "Use PG-Delta");
    assert.equal(findBlockedCommand(["--debug", "db", "diff"], rules)?.reason, "Use PG-Delta");
    assert.equal(findBlockedCommand(["stop", "--no-backup"], rules)?.reason, "Keep the stack running");
  });

  test("does not block unrelated commands", () => {
    assert.equal(findBlockedCommand(["db", "lint"], rules), undefined);
    assert.equal(findBlockedCommand(["db", "schema", "diff"], rules), undefined);
  });
});

describe("Deno permission arguments", () => {
  test("recognizes long and short permission flags", () => {
    for (const argument of [
      "--allow-all",
      "--allow-read=.",
      "--allow-run",
      "--allow-scripts=npm:esbuild",
      "-A",
      "-R",
      "-R=.",
      "-WN",
      "-qN=localhost",
    ]) {
      assert.equal(isDenoPermissionArgument(argument), true, argument);
    }
  });

  test("permits test selection and non-permission flags", () => {
    for (const argument of ["functions/foo/index.test.ts", "--filter", "creates row", "--no-check", "-q"]) {
      assert.equal(isDenoPermissionArgument(argument), false, argument);
    }
  });

  test("returns the first attempted permission escalation", () => {
    assert.equal(
      findDenoPermissionArgument(["--filter", "smoke", "--allow-net=localhost"]),
      "--allow-net=localhost",
    );
  });
});
