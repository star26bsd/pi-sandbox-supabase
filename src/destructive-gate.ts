/**
 * Destructive-operations gate for the supabase_bash tool.
 *
 * Implements a file-backed state machine that gates destructive `npx supabase`
 * commands. Supports three modes:
 *
 * - `yes`: allow destructive commands without approval
 * - `ask`: require explicit approval via /destructive-db approve
 * - `no`:  block destructive commands unconditionally
 *
 * The state file is JSON on disk at the configured path. This allows
 * focused sessions to share gate state while a human approves operations
 * from another session.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  AgentToolResult,
  StateFile,
  PendingRequest,
  ApprovalRecord,
  ResolvedOptions,
} from "./types.js";

/* ── State file ────────────────────────────────────────────────── */

/** Default state used when file is missing or malformed. */
export function defaultState(): StateFile {
  return {
    mode: "ask",
    pendingRequests: [],
    approvals: [],
  };
}

/**
 * Read and validate the runtime state file.
 * Returns safe defaults for missing/malformed data.
 *
 * Only accepts mode values that are exactly "ask", "yes", or "no".
 * Pending requests and approvals missing required fields are dropped.
 */
export function readState(statePath: string): StateFile {
  if (!existsSync(statePath)) return defaultState();
  try {
    const raw = readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return defaultState();
    const obj = parsed as Record<string, unknown>;

    const mode = obj.mode as string | undefined;
    if (typeof mode !== "string" || !["ask", "yes", "no"].includes(mode))
      return defaultState();

    const pendingRequests = (obj.pendingRequests as unknown[]) ?? [];
    const approvals = (obj.approvals as unknown[]) ?? [];

    return {
      mode: mode as "ask" | "yes" | "no",
      pendingRequests: pendingRequests.filter(
        (r: unknown) =>
          r &&
          typeof r === "object" &&
          typeof (r as any).id === "string" &&
          typeof (r as any).command === "string" &&
          Array.isArray((r as any).args) &&
          typeof (r as any).createdTstamp === "string" &&
          typeof (r as any).parentQuestion === "string",
      ) as PendingRequest[],
      approvals: approvals.filter(
        (a: unknown) =>
          a &&
          typeof a === "object" &&
          typeof (a as any).id === "string" &&
          typeof (a as any).command === "string" &&
          Array.isArray((a as any).args) &&
          typeof (a as any).approvedTstamp === "string",
      ) as ApprovalRecord[],
    };
  } catch {
    return defaultState();
  }
}

/** Write state file, creating the directory if needed. */
export function writeState(state: StateFile, statePath: string): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/* ── Destructive pattern detection ──────────────────────────────── */

/**
 * Check if the given args array matches a known destructive pattern.
 * Built-in patterns:
 *   - `db reset` (full or partial)
 *   - `stop`
 *   - `db schema declarative sync ... --apply`
 */
export function canonicalizeArgsForApproval(args: string[]): string[] {
  const canonical: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--yes") continue;
    if (arg === "--agent") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) continue;

    canonical.push(arg);
  }

  return canonical;
}

function hasAgentFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--agent" || arg.startsWith("--agent="));
}

function hasYesFlag(args: string[]): boolean {
  return args.includes("--yes");
}

export function withAutomationFlags(
  args: string[],
  customPatterns: Array<(args: string[]) => boolean>,
): string[] {
  const result = [...args];

  // Supabase CLI global flag: make agent/non-interactive context explicit and
  // avoid repeated CLI agent-detection chatter. Keep user-provided values.
  if (!hasAgentFlag(result)) result.push("--agent", "yes");

  // If the command itself is destructive, the project-level destructive gate is
  // the confirmation boundary. Add Supabase's own --yes once so the approved
  // command does not prompt again or produce a second approval request.
  if (isDestructive(result, customPatterns) && !hasYesFlag(result)) result.push("--yes");

  return result;
}

export function isDestructive(args: string[], customPatterns: Array<(args: string[]) => boolean>): boolean {
  const commandArgs = canonicalizeArgsForApproval(args);
  if (!commandArgs || commandArgs.length === 0) return false;

  // Check for "db reset"
  if (commandArgs[0] === "db" && commandArgs[1] === "reset") return true;

  // Check for "stop"
  if (commandArgs[0] === "stop") return true;

  // Check for "db schema declarative sync --apply"
  if (
    commandArgs[0] === "db" &&
    commandArgs[1] === "schema" &&
    commandArgs[2] === "declarative" &&
    commandArgs.includes("sync") &&
    commandArgs.includes("--apply")
  ) {
    return true;
  }

  // Check custom patterns
  for (const pattern of customPatterns) {
    if (pattern(commandArgs)) return true;
  }

  return false;
}

/* ── Approval request ID generation ────────────────────────────── */

/** Generate a short, unique request ID. */
export function generateId(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* ── Destructive gate ──────────────────────────────────────────── */

let backtick: string | undefined;
function bt(): string {
  if (!backtick) backtick = String.fromCharCode(96);
  return backtick;
}

/**
 * Parent-facing question for a destructive command.
 */
export function buildParentQuestion(args: string[], options: ResolvedOptions): string {
  const cmd = `${options.npxBin} ${options.supabaseCmd} ${args.join(" ")}`;
  return `I need authorization to run ${bt()}${cmd}${bt()}. This will have irreversible effects on your local environment. Shall I proceed?`;
}

/**
 * Check whether a destructive command should proceed based on file-backed state.
 * Returns a refusal result to send back, or undefined if the command is allowed.
 *
 * In `ask` mode, creates/reuses a pending request and checks for a matching approval.
 */
export function checkDestructive(
  args: string[],
  options: ResolvedOptions,
  cwd: string,
): AgentToolResult | undefined {
  if (!isDestructive(args, options.customDestructivePatterns)) return undefined;

  const statePath = join(cwd, options.stateFile);
  const state = readState(statePath);
  const command = args.join(" ");
  const approvalArgs = canonicalizeArgsForApproval(args);

  // Mode: yes — allow immediately
  if (state.mode === "yes") return undefined;

  // Mode: no — block unconditionally
  if (state.mode === "no") {
    return {
      content: [
        {
          type: "text",
          text: `Destructive operation '${command}' blocked. Mode: no. This cannot be overridden.\n`,
        },
      ],
      details: {
        destructive: true,
        action: "blocked",
        command,
      },
      isError: true,
    };
  }

  // Mode: ask — check for approval
  const existingRequest = state.pendingRequests.find(
    (r) => JSON.stringify(canonicalizeArgsForApproval(r.args)) === JSON.stringify(approvalArgs),
  );

  const matchingApproval = state.approvals.find(
    (a) => JSON.stringify(canonicalizeArgsForApproval(a.args)) === JSON.stringify(approvalArgs),
  );

  if (existingRequest) {
    if (matchingApproval) {
      const newState = {
        ...state,
        approvals: state.approvals.filter((a) => a !== matchingApproval),
      };
      writeState(newState, statePath);
      return undefined;
    }
    return {
      content: [
        {
          type: "text",
          text: `Destructive operation '${command}' requires approval. Request ID: ${existingRequest.id}.\n`,
        },
      ],
      details: {
        destructive: true,
        action: "approval_required",
        requestId: existingRequest.id,
        command,
        parentQuestion: existingRequest.parentQuestion,
      },
      isError: true,
    };
  }

  if (matchingApproval) {
    const newState = {
      ...state,
      approvals: state.approvals.filter((a) => a !== matchingApproval),
    };
    writeState(newState, statePath);
    return undefined;
  }

  // Create new pending request
  const id = generateId();
  const parentQuestion = buildParentQuestion(args, options);
  const newRequest: PendingRequest = {
    id,
    command,
    args: approvalArgs,
    createdTstamp: new Date().toISOString(),
    parentQuestion,
  };
  const newState: StateFile = {
    ...state,
    pendingRequests: [...state.pendingRequests, newRequest],
  };
  writeState(newState, statePath);

  return {
    content: [
      {
        type: "text",
        text: `Destructive operation '${command}' requires approval. Request ID: ${id}.\n`,
      },
    ],
    details: {
      destructive: true,
      action: "approval_required",
      requestId: id,
      command,
      parentQuestion,
    },
    isError: true,
  };
}

/* ── Config and status bar ──────────────────────────────────────── */

/**
 * Read destructiveDbOps from `.pi/sandbox.json`.
 * Returns "yes" | "no" | "ask" — defaults to "ask" if absent/invalid.
 */
export function readConfigMode(cwd: string): "no" | "ask" | "yes" {
  const configPath = join(cwd, ".pi", "sandbox.json");
  if (!existsSync(configPath)) return "ask";
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const value = config?.destructiveDbOps;
    if (value === "yes" || value === "no" || value === "ask") return value;
  } catch {
    // Ignore parse errors
  }
  return "ask";
}

/**
 * Format the status bar indicator for the given mode.
 * Returns `DB: ask`, `DB: yes`, or `DB: no`.
 * In ask mode with pending requests, includes count: `DB: ask (1 pending)`.
 */
export function formatModeIndicator(mode: "no" | "ask" | "yes", pendingCount?: number): string {
  let indicator = "DB: ";
  indicator += mode;
  if (mode === "ask" && pendingCount !== undefined && pendingCount > 0) {
    indicator += ` (${pendingCount} pending)`;
  }
  return indicator;
}

/**
 * Update status bar with current mode and pending count.
 * Uses the "db-ops" status key.
 */
export function updateStatusBar(
  state: StateFile,
  ui: { setStatus: (key: string, text: string | undefined) => void },
): void {
  ui.setStatus("db-ops", formatModeIndicator(state.mode, state.pendingRequests.length));
}
