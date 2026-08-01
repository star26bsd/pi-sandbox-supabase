/**
 * Direct process execution shared by the focused tools.
 */

import { spawn } from "node:child_process";
import type { AgentToolResult } from "./types.js";

export interface RunContext {
  signal: AbortSignal | undefined;
  onUpdate?: (partialResult: AgentToolResult) => void;
}

export interface CommandInvocation {
  prefix: string[];
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeout: number;
}

export function buildSpawnCommand(
  prefix: string[],
  args: string[],
): [string, string[]] {
  if (!Array.isArray(prefix) || prefix.length === 0) {
    throw new TypeError("command prefix must be a non-empty array");
  }
  if (!Array.isArray(args)) throw new TypeError("args must be an array");
  return [prefix[0], [...prefix.slice(1), ...args]];
}

function quoteForDisplay(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function describeCommand(prefix: string[], args: string[]): string {
  return [...prefix, ...args].map(quoteForDisplay).join(" ");
}

export function runCommand(
  invocation: CommandInvocation,
  context: RunContext,
): Promise<AgentToolResult> {
  const { prefix, args, cwd, environment, timeout } = invocation;
  const { signal, onUpdate } = context;
  const [binary, spawnArgs] = buildSpawnCommand(prefix, args);
  const command = describeCommand(prefix, args);

  if (signal?.aborted) {
    return Promise.reject(new Error(`Command aborted before execution: ${command}`));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(binary, spawnArgs, {
      shell: false,
      cwd,
      env: environment,
    });

    const outputChunks: string[] = [];
    let timedOut = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const output = () => outputChunks.join("");
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };

    const onAbort = () => {
      child.kill("SIGKILL");
    };

    const appendOutput = (chunk: Buffer | string) => {
      outputChunks.push(chunk.toString());
      onUpdate?.({
        content: [{ type: "text", text: output() }],
        details: undefined,
      });
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);

    child.once("error", (error) => {
      rejectOnce(new Error(`Unable to start '${command}' in '${cwd}': ${error.message}`));
    });

    child.once("close", (code, closeSignal) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);

      if (signal?.aborted) {
        reject(new Error(`Command aborted: ${command}`));
        return;
      }
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeout} seconds: ${command}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        const suffix = output().length > 0 ? `\n${output()}` : "";
        reject(
          new Error(
            `Command failed with exit code ${code ?? "unknown"}${closeSignal ? ` (${closeSignal})` : ""}: ${command}${suffix}`,
          ),
        );
        return;
      }

      resolve({
        content: [{ type: "text", text: output() }],
        details: { command, cwd, exitCode: code ?? 0 },
      });
    });

    signal?.addEventListener("abort", onAbort, { once: true });

    if (timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);
    }
  });
}
