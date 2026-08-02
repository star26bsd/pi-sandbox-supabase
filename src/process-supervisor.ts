import { spawn, type SpawnOptions } from "node:child_process";

export const PROCESS_SETTLEMENT_GRACE_MS = 1_000;

export function spawnInProcessGroup(
  binary: string,
  args: string[],
  options: SpawnOptions,
): ReturnType<typeof spawn> {
  return spawn(binary, args, {
    ...options,
    detached: process.platform !== "win32",
  });
}

export function terminateProcessTree(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32") {
    if (child.pid !== undefined) {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => child.kill("SIGKILL"));
      killer.unref();
    } else {
      child.kill("SIGKILL");
    }
    return;
  }

  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back when process-group termination is unavailable or the child already exited.
    }
  }
  child.kill("SIGKILL");
}
