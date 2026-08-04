# pi-supabase-tools

Focused Pi tools for Supabase work without granting general unsandboxed Bash.

- `supabase_cli` runs literal arguments through a configured Supabase CLI prefix.
- `deno_test` runs Edge Function tests through a permission-bounded `deno test` prefix.
- `deno_cache` performs focused import/cache preflight through a fixed `deno cache` prefix.
- `supabase_functions_serve` manages one trusted-configured, session-owned Edge Functions service.
- `/destructive-db` manages approval for recognized destructive operations.

Processes are spawned directly with `shell: false`, and timeout or cancellation terminates their process group with a bounded settlement fallback. Retained tool output is limited to the last 50 KiB and 2000 lines.

## Install locally

```bash
cd ~/Development/Repos/pi-supabase-tools
npm install
pi install ~/Development/Repos/pi-supabase-tools
```

For a one-off run:

```bash
pi -e ~/Development/Repos/pi-supabase-tools/src/index.ts
```

## Configure

Configuration is optional. Copy [`examples/supabase-tools.json`](examples/supabase-tools.json) to either:

- `~/.pi/agent/supabase-tools.json` — global defaults
- `<project>/.pi/supabase-tools.json` — trusted-project overrides

Without configuration, the package uses:

```json
{
  "commands": {
    "supabaseCli": ["npx", "supabase"],
    "denoTest": ["deno", "test"],
    "denoCache": ["deno", "cache"]
  },
  "workingDirectory": "supabase",
  "destructiveDbOps": "ask",
  "denoTestEnvironmentProfiles": {}
}
```

Command prefixes also support standalone binaries such as `/opt/homebrew/bin/supabase`. To explicitly enable the functions service lifecycle, add trusted configuration such as:

```json
{
  "functionsServe": {
    "args": ["--env-file", ".env.local"]
  }
}
```

See the [specification](doc/SPEC.md) for the complete JSON interface, merge rules, environment handling, command blocking, and Deno permissions.

## Use

```text
supabase_cli({ args: ["status"] })
supabase_cli({ args: ["db", "query", "--local", "select current_database();"] })
supabase_cli({ args: ["db", "reset", "--local"], timeout: 300 })

deno_test({ args: ["functions/example/index.test.ts"] })
deno_test({ args: ["--filter", "creates a row", "functions/example/index.test.ts"] })
deno_test({ args: ["functions/example/index.test.ts"], environmentProfile: "local-served" })

deno_cache({ args: ["functions/example/index.ts"] })
deno_cache({ args: ["--reload", "functions/example/index.ts"] })

supabase_functions_serve({ action: "start" })
supabase_functions_serve({ action: "status" })
supabase_functions_serve({ action: "stop" })
```

Local SQL should use `supabase db query --local`, not `psql` or another direct SQL client. See [Local SQL with `db query`](examples/supabase-session-prompt.md#local-sql-with-db-query) for its single-statement and connection-lifetime constraints.

Deno permission flags supplied through either Deno tool's arguments are refused. Grant required permissions only in the corresponding trusted command prefix. `deno_cache` requires at least one argument, rejects a bare `--`, and caps model-selected timeouts at 300 seconds.

Trusted configuration may define named `denoTestEnvironmentProfiles`. A profile runs the fixed internal `supabase status -o env` acquisition and maps configured source names to Deno child variable names; `deno_test` accepts only the profile name, never raw environment data. See the [specification](doc/SPEC.md#deno-test-environment-profiles).

`functionsServe` is optional and its presence explicitly enables start. Its trusted literal `args` are appended to the configured Supabase CLI prefix plus `functions serve`; the model cannot supply arguments, paths, environment, ports, signals, timeouts, PIDs, probes, or logs. Start requires a trusted project. Service output is drained privately and never returned or streamed. A running result means the Supabase listener marker was observed, not that a particular function is healthy. The lifecycle is in-memory and exclusive to one controller per project in the current Pi session; quit, reload, new, resume, and fork clean it up. SIGKILL and power-loss recovery are out of scope. Listener readiness is verified against Supabase CLI 2.111.0 and fails closed on marker changes.

Recognized destructive commands use the `ask`, `yes`, or `no` gate. Manage it with:

```text
/destructive-db [ask|yes|no|status|approve [request-id]|clear]
```

Gate state defaults to `.pi/supabase-tools-state.json`. Add that file to the consuming project's `.gitignore`.

## Security boundary

This package narrows model choice; it is not an operating-system sandbox around Supabase CLI or Deno. Configured binaries run with the host environment and permissions deliberately granted to the Pi process. Project configuration is loaded only when Pi reports the project as trusted, and invalid discovered configuration fails closed.

Profile-acquired values are replaced with `[REDACTED]` if a test repeats their exact text. This prevents accidental direct disclosure, not deliberate transformation or encoding by code that receives the values.

## Documentation

- [Specification](doc/SPEC.md)
- [Domain language](CONTEXT.md)
- [Deferred work](doc/FUTURE.md)
- [Optional Supabase session prompt](examples/supabase-session-prompt.md)
- [Example configuration](examples/supabase-tools.json)

## Development

Requires Node.js 24 or newer.

```bash
npm run check
```

## License

[MIT](LICENSE)
