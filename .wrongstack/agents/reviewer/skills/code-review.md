## Multi-recipient sends

- Apply the shared send-type validator to the `*` branch too, not only the direct-recipient branch. `assign`/`steer` to `*` throws in `packages/coordination/src/sqlite-mailbox.ts`; because `RemoteMailbox.send` (`packages/coordination/src/remote-mailbox.ts`) goes over the IPC socket, the server’s `ok: false` response rejects the client promise. For each `mb.send(` call site on that send path, require `try/catch`; unguarded branches surface a raw IPC error instead of a validation message.

## HQ sync change detection

- Before judging a metadata strip list in `packages/sage/src/sqlite-store-hq-sync.ts`, confirm whether `changed()` strips `$.updatedAt`. `applySemanticChange` (`packages/sage/src/shared/semantic-rewrite.ts`) always bumps `updatedAt`, so those edits still satisfy `changed(new) IS NOT changed(old)` and replicate. Stripping matters only on raw SQL paths that mutate `data` without `updatedAt` — for example `stampSqliteVerification` in `packages/sage/src/sqlite-store-verification-stamp.ts`. Do not report it as suppressing legitimate replication.
