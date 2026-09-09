## Audit-Log Role: Learned Practices

### Memory-Boundedness Audits

- Treat a module-scope `Map` or `Set` in a long-lived host process as bounded only when there is a delete or eviction path during steady-state operation; a shutdown-only clear is a retention risk.
- Audit systematically by mapping cleanup patterns, including close handlers, age sweeps, splice caps, and explicit helpers such as `evictOldest` in `packages/cli/src/hq-server/`.
- For `packages/webui/` frontend state, every `Map`-backed suppression, echo, or coalescer needs a TTL sweep, per-key array cap, or reconnect-time prune; deletion only on consume is insufficient.
- Before closing an item, verify the chosen eviction mechanism is actually wired in, not merely present as an unused helper.

### Audit Reporting Conventions

- Tie every retention claim to a named code site and, when possible, a named cleanup function or event handler so future audits can grep for it.
- Distinguish steady-state eviction from shutdown-only clear; they are different risk profiles and should not be reported with the same verdict.
- Prefer concrete evidence such as file path plus function or event name over prose descriptions of behavior.

### React-owned Slash Command Verification

- Test React-owned slash command registration against the registry’s actual collision and teardown semantics, not only through factory tests.
- Cover pre-registering a canonical command, effect cleanup and rerender, bare UI forms, and typed fallback forms.
- Use lifecycle tests anchored in `packages/tui/src/hooks/use-core-tui-commands.ts` and `packages/tui/src/hooks/use-tui-slash-commands.ts`; factory-only tests can miss stale closures, ignored same-owner registrations, and lost canonical handlers.