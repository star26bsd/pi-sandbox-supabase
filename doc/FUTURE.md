# Future Work

This file records deferred candidates, not commitments for the first usable `pi-supabase-tools` release.

## Package distribution

- Publish `pi-supabase-tools` to npm.
- Add the `pi-package` keyword for automatic inclusion in the Pi package gallery.
- Retain GitHub/git installation as an alternative.
- Add optional gallery image or video metadata.

## Pi package conformance

- Move Pi-provided imports such as `typebox` and `@earendil-works/pi-coding-agent` to `peerDependencies` as required by Pi package guidance.
- Audit tool errors against Pi's throw-to-signal-error contract.
- Apply Pi's 50KB/2000-line output truncation contract and preserve full output in temporary files.
- Audit timeout and cancellation handling for complete process-tree cleanup on every supported platform.
- Validate interactive, print, JSON, and RPC mode behavior.

## Distribution verification

- Add clean-install smoke tests for npm and git package sources.
- Add macOS, Linux, and WSL2 verification coverage.
- Document the process for renaming or transferring the GitHub repository.
