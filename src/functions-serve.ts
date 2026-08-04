import type { ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { findBlockedCommand } from "./command-policy.js";
import {
  PROCESS_SETTLEMENT_GRACE_MS,
  signalProcessTree,
  spawnInProcessGroup,
  terminateProcessTree,
} from "./process-supervisor.js";
import { buildSpawnCommand } from "./tool.js";
import type { AgentToolResult, BlockedCommand } from "./types.js";

const STARTUP_MARKER = "Serving functions on ";
const MARKER_BUFFER_CHARACTERS = 8 * 1024;
export const FUNCTIONS_SERVE_STOP_GRACE_MS = 10_000;

type Phase = "stopped" | "starting" | "running" | "stopping";
type Cleanup = "confirmed" | "cleanup_unconfirmed";

export interface FunctionsServeInvocation {
  prefix: string[];
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutSeconds: number;
  blockedCommands: BlockedCommand[];
}

interface ExitMetadata {
  timestamp: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  cleanup?: Cleanup;
}

interface LiveProcess {
  child: ChildProcess;
  startedAt: string;
  exit?: ExitMetadata;
  spawnError: boolean;
  closeSettled: boolean;
  closePromise: Promise<void>;
}

export interface FunctionsServeControllerOptions {
  stopGraceMs?: number;
  settlementGraceMs?: number;
  now?: () => Date;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, "");
}

function lifecycleResult(
  action: "start" | "status" | "stop",
  phase: Phase,
  fields: Record<string, unknown> = {},
): AgentToolResult {
  return {
    content: [{ type: "text", text: `Supabase functions serve is ${phase}.\n` }],
    details: { action, phase, ...fields },
  };
}

function lifecycleError(phase: string, reason: string, fields: Record<string, unknown> = {}): Error {
  const error = new Error(`Supabase functions serve ${phase} failed: ${reason}`);
  Object.assign(error, { details: { phase, reason, ...fields } });
  return error;
}

export class FunctionsServeController {
  private phase: Phase = "stopped";
  private live?: LiveProcess;
  private lastExit?: ExitMetadata;
  private operation: Promise<unknown> = Promise.resolve();
  private cancelStartup?: (reason: "abort" | "shutdown") => void;
  private readonly stopGraceMs: number;
  private readonly settlementGraceMs: number;
  private readonly now: () => Date;

  constructor(options: FunctionsServeControllerOptions = {}) {
    this.stopGraceMs = options.stopGraceMs ?? FUNCTIONS_SERVE_STOP_GRACE_MS;
    this.settlementGraceMs = options.settlementGraceMs ?? PROCESS_SETTLEMENT_GRACE_MS;
    this.now = options.now ?? (() => new Date());
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  start(invocation: FunctionsServeInvocation, signal?: AbortSignal): Promise<AgentToolResult> {
    return this.serialize(() => this.startSerialized(invocation, signal));
  }

  status(): Promise<AgentToolResult> {
    return this.serialize(async () => lifecycleResult("status", this.phase, {
      startedAt: this.live?.startedAt,
      lastExit: this.lastExit,
    }));
  }

  stop(): Promise<AgentToolResult> {
    this.cancelStartup?.("shutdown");
    return this.serialize(() => this.stopSerialized("stop"));
  }

  shutdown(): Promise<void> {
    this.cancelStartup?.("shutdown");
    return this.serialize(async () => {
      await this.stopSerialized("stop");
    });
  }

  private async startSerialized(
    invocation: FunctionsServeInvocation,
    signal?: AbortSignal,
  ): Promise<AgentToolResult> {
    if (this.phase === "running") {
      return lifecycleResult("start", "running", { startedAt: this.live?.startedAt });
    }
    if (signal?.aborted) throw lifecycleError("startup", "aborted");

    const logicalArgs = ["functions", "serve", ...invocation.args];
    const blocked = findBlockedCommand(logicalArgs, invocation.blockedCommands);
    if (blocked) {
      throw lifecycleError("startup", "blocked_by_configuration");
    }

    const [binary, args] = buildSpawnCommand(invocation.prefix, logicalArgs);
    this.phase = "starting";
    const startedAt = this.now().toISOString();
    let child: ChildProcess;
    try {
      child = spawnInProcessGroup(binary, args, {
        shell: false,
        cwd: invocation.cwd,
        env: invocation.environment,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      this.phase = "stopped";
      throw lifecycleError("startup", "unable_to_spawn");
    }

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
    const live: LiveProcess = {
      child,
      startedAt,
      spawnError: false,
      closeSettled: false,
      closePromise,
    };
    this.live = live;
    const recordExit = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      if (live.exit) return;
      live.exit = {
        timestamp: this.now().toISOString(),
        exitCode,
        signal: exitSignal,
      };
    };
    const settleClose = () => {
      if (live.closeSettled) return;
      live.closeSettled = true;
      resolveClose();
      if (this.live === live && (this.phase === "running" || this.phase === "starting")) {
        const exit = live.exit ?? {
          timestamp: this.now().toISOString(),
          exitCode: null,
          signal: null,
        };
        this.lastExit = exit;
        this.live = undefined;
        this.phase = "stopped";
      }
    };
    child.once("exit", recordExit);
    child.once("close", (exitCode, exitSignal) => {
      recordExit(exitCode, exitSignal);
      settleClose();
    });
    child.once("error", () => {
      live.spawnError = true;
      recordExit(null, null);
      settleClose();
    });

    const stdoutDecoder = new StringDecoder("utf-8");
    const stderrDecoder = new StringDecoder("utf-8");
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let startupFailure: "timeout" | "abort" | "shutdown" | "early_exit" | "spawn_error" | undefined;

    const readiness = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (failure?: typeof startupFailure) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        signal?.removeEventListener("abort", onAbort);
        this.cancelStartup = undefined;
        if (failure) {
          startupFailure = failure;
          reject(lifecycleError("startup", failure));
        } else resolve();
      };
      const append = (stream: "stdout" | "stderr", text: string) => {
        if (stream === "stdout") {
          stdoutBuffer = (stdoutBuffer + text).slice(-MARKER_BUFFER_CHARACTERS);
          if (stripAnsi(stdoutBuffer).includes(STARTUP_MARKER)) finish();
        } else {
          stderrBuffer = (stderrBuffer + text).slice(-MARKER_BUFFER_CHARACTERS);
          if (stripAnsi(stderrBuffer).includes(STARTUP_MARKER)) finish();
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => append("stdout", stdoutDecoder.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", stderrDecoder.write(chunk)));
      child.once("error", () => finish("spawn_error"));
      child.once("exit", () => finish("early_exit"));
      const onAbort = () => finish("abort");
      signal?.addEventListener("abort", onAbort, { once: true });
      this.cancelStartup = (reason) => finish(reason);
      const timeoutHandle: ReturnType<typeof setTimeout> = setTimeout(
        () => finish("timeout"),
        invocation.timeoutSeconds * 1000,
      );
      timeoutHandle.unref();
    });

    try {
      await readiness;
      if (this.phase !== "starting" || live.exit || live.spawnError) {
        throw lifecycleError("startup", live.spawnError ? "spawn_error" : "early_exit");
      }
      this.phase = "running";
      return lifecycleResult("start", "running", { startedAt });
    } catch (error) {
      if (this.live === live) await this.stopLiveProcess(live);
      throw error instanceof Error
        ? error
        : lifecycleError("startup", startupFailure ?? "failed");
    }
  }

  private async stopSerialized(action: "stop"): Promise<AgentToolResult> {
    if (!this.live || this.phase === "stopped") {
      return lifecycleResult(action, "stopped", { lastExit: this.lastExit });
    }
    const exit = await this.stopLiveProcess(this.live);
    return lifecycleResult(action, "stopped", { lastExit: exit });
  }

  private waitForClose(live: LiveProcess, milliseconds: number): Promise<boolean> {
    if (live.closeSettled) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer: ReturnType<typeof setTimeout> = setTimeout(() => resolve(false), milliseconds);
      live.closePromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private async stopLiveProcess(live: LiveProcess): Promise<ExitMetadata> {
    this.phase = "stopping";
    if (!live.exit && !live.spawnError) signalProcessTree(live.child, "SIGTERM");

    let forced = false;
    const closed = live.spawnError || await this.waitForClose(live, this.stopGraceMs);
    if (!closed) {
      forced = true;
      terminateProcessTree(live.child);
      await this.waitForClose(live, this.settlementGraceMs);
    }

    live.child.stdout?.destroy();
    live.child.stderr?.destroy();
    if (!live.exit) live.child.unref();
    const metadata: ExitMetadata = live.exit ?? {
      timestamp: this.now().toISOString(),
      exitCode: null,
      signal: forced ? "SIGKILL" : "SIGTERM",
    };
    metadata.cleanup = forced ? "cleanup_unconfirmed" : "confirmed";
    this.lastExit = metadata;
    if (this.live === live) this.live = undefined;
    this.phase = "stopped";
    return metadata;
  }
}

export class FunctionsServeManager {
  private readonly controllers = new Map<string, FunctionsServeController>();

  controller(projectRoot: string): FunctionsServeController {
    let controller = this.controllers.get(projectRoot);
    if (!controller) {
      controller = new FunctionsServeController();
      this.controllers.set(projectRoot, controller);
    }
    return controller;
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.controllers.values()].map((controller) => controller.shutdown()));
    this.controllers.clear();
  }
}
