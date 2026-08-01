# pi-supabase-tools

## Problem

Focused Pi sessions should not need unsandboxed Bash merely to operate and verify Supabase. Pi's general shell sandbox blocks capabilities required by local Supabase workflows, while disabling that sandbox grants far more host authority than the session needs.

## Purpose

Provide controlled host execution for Supabase CLI operations and Supabase verification workflows while general shell execution remains disabled or sandboxed.

## Package and tool naming

The package is named `pi-supabase-tools`, reflecting that its leverage does not depend on `pi-sandbox` and that it exposes more than one focused tool.

The model-facing Supabase tool is named `supabase_cli`. This is a breaking replacement for `supabase_bash`; the extension does not register a compatibility alias.

## Supabase CLI scope

The Supabase CLI tool exposes the complete Supabase CLI command interface. It fixes the user-configured executable and command prefix while accepting literal argument arrays, preserving compatibility with existing and future Supabase CLI commands without introducing a second command taxonomy.

The tool does not classify commands as local or remote. A remote mutation can succeed only when the Supabase session's environment and project configuration provide the required authority. Users are responsible for deciding which credentials and remote configuration are available to their sessions.

Existing destructive-operation gating remains a separate safeguard for recognized destructive commands; it is not a comprehensive Supabase CLI authorization policy.

The package has no built-in obsolete-command policy. Users may configure `blockedCommands` as argument-prefix rules with human-readable reasons. A rule matches its contiguous argument sequence even when Supabase global flags precede it. Global and project rules are combined, so project configuration may add restrictions but cannot weaken global restrictions. For example:

```json
{
  "blockedCommands": [
    {
      "prefix": ["db", "diff"],
      "reason": "This project uses PG-Delta declarative sync."
    }
  ]
}
```

A matching command is refused before process execution and reports the configured reason to the Supabase session.

## Toolchain environment

The extension does not install, upgrade, or select tool versions. It loads a user-specified declarative JSON toolchain environment for its child processes, allowing users to make their chosen `npx`, Supabase CLI, and Deno binaries discoverable without relying on interactive login-shell profiles or executing a setup shell script.

Configuration is optional and discovered at Pi's standard scopes:

- global: `~/.pi/agent/supabase-tools.json`
- project: `<cwd>/.pi/supabase-tools.json`

Without either file, defaults are `commands.supabaseCli = ["npx", "supabase"]`, `commands.denoTest = ["deno", "test"]`, `workingDirectory = "supabase"`, and `destructiveDbOps = "ask"`.

Global configuration provides defaults. Project configuration overrides scalar values, command prefixes, and environment keys. Project `PATH` additions are prepended ahead of global additions and the effective child `PATH`.

Child processes inherit Pi's environment by default. An `environment` string sets or overrides a variable; `null` explicitly removes an inherited variable. This allows a Supabase session to withhold remote credentials without constructing an entire environment from scratch.

A configuration using the default npm-based Supabase CLI and a Deno binary from `PATH` looks like:

```json
{
  "pathPrepend": ["~/.deno/bin"],
  "environment": {
    "DENO_DIR": "/tmp/deno-cache"
  },
  "commands": {
    "supabaseCli": ["npx", "supabase"],
    "denoTest": ["deno", "test"]
  },
  "workingDirectory": "supabase",
  "destructiveDbOps": "ask",
  "stateFile": ".pi/supabase-tools-state.json"
}
```

Command prefixes are argument arrays, never shell strings. `workingDirectory` is resolved relative to the active session's `ctx.cwd` for every invocation and is shared by both tools. A user with a standalone or Homebrew Supabase CLI can replace the npm prefix, for example:

```json
{
  "commands": {
    "supabaseCli": ["/opt/homebrew/bin/supabase"]
  }
}
```

Project configuration is loaded only when Pi reports the project as trusted. This follows Pi's standard project-trust behavior and prevents a globally installed extension from accepting host-execution configuration from an untrusted repository.

Configuration parsing and validation fail closed. If a discovered file is malformed or invalid, the tools remain visible but every invocation reports an actionable configuration error and no child process starts. The extension never silently falls back to defaults past an invalid discovered file.

A missing configured executable produces an actionable error. Version compatibility remains the user's responsibility.

## Destructive-operation gate

The gate's startup mode is configured through `destructiveDbOps` in `supabase-tools.json`; it no longer reads `sandbox.json`. Runtime approvals and pending requests are stored in `.pi/supabase-tools-state.json` by default. The old `supabase-bash-state.json` name is not retained as a compatibility alias.

## Edge Function tests

The extension exposes a separate `deno_test` tool with the fixed `deno test` executable/subcommand interface and literal arguments. It does not expose arbitrary Deno subcommands or shell execution.

Agent-supplied arguments cannot contain Deno permission-increasing flags such as `--allow-*`, `--allow-all`, `--allow-run`, `--allow-scripts`, `-A`, or equivalent short forms. Trusted global or project configuration grants required permissions by including them in the fixed `commands.denoTest` prefix. The default prefix grants no Deno permissions, so a session may select tests and filters but cannot increase its configured authority.

The Supabase CLI tool remains the preferred interface wherever the CLI owns the operation. `deno_test` exists because Supabase CLI 2.111.0 provides database tests but no Edge Function test command, and current Supabase documentation uses Deno's native test runner.

## SQL execution

The initial scope does not expose `psql`. Supabase sessions execute local SQL through `supabase db query --local`, keeping SQL access behind the Supabase CLI tool. This behavior was verified against Supabase CLI 2.111.0 and a running local Supabase stack.

Each invocation passes SQL as one literal argument and accepts one top-level PostgreSQL prepared statement. Invocations use separate CLI processes and database connections, so transaction state, temporary objects, session settings, and advisory locks do not persist between calls. Multi-operation reversible smoke checks must use one `DO` statement and explicitly clean up.

## Session steering

The package does not prescribe orchestration or automatically load a role prompt. Users grant `supabase_cli` and `deno_test` to a visible, named Supabase session through Pi's tool allowlist and own any additional steering.

The package includes `examples/supabase-session-prompt.md` as an optional, non-loaded steering example.

## First usable slice

The initial delivery uses platform-neutral direct process spawning and is verified against the maintainer's macOS setup. Linux and WSL2 verification are deferred; the implementation must avoid unnecessary macOS-specific assumptions.

## Security posture

The module reduces host execution authority from arbitrary shell commands to Supabase CLI operations. It uses direct process spawning without shell parsing, so arguments remain literal and cannot introduce additional shell commands.

This is a narrower interface than unsandboxed Bash, not an operating-system sandbox around the Supabase CLI process. The CLI and its descendants run with the host permissions and environment explicitly granted to the Pi process.
