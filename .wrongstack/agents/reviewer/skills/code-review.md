## TUI error boundary and exit reachability (proven)

- When reviewing `packages/tui/src/run-tui.ts`, do not flag `AppErrorBoundary` (`packages/tui/src/components/app-error-boundary.tsx`) as trapping the session: the raw-stdin Ctrl+C watcher armed in `mountInkApp` and `exits.setInkInstance` run below React, so the Ink-wide boundary leaves the process exit-reachable. Confirm that ordering before raising any exit-path finding.
- In the same diff, verify the `appElement: React.ReactElement` contract in `packages/tui/src/run-tui-mount.ts` and check every consumer of a renamed element — not just the declaration site.

## Multi-recipient sends

- Require the shared send-type validator on the `*` branch, not only the direct-recipient branch: `assign`/`steer` to `*` throws in `packages/coordination/src/sqlite-mailbox.ts`.
- Because `RemoteMailbox.send` (`packages/coordination/src/remote-mailbox.ts`) crosses the IPC socket, the server's `ok: false` rejects the client promise. Require `try/catch` at every `mb.send(` call site on that path; unguarded branches leak a raw IPC error instead of a validation message.

## HQ sync change detection

- Before judging a metadata strip list in `packages/sage/src/sqlite-store-hq-sync.ts`, check whether `changed()` strips `$.updatedAt`. `applySemanticChange` (`packages/sage/src/shared/semantic-rewrite.ts`) always bumps `updatedAt`, so those edits still satisfy `changed(new) IS NOT changed(old)` and replicate — do not report the strip as suppressing legitimate replication.
- Limit strip-related findings to raw SQL paths that mutate `data` without `updatedAt`, e.g. `stampSqliteVerification` in `packages/sage/src/sqlite-store-verification-stamp.ts`.
