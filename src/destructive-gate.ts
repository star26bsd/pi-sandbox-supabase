/**
 * File-backed destructive-operation gate for Supabase CLI commands.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describeCommand } from "./tool.js";
import type {
  AgentToolResult,
  ApprovalRecord,
  DestructiveMode,
  PendingRequest,
  StateFile,
} from "./types.js";

export function defaultState(mode: DestructiveMode = "ask"): StateFile {
  return {
    mode,
    pendingRequests: [],
    approvals: [],
  };
}

export function readState(statePath: string): StateFile {
  if (!existsSync(statePath)) return defaultState();

  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return defaultState();
    const value = parsed as Record<string, unknown>;
    const mode = value.mode;
    if (mode !== "ask" && mode !== "yes" && mode !== "no") return defaultState();

    const pendingRequests = Array.isArray(value.pendingRequests)
      ? value.pendingRequests.filter(isPendingRequest)
      : [];
    const approvals = Array.isArray(value.approvals)
      ? value.approvals.filter(isApprovalRecord)
      : [];

    return { mode, pendingRequests, approvals };
  } catch {
    return defaultState();
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPendingRequest(value: unknown): value is PendingRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    typeof request.id === "string" &&
    typeof request.command === "string" &&
    isStringArray(request.args) &&
    typeof request.createdTstamp === "string" &&
    typeof request.parentQuestion === "string"
  );
}

function isApprovalRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== "object" || value === null) return false;
  const approval = value as Record<string, unknown>;
  return (
    typeof approval.id === "string" &&
    typeof approval.command === "string" &&
    isStringArray(approval.args) &&
    typeof approval.approvedTstamp === "string"
  );
}

export function writeState(state: StateFile, statePath: string): void {
  const directory = dirname(statePath);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function ensureState(statePath: string, mode: DestructiveMode): StateFile {
  if (!existsSync(statePath)) {
    const state = defaultState(mode);
    writeState(state, statePath);
    return state;
  }
  return readState(statePath);
}

export function canonicalizeArgsForApproval(args: string[]): string[] {
  const canonical: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--yes") continue;
    if (arg === "--agent") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--agent=")) continue;
    canonical.push(arg);
  }

  return canonical;
}

function containsSequence(args: string[], sequence: string[]): boolean {
  for (let start = 0; start <= args.length - sequence.length; start += 1) {
    if (sequence.every((entry, offset) => args[start + offset] === entry)) return true;
  }
  return false;
}

export function isDestructive(args: string[]): boolean {
  const commandArgs = canonicalizeArgsForApproval(args);
  if (containsSequence(commandArgs, ["db", "reset"])) return true;
  if (commandArgs.includes("stop")) return true;
  return (
    containsSequence(commandArgs, ["db", "schema", "declarative"]) &&
    commandArgs.includes("sync") &&
    commandArgs.includes("--apply")
  );
}

function hasAgentFlag(args: string[]): boolean {
  return args.some((arg) => arg === "--agent" || arg.startsWith("--agent="));
}

export function withAutomationFlags(args: string[]): string[] {
  const result = [...args];
  if (!hasAgentFlag(result)) result.push("--agent", "yes");
  if (isDestructive(result) && !result.includes("--yes")) result.push("--yes");
  return result;
}

export function generateId(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildParentQuestion(args: string[], commandPrefix: string[]): string {
  const command = describeCommand(commandPrefix, canonicalizeArgsForApproval(args));
  return `I need authorization to run \`${command}\`. This will have irreversible effects on your local environment. Shall I proceed?`;
}

export interface DestructiveGateOptions {
  statePath: string;
  commandPrefix: string[];
}

export function checkDestructive(
  args: string[],
  options: DestructiveGateOptions,
): AgentToolResult | undefined {
  if (!isDestructive(args)) return undefined;

  const state = readState(options.statePath);
  const approvalArgs = canonicalizeArgsForApproval(args);
  const command = describeCommand(options.commandPrefix, approvalArgs);

  if (state.mode === "yes") return undefined;

  if (state.mode === "no") {
    return {
      content: [{
        type: "text",
        text: `Destructive operation '${command}' blocked. Mode: no. This cannot be overridden.\n`,
      }],
      details: { destructive: true, action: "blocked", command },
      isError: true,
    };
  }

  const sameArgs = (candidate: string[]) =>
    JSON.stringify(canonicalizeArgsForApproval(candidate)) === JSON.stringify(approvalArgs);
  const existingRequest = state.pendingRequests.find(
    (request) => request.command === command && sameArgs(request.args),
  );
  const matchingApproval = state.approvals.find(
    (approval) => approval.command === command && sameArgs(approval.args),
  );

  if (matchingApproval) {
    writeState({
      ...state,
      pendingRequests: state.pendingRequests.filter(
        (request) => !existingRequest || request.id !== existingRequest.id,
      ),
      approvals: state.approvals.filter((approval) => approval.id !== matchingApproval.id),
    }, options.statePath);
    return undefined;
  }

  if (existingRequest) {
    return approvalRequired(existingRequest);
  }

  const request: PendingRequest = {
    id: generateId(),
    command,
    args: approvalArgs,
    createdTstamp: new Date().toISOString(),
    parentQuestion: buildParentQuestion(args, options.commandPrefix),
  };
  writeState({
    ...state,
    pendingRequests: [...state.pendingRequests, request],
  }, options.statePath);
  return approvalRequired(request);
}

function approvalRequired(request: PendingRequest): AgentToolResult {
  return {
    content: [{
      type: "text",
      text: `Destructive operation '${request.command}' requires approval. Request ID: ${request.id}.\n${request.parentQuestion}\n`,
    }],
    details: {
      destructive: true,
      action: "approval_required",
      requestId: request.id,
      command: request.command,
      parentQuestion: request.parentQuestion,
    },
    isError: true,
  };
}

export function formatModeIndicator(mode: DestructiveMode, pendingCount = 0): string {
  if (mode === "ask" && pendingCount > 0) {
    return `DB: ask (${pendingCount} pending)`;
  }
  return `DB: ${mode}`;
}

export function updateStatusBar(
  state: StateFile,
  ui: { setStatus: (key: string, text: string | undefined) => void },
): void {
  ui.setStatus("db-ops", formatModeIndicator(state.mode, state.pendingRequests.length));
}
