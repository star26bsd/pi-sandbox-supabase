/**
 * pi-sandbox-supabase — unsandboxed `npx supabase` CLI extension for pi.
 *
 * Registers:
 *   - `supabase_bash` tool: spawns `npx supabase` commands outside the sandbox
 *   - `/destructive-db` slash command: manage destructive-operation modes and approvals
 *
 * Key features:
 *   - Injection-safe: uses child_process.spawn with shell: false
 *   - File-backed destructive-operations gate with ask/yes/no modes
 *   - Status bar indicator showing current DB mode
 *   - Configurable: supabase directory, state file path, timeout, patterns
 *
 * Installation:
 *   Place this directory in your project's `.pi/extensions/supabase-bash/`
 *   and add the supabase subagent config to `.pi/agents/supabase.md`.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  StateFile,
  ApprovalRecord,
  SupabaseBashOptions,
  ResolvedOptions,
  ExtensionContext,
  PiUI,
} from "./types.js";
import {
  readState,
  writeState,
  readConfigMode,
  formatModeIndicator,
  updateStatusBar,
  checkDestructive,
  defaultState,
} from "./destructive-gate.js";
import { runSupabaseBash } from "./tool.js";

/* ── TypeBox lazy import ────────────────────────────────────────── */

let TypeboxType: typeof import("typebox").Type | undefined;
async function getType() {
  if (!TypeboxType) TypeboxType = (await import("typebox")).Type;
  return TypeboxType;
}

/* ── Defaults ───────────────────────────────────────────────────── */

const DEFAULTS: ResolvedOptions = {
  supabaseDir: "supabase/",
  stateFile: ".pi/supabase-bash-state.json",
  defaultTimeout: 120,
  npxBin: "npx",
  supabaseCmd: "supabase",
  customDestructivePatterns: [],
};

/* ── Option resolution ──────────────────────────────────────────── */

function resolveOptions(userOptions?: SupabaseBashOptions): ResolvedOptions {
  return { ...DEFAULTS, ...userOptions };
}

/* ── Extension bootstrap ────────────────────────────────────────── */

export default async function (pi: ExtensionAPI, userOptions?: SupabaseBashOptions) {
  const T = await getType();
  const options = resolveOptions(userOptions);

  /* ── Tool: supabase_bash ─────────────────────────────────────── */

  pi.registerTool({
    name: "supabase_bash",
    label: "Supabase CLI",
    description:
      "Run an `npx supabase` command unsandboxed. Accepts { args: string[] } and optional timeout in seconds.",
    parameters: T.Object({
      args: T.Array(T.String()),
      timeout: T.Optional(T.Number()),
    }),
    async execute(
      _id: string,
      params: { args: string[]; timeout?: number },
      signal: AbortSignal | undefined,
      onUpdate: (chunk: string) => void,
      ctx: unknown,
    ) {
      if (!params.args) {
        return {
          content: [{ type: "text", text: "Error: 'args' array is required\n" }],
          isError: true,
        };
      }

      // Check destructive ops before spawn — no process created for blocked commands
      const projectRoot = typeof ctx === "object" && ctx !== null && "cwd" in ctx
        ? (ctx as { cwd: string }).cwd
        : process.cwd();
      const refusal = checkDestructive(params.args, options, projectRoot);
      if (refusal) return refusal;

      return await runSupabaseBash(
        { args: params.args, timeout: params.timeout },
        { signal, onUpdate },
        options,
      );
    },
  });

  /* ── Slash command: /destructive-db ─────────────────────────── */

  pi.registerCommand("destructive-db", {
    description:
      "Manage destructive database operation mode (yes/no/ask), approvals, and status",
    handler: async (rawArgs: string, ctx: { ui: PiUI; cwd: string }) => {
      const statePath = join(ctx.cwd, options.stateFile);
      const args = rawArgs.trim().split(/\s+/).filter(Boolean);
      const subcmd = args[0];

      if (!subcmd || subcmd === "mode") {
        const state = readState(statePath);
        const choice = await ctx.ui.select(
          "Destructive DB Mode",
          ["ask", "yes", "no"],
        );
        if (!choice) return;
        const mode: "no" | "ask" | "yes" = choice;
        const newState: StateFile = { ...state, mode };
        writeState(newState, statePath);
        updateStatusBar(newState, ctx.ui);
        return;
      }

      if (subcmd === "yes" || subcmd === "no" || subcmd === "ask") {
        const mode: "no" | "ask" | "yes" = subcmd;
        const state = readState(statePath);
        const newState: StateFile = { ...state, mode };
        writeState(newState, statePath);
        updateStatusBar(newState, ctx.ui);
        return;
      }

      if (subcmd === "status") {
        const state = readState(statePath);
        const lines: string[] = [];
        lines.push(`Mode: ${state.mode}`);
        lines.push(`Pending requests: ${state.pendingRequests.length}`);
        for (const req of state.pendingRequests) {
          lines.push(`  - [${req.id}] ${req.command}`);
        }
        lines.push(`Approvals: ${state.approvals.length}`);
        for (const app of state.approvals) {
          lines.push(`  - [${app.id}] ${app.command}`);
        }
        updateStatusBar(state, ctx.ui);
        ctx.ui.notify("Destructive DB Status: " + lines.join("\n"));
        return;
      }

      if (subcmd === "approve") {
        const state = readState(statePath);
        const requestId = args[1];

        if (requestId) {
          const req = state.pendingRequests.find((r) => r.id === requestId);
          if (!req) {
            ctx.ui.notify(`Error: No pending request with ID '${requestId}'`, "error");
            return;
          }
          const approval: ApprovalRecord = {
            id: req.id,
            command: req.command,
            args: req.args,
            approvedTstamp: new Date().toISOString(),
          };
          const newState: StateFile = {
            ...state,
            pendingRequests: state.pendingRequests.filter((r) => r.id !== requestId),
            approvals: [...state.approvals, approval],
          };
          writeState(newState, statePath);
          updateStatusBar(newState, ctx.ui);
          ctx.ui.notify(`Approved: ${req.command}`, "info");
          return;
        }

        if (state.pendingRequests.length === 0) {
          ctx.ui.notify("No pending requests to approve", "info");
          return;
        }
        const req = state.pendingRequests[0];
        const approval: ApprovalRecord = {
          id: req.id,
          command: req.command,
          args: req.args,
          approvedTstamp: new Date().toISOString(),
        };
        const newState: StateFile = {
          ...state,
          pendingRequests: state.pendingRequests.filter((r) => r.id !== req.id),
          approvals: [...state.approvals, approval],
        };
        writeState(newState, statePath);
        updateStatusBar(newState, ctx.ui);
        ctx.ui.notify(`Approved: ${req.command}`, "info");
        return;
      }

      if (subcmd === "clear") {
        const state = readState(statePath);
        const newState: StateFile = {
          ...state,
          pendingRequests: [],
          approvals: [],
        };
        writeState(newState, statePath);
        updateStatusBar(newState, ctx.ui);
        ctx.ui.notify("All pending requests and approvals cleared", "info");
        return;
      }

      ctx.ui.notify("Usage: /destructive-db [mode|status|approve [id]|clear]");
    },
  });

  /* ── Session start: initialize state from config ────────────────
   * Runs once per session start, including subagent forks.
   * Only initializes a fresh state file when none exists;
   * on subsequent starts preserves the existing runtime state.
   */

  pi.on("session_start", async (_event: unknown, ctx: { cwd: string; ui: PiUI }) => {
    const statePath = join(ctx.cwd, options.stateFile);

    if (!existsSync(statePath)) {
      const mode = readConfigMode(ctx.cwd);
      const state: StateFile = {
        mode,
        pendingRequests: [],
        approvals: [],
      };
      writeState(state, statePath);
    }

    updateStatusBar(readState(statePath), ctx.ui);
  });
}

/* ── Embedded module import for existsSync at top level ──────────── */
import { existsSync } from "node:fs";
