/**
 * Obsolete-command gate for the supabase_bash tool.
 *
 * Blocks deprecated `npx supabase` subcommands before spawn, returning
 * a refusal result with a deprecation message. No file-backed state —
 * obsolete commands are always blocked regardless of mode.
 */

import type { AgentToolResult } from "./types.js";

/* ── Obsolete pattern detection ────────────────────────────────── */

/**
 * Check if the given args array matches a known obsolete/deprecated command.
 * Built-in patterns:
 *   - `db diff` (replaced by pg-delta)
 */
export function isObsolete(args: string[]): boolean {
  if (!args || args.length === 0) return false;

  // Check for "db diff"
  if (args[0] === "db" && args[1] === "diff") return true;

  return false;
}

/**
 * Return a refusal result for obsolete commands, or undefined if the command
 * is not obsolete (allowed to proceed to the next gate).
 */
export function checkObsolete(args: string[]): AgentToolResult | undefined {
  if (!isObsolete(args)) return undefined;

  return {
    content: [
      {
        type: "text",
        text: "db diff obsolete, use pg-delta instead.\n",
      },
    ],
    details: {
      obsolete: true,
      action: "obsolete",
      command: args.join(" "),
    },
    isError: true,
  };
}
