/**
 * supabase_bash tool implementation.
 *
 * Spawns `npx supabase` commands outside the pi sandbox using
 * child_process.spawn with shell: false for injection-safe
 * argument passing.
 */

import { spawn } from "node:child_process";
import type { AgentToolResult, ResolvedOptions } from "./types.js";

/** Optional abort signal and streaming update callback. */
export interface RunContext {
  signal: AbortSignal | undefined;
  onUpdate: (chunk: string) => void;
}

/**
 * Build the spawn argument list from user-supplied subcommand args.
 * The binary and subcommand prefix are configurable via options.
 *
 * Security: shell: false ensures each argument is a literal value —
 * no shell parsing, no quoting surface, no injection possible.
 */
export function buildSpawnArgs(
  args: string[],
  options: ResolvedOptions,
): [string, string[]] {
  if (!Array.isArray(args)) throw new TypeError("args must be an array");
  return [options.npxBin, [options.supabaseCmd, ...args]];
}

/**
 * Construct the full command description for tool output.
 */
export function describeCommand(args: string[], options: ResolvedOptions): string {
  return `${options.npxBin} ${options.supabaseCmd} ${args.join(" ")}`;
}

/**
 * Spawn `npx supabase` with the given arguments and options.
 * Supports timeout, streaming output, and abort signals.
 */
export function runSupabaseBash(
  params: { args: string[]; timeout?: number },
  context: RunContext,
  options: ResolvedOptions,
): Promise<AgentToolResult> {
  const { args, timeout = options.defaultTimeout } = params;
  const { signal, onUpdate } = context;
  const [binary, spawnArgs] = buildSpawnArgs(args, options);

  const child = spawn(binary, spawnArgs, {
    shell: false,
    cwd: options.supabaseDir,
  });

  const outputChunks: string[] = [];
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  if (timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout * 1000);
  }

  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    outputChunks.push(text);
    onUpdate(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    outputChunks.push(text);
    onUpdate(text);
  });

  child.on("error", (err) => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const msg = `Error: ${err.message}\n`;
    outputChunks.push(msg);
    onUpdate(msg);
  });

  child.on("close", () => {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  });

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", () => {
      signal?.removeEventListener("abort", onAbort);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted) {
        reject(new Error("aborted"));
        return;
      }
      if (timedOut) {
        reject(new Error(`timeout:${timeout}`));
        return;
      }
      const isError = (code ?? 1) !== 0;
      const accumulated = outputChunks.join("");
      resolve({
        content: [{ type: "text", text: accumulated }],
        isError,
      });
    });
  });
}
