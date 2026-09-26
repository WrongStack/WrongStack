## Chimera — project addendum (reviewer)

### Trust the file on disk, not the diff
- Resolve every finding against `read`/`grep` of the live file, never the diff hunk, and cite the live line number. An in-session `file.external.edit` can land a half-applied refactor between diff capture and review — when annotations disagree with the file (e.g. `string[]` vs `KanbanLifecycleValidationIssue[]`), trust the disk and flag the divergence.

### Generated artifacts
- Before judging a ratchet-baseline field (`architecture/hotspots.json`), read the generator (`collectModuleSpecifiers` in `scripts/lib/architecture-health.mjs`) to learn every counted form. `relativeImports` covers `from './x'`, `import './x.css'`, `import('./x')`, `require()`, and `import x = require()`, so 6 static imports can legitimately record 20. Never infer the metric by grepping the artifact.

### Threaded wiring
- Grep the whole repo for every newly-threaded identifier — and its production call site — before accepting it. Declared, destructured, and passed but never invoked, with no caller supplying it, is dead wiring that silently voids the documented contract (`persistEvidence` in `packages/cli/src/execution-chimera-cascade.ts`).
- Grep the *consumed* identifier independently of the collected one. A hunk adding both `agentEvidence` and `claimedEvidence: accumulatedEvidence` may name a phantom verified result — never declared because the `verify...` runner step was never added.
- When extracting a shared helper (`classifyChimeraReviewSource` in `packages/core/src/plugins/review-finding-integration.ts`), confirm each call site passes the declared parameter shape (`ReviewContextBundle` vs `ChimeraReviewCompletePayload`): finding/report integrations pass `payload.bundle`; sibling consumers already holding the bare bundle (`packages/cli/src/execution-chimera-review.ts`) pass it directly.

### TUI type narrowing (`packages/tui/src/**`)
- Reject any `array[index] as T`; trace the array element type and the downstream consumer, then require a guard or direct typed access. `THEME_OPTIONS` in `packages/tui/src/theme.ts` is `ThemePickerOption[]`, so consumers read `?.id`; a cast lets an object slip into primitive sinks like `setActiveTheme`.
- Review a reducer's `selected` index and its Enter/confirm consumer as one contract, even when only the reducer is in the diff: element type, field shape, no bridging cast — request the fix in the consumer or both files, not just the reducer.
