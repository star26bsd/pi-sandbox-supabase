# pi-supabase-tools

Focused Pi tools for Supabase work without granting general unsandboxed Bash.

- `supabase_cli` runs literal arguments through a configured Supabase CLI prefix.
- `deno_test` runs Edge Function tests through a permission-bounded `deno test` prefix.
- `/destructive-db` manages approval for recognized destructive operations.

Processes are spawned directly with `shell: false`.

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
    "denoTest": ["deno", "test"]
  },
  "workingDirectory": "supabase",
  "destructiveDbOps": "ask"
}
```

Command prefixes also support standalone binaries such as `/opt/homebrew/bin/supabase`. See the [specification](doc/SPEC.md) for the complete JSON interface, merge rules, environment handling, command blocking, and Deno permissions.

## Use

```text
supabase_cli({ args: ["status"] })
supabase_cli({ args: ["db", "query", "--local", "select current_database();"] })
supabase_cli({ args: ["db", "reset", "--local"], timeout: 300 })

deno_test({ args: ["functions/example/index.test.ts"] })
deno_test({ args: ["--filter", "creates a row", "functions/example/index.test.ts"] })
```

Local SQL should use `supabase db query --local`, not `psql` or another direct SQL client.

Deno permission flags supplied through tool arguments are refused. Grant required permissions only in the trusted `commands.denoTest` prefix.

Recognized destructive commands use the `ask`, `yes`, or `no` gate. Manage it with:

```text
/destructive-db [ask|yes|no|status|approve [request-id]|clear]
```

Gate state defaults to `.pi/supabase-tools-state.json`. Add that file to the consuming project's `.gitignore`.

## Security boundary

This package narrows model choice; it is not an operating-system sandbox around Supabase CLI or Deno. Configured binaries run with the host environment and permissions deliberately granted to the Pi process. Project configuration is loaded only when Pi reports the project as trusted, and invalid discovered configuration fails closed.

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
