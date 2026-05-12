/**
 * Type definitions for pi-sandbox-supabase
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** AgentToolResult shape expected by pi's tool execution framework. */
export interface AgentToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

/** Pending approval request written to state file. */
export interface PendingRequest {
  id: string;
  command: string;
  args: string[];
  createdTstamp: string;
  parentQuestion: string;
}

/** Approval record written to state file. */
export interface ApprovalRecord {
  id: string;
  command: string;
  args: string[];
  approvedTstamp: string;
}

/** Runtime state shape for the destructive-operations state file. */
export interface StateFile {
  mode: "ask" | "yes" | "no";
  pendingRequests: PendingRequest[];
  approvals: ApprovalRecord[];
}

/** PI UI interface with status bar and notification methods. */
export interface PiUI {
  setStatus: (key: string, text: string | undefined) => void;
  notify: (message: string, level?: string) => void;
  select: (title: string, options: string[]) => Promise<string | undefined>;
}

/** Extension context passed to tool handlers. */
export interface ExtensionContext {
  cwd: string;
  ui: PiUI;
}

/**
 * Configuration options for the supabase_bash extension.
 * All fields are optional with sensible defaults.
 */
export interface SupabaseBashOptions {
  /**
   * Relative path from project root where `npx supabase` commands are executed.
   * @default "supabase/"
   */
  supabaseDir?: string;

  /**
   * Path to the destructive-operations state file, relative to project root.
   * @default ".pi/supabase-bash-state.json"
   */
  stateFile?: string;

  /**
   * Default command timeout in seconds.
   * @default 120
   */
  defaultTimeout?: number;

  /**
   * Binary used to run supabase commands.
   * @default "npx"
   */
  npxBin?: string;

  /**
   * The supabase CLI subcommand prefix.
   * @default "supabase"
   */
  supabaseCmd?: string;

  /**
   * Additional custom functions to detect destructive operations.
   * Each function receives the args array and returns true if destructive.
   * Built-in patterns (db reset, stop, declarative sync --apply) are always checked.
   */
  customDestructivePatterns?: Array<(args: string[]) => boolean>;
}

/** Resolved options with all defaults filled in. */
export type ResolvedOptions = Required<SupabaseBashOptions>;
