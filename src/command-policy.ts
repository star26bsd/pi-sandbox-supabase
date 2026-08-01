import type { BlockedCommand } from "./types.js";

function containsSequence(args: string[], prefix: string[]): boolean {
  if (prefix.length > args.length) return false;

  for (let start = 0; start <= args.length - prefix.length; start += 1) {
    if (prefix.every((entry, offset) => args[start + offset] === entry)) {
      return true;
    }
  }
  return false;
}

export function findBlockedCommand(
  args: string[],
  rules: BlockedCommand[],
): BlockedCommand | undefined {
  return rules.find((rule) => containsSequence(args, rule.prefix));
}

const DENO_PERMISSION_SHORT_FLAGS = /^-[^-]*[ARWNESI]/;

export function isDenoPermissionArgument(arg: string): boolean {
  return (
    arg === "-A" ||
    arg === "--allow-all" ||
    arg.startsWith("--allow-") ||
    DENO_PERMISSION_SHORT_FLAGS.test(arg)
  );
}

export function findDenoPermissionArgument(args: string[]): string | undefined {
  return args.find(isDenoPermissionArgument);
}
