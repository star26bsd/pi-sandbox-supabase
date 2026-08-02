import { findBlockedCommand } from "./command-policy.js";
import {
  PROCESS_SETTLEMENT_GRACE_MS,
  spawnInProcessGroup,
  terminateProcessTree,
} from "./process-supervisor.js";
import type { DenoTestEnvironmentProfile, ResolvedConfig } from "./types.js";
import { buildSpawnCommand } from "./tool.js";

const ACQUISITION_TIMEOUT_SECONDS = 30;
const ACQUISITION_STREAM_LIMIT_BYTES = 64 * 1024;
const STATUS_ARGS = ["status", "-o", "env"];

export class EnvironmentProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentProfileError";
  }
}

function decodeValue(raw: string): string | undefined {
  if (raw.startsWith('"')) {
    if (!raw.endsWith('"')) return undefined;
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.slice(1, -1).includes("'")) return undefined;
    return raw.slice(1, -1);
  }
  return /^\S*$/.test(raw) ? raw : undefined;
}

export function parseSupabaseStatusEnvironment(output: string): Record<string, string> {
  const environment: Record<string, string> = Object.create(null);
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (line.length === 0) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new EnvironmentProfileError("Environment profile acquisition returned malformed data");
    const value = decodeValue(match[2]);
    if (value === undefined) {
      throw new EnvironmentProfileError("Environment profile acquisition returned malformed data");
    }
    if (value.includes("\0")) {
      throw new EnvironmentProfileError("Environment profile acquisition returned malformed data");
    }
    environment[match[1]] = value;
  }
  return environment;
}

interface CaptureInvocation {
  prefix: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

type AcquisitionFailure = "overflow" | "timeout" | "abort";

function acquisitionFailureMessage(failure: AcquisitionFailure): string {
  if (failure === "abort") return "Environment profile acquisition aborted";
  if (failure === "timeout") {
    return `Environment profile acquisition timed out after ${ACQUISITION_TIMEOUT_SECONDS} seconds`;
  }
  return "Environment profile acquisition exceeded its output limit";
}

function captureSupabaseStatus(invocation: CaptureInvocation): Promise<string> {
  const [binary, args] = buildSpawnCommand(invocation.prefix, STATUS_ARGS);
  if (invocation.signal?.aborted) {
    return Promise.reject(new EnvironmentProfileError("Environment profile acquisition aborted before execution"));
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawnInProcessGroup>;
    try {
      child = spawnInProcessGroup(binary, args, {
        shell: false,
        cwd: invocation.cwd,
        env: invocation.environment,
      });
    } catch {
      reject(new EnvironmentProfileError("Unable to start environment profile acquisition"));
      return;
    }

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: AcquisitionFailure | undefined;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let settlementHandle: ReturnType<typeof setTimeout> | undefined;

    const finishReject = (message: string) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settlementHandle) clearTimeout(settlementHandle);
      invocation.signal?.removeEventListener("abort", onAbort);
      reject(new EnvironmentProfileError(message));
    };
    const stop = (reason: AcquisitionFailure) => {
      if (failure || settled) return;
      failure = reason;
      terminateProcessTree(child);
      settlementHandle = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        finishReject(acquisitionFailureMessage(reason));
      }, PROCESS_SETTLEMENT_GRACE_MS);
      settlementHandle.unref();
    };
    const onAbort = () => stop("abort");
    const appendStdout = (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > ACQUISITION_STREAM_LIMIT_BYTES) stop("overflow");
      else stdout.push(chunk);
    };
    const countStderr = (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > ACQUISITION_STREAM_LIMIT_BYTES) stop("overflow");
    };

    child.stdout?.on("data", appendStdout);
    child.stderr?.on("data", countStderr);
    child.once("error", () => finishReject("Unable to start environment profile acquisition"));
    child.once("close", (code) => {
      if (settled) return;
      if (failure) return finishReject(acquisitionFailureMessage(failure));
      if ((code ?? 1) !== 0) {
        return finishReject(`Environment profile acquisition failed with exit code ${code ?? "unknown"}`);
      }
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (settlementHandle) clearTimeout(settlementHandle);
      invocation.signal?.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(stdout).toString("utf-8"));
    });

    invocation.signal?.addEventListener("abort", onAbort, { once: true });
    timeoutHandle = setTimeout(() => stop("timeout"), ACQUISITION_TIMEOUT_SECONDS * 1000);
  });
}

export interface AcquiredEnvironmentProfile {
  environment: NodeJS.ProcessEnv;
  redactedValues: string[];
}

export async function acquireDenoTestEnvironment(
  name: string,
  config: ResolvedConfig,
  cwd: string,
  baseEnvironment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<AcquiredEnvironmentProfile> {
  const profile: DenoTestEnvironmentProfile | undefined = config.denoTestEnvironmentProfiles[name];
  if (!profile) {
    throw new EnvironmentProfileError(`Unknown Deno test environment profile '${name}'`);
  }

  const blocked = findBlockedCommand(STATUS_ARGS, config.blockedCommands);
  if (blocked) {
    throw new EnvironmentProfileError(
      `Environment profile acquisition is blocked by configuration: ${blocked.reason}`,
    );
  }

  let acquired: Record<string, string>;
  try {
    const output = await captureSupabaseStatus({
      prefix: config.commands.supabaseCli,
      cwd,
      environment: baseEnvironment,
      signal,
    });
    acquired = parseSupabaseStatusEnvironment(output);
  } catch (error) {
    if (error instanceof EnvironmentProfileError) throw error;
    throw new EnvironmentProfileError("Environment profile acquisition failed while parsing data");
  }

  const environment = { ...baseEnvironment };
  const missing: string[] = [];
  const injected: string[] = [];
  for (const [source, target] of Object.entries(profile.variables)) {
    if (!Object.hasOwn(acquired, source)) {
      missing.push(source);
      continue;
    }
    environment[target] = acquired[source];
    if (acquired[source].length > 0) injected.push(acquired[source]);
  }
  if (missing.length > 0) {
    throw new EnvironmentProfileError(
      `Environment profile '${name}' is missing configured source variable(s): ${missing.join(", ")}`,
    );
  }

  return {
    environment,
    redactedValues: [...new Set(injected)].sort((left, right) => right.length - left.length),
  };
}
