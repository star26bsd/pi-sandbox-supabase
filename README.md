# pi-sandbox-supabase

A focused Pi session should not need unsandboxed Bash merely to operate Supabase. This extension lets a visible, named Supabase session keep general shell execution disabled or sandboxed while granting host execution only through focused Supabase tools.

> **Related**: [carderne/pi-sandbox](https://github.com/carderne/pi-sandbox) — general-purpose sandbox extension for pi

## What it provides

- **`supabase_bash` tool** — spawns `npx supabase` commands outside pi's sandbox, using `child_process.spawn` with `shell: false` for injection-safe argument passing; automatically appends `--agent yes`, and appends `--yes` to destructive commands after project-level gating
- **`/destructive-db` slash command** — manage destructive-operation modes (`yes`/`no`/`ask`) and approve pending operations; approval queues a follow-up so the active agent can continue without an extra manual “proceed”
- **File-backed destructive-operations gate** — all destructive commands (`db reset`, `stop`, `declarative sync --apply`) are gated through a state machine persisted to disk, so focused sessions share the same gate state
- **Status bar indicator** — shows current DB mode (e.g. `DB: ask (2 pending)`)

## Installation

### Option A: Project-local (recommended)

1. Copy the extension into your project:

```bash
cp -r pi-sandbox-supabase/ .pi/extensions/supabase-bash/
```

Or install via git:

```bash
cd your-project
pi install git:github.com/star26bsd/pi-sandbox-supabase
```

2. Install dependencies:

```bash
cd .pi/extensions/supabase-bash/
npm install
```

3. Reload pi (`/reload`) or restart. You should see `DB: ask` in the status bar.

### Option B: Global (available in all projects)

```bash
pi install git:github.com/star26bsd/pi-sandbox-supabase --global
```

### Option C: No install (one-shot test)

```bash
pi -e ./pi-sandbox-supabase/src/index.ts
```

## Configuration

### Extension options

Pass configuration when importing the extension. All options are optional with sensible defaults:

```typescript
// In your wrapper extension or custom setup:
import supabaseBash from "pi-sandbox-supabase";

export default function (pi: ExtensionAPI) {
  supabaseBash(pi, {
    // Where to execute npx supabase commands (relative to project root)
    supabaseDir: "supabase/",              // default

    // Path to the destructive-ops state file (relative to supabaseDir)
    stateFile: ".pi/supabase-bash-state.json", // default

    // Default command timeout in seconds
    defaultTimeout: 120,                    // default

    // Binary to invoke (default: "npx")
    npxBin: "npx",

    // Supabase subcommand (default: "supabase")
    supabaseCmd: "supabase",

    // Custom destructive pattern detectors (built-in patterns: db reset, stop, declarative sync --apply)
    customDestructivePatterns: [
      (args) => args.includes("--force"),
    ],
  });
}
```

### Configuring destructive-ops mode via sandbox.json

Set the initial mode in `.pi/sandbox.json`:

```json
{
  "destructiveDbOps": "ask"
}
```

Valid values: `"ask"` (default), `"yes"`, `"no"`.

## Usage

### The `supabase_bash` tool

The agent can call `supabase_bash` with an `args` array and optional `timeout`:

```
supabase_bash({ args: ["status"] })
supabase_bash({ args: ["db", "schema", "declarative", "sync", "--help"] })
supabase_bash({ args: ["db", "reset", "--local"], timeout: 300 })
```

### The `/destructive-db` command

```
/destructive-db              # Toggle mode via selector
/destructive-db yes          # Allow all destructive commands
/destructive-db no           # Block all destructive commands
/destructive-db ask          # Require approval (default)
/destructive-db status       # Show current state
/destructive-db approve      # Approve oldest pending request and queue agent follow-up
/destructive-db approve <id> # Approve specific request and queue agent follow-up
/destructive-db clear        # Clear all pending requests and approvals
```

### Destructive operations gate

Commands that trigger the gate:

| Command | Pattern |
|---------|---------|
| `npx supabase db reset` | `db reset` (any args) |
| `npx supabase stop` | `stop` |
| `npx supabase db schema declarative sync ... --apply` | `declarative sync --apply` |

**In `ask` mode:**
1. Agent tries to run a destructive command
2. Tool returns `action: "approval_required"` with a `requestId` and `parentQuestion`
3. You run `/destructive-db approve <requestId>` (or just `/destructive-db approve`)
4. The slash command queues a follow-up telling the active agent to rerun the approved command
5. Agent re-runs the command — it proceeds

**In `yes` mode:** destructive commands run immediately.

**In `no` mode:** destructive commands are blocked unconditionally.

## State file

Runtime state is stored at `.pi/supabase-bash-state.json` relative to the configured `supabaseDir`. The file tracks:

```json
{
  "mode": "ask",
  "pendingRequests": [
    {
      "id": "abc123",
      "command": "db reset",
      "args": ["db", "reset"],
      "createdTstamp": "2025-01-01T00:00:00.000Z",
      "parentQuestion": "I need authorization to run `npx supabase db reset`. ..."
    }
  ],
  "approvals": [
    {
      "id": "def456",
      "command": "stop",
      "args": ["stop"],
      "approvedTstamp": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

This file is safe to commit — it stores runtime approval state, not secrets.

## Security

- **Injection-safe**: Uses `child_process.spawn` with `shell: false`. Each argument is a literal value — no shell parsing, no quoting surface, no command injection.
- **Binary/subcommand are configurable but not derivable from LLM input**: The `npx` and `supabase` prefix is set at extension config time, not from tool arguments.
- **Destructive-ops gate**: Can be set to `ask` (default) or `no` to prevent unexpected destructive DB operations.
- **Session-independent**: The package does not prescribe orchestration or automatically load a role prompt. Users decide which visible, named sessions receive its tools through Pi's tool allowlist.

## Testing

```bash
npm test
# or directly:
node --import tsx --test src/test/*.test.ts
```

Tests cover:
- Spawn argument construction and injection safety
- Destructive pattern detection
- State file CRUD and validation
- File-backed mode enforcement (all three modes)
- Approval lifecycle (create, reuse, consume)
- Config reading and status formatting

## Requirements

- Node.js >= 24
- pi coding agent
- Supabase CLI (available via `npx`)
- Docker (for local Supabase operations)

## License

MIT
