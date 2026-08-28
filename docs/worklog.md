# Session Worklog

> Per-session operations log requested via WebUI mail (2026-08-28): record which
> session/agent used which provider+model, what failed, what was blocked, and
> what was resolved. **Append newest entries first**, one `## <date> — <title>`
> block per work arc. Keep entries factual: exact paths, symbols, commands,
> error lines, and test counts. Write "not recorded" rather than guessing —
> this log is only useful if it can be trusted.

---

## 2026-08-28 — Model-aware per-session reasoning effort (WebUI + TUI parity)

- **Session/agent**: leader@ee4e0b31 (WrongStack leader agent, CLI session).
  Fleet peers spawned during the arc: Explore Companion, fleet helper (explore),
  Critic, chimera-review — spawned on `glm-5.3-flash` per fleet broadcasts.
- **Provider/model**: triggering incident model supported `low, high, max`
  (per the warning below). Exact provider/model ids used by this leader
  session: **not recorded** by the runtime in-context. Fleet helpers:
  `glm-5.3-flash` (broadcast).
- **Status**: done (WebUI + TUI + tests). Uncommitted working tree at close —
  left for the author per the leader's commit-guard convention.

### Trigger

```
2026-08-28T10:13:39.026Z WARN model-runtime: reasoning effort "medium" not
supported by this model (supported: low, high, max); the setting was omitted.
```

Root cause chain: `resolveReasoningForRequest`
(`packages/core/src/execution/model-runtime.ts`) omits effort when
`effortSupported === true` and the configured effort is not in
`rc.effortLevels` — correct resolver behavior; the gap was UI: no model-aware
options, no per-session control surface.

### What was built

1. **WebUI** — per-session effort already existed end-to-end
   (`SESSION_SCOPED_PREFS` client + `SESSION_SCOPED_PREF_KEYS` server, applied
   per conversation by `withConversationReasoning` in core model-runtime).
   Added the missing UX: shared helper `packages/webui/src/lib/reasoning-effort.ts`
   (`resolveEffortOptions`, `effortNotAdvertised`, `EFFORT_LABEL_KEYS`), effort
   select in the Ctrl/Cmd+M QuickModelSwitcher modal with unsupported-effort
   hint, `ModelEffortSelect` next to the model list in Settings, AgentSettingsTab
   refactored onto the helper, new i18n key `reasoningEffortUnsupported` in all
   7 locales.
2. **WebUI switcher data**: `provider.models` payload now carries per-model
   `reasoningEffortLevels` (from the registry-normalized catalog
   `reasoningConfig` — no extra lookups); switcher rows show an effort badge
   and seed `setEnv({ reasoningEffortLevels })` on switch so options narrow
   before the next snapshot.
3. **Decision (placement)**: model selector moved from the chat header
   (was `hidden sm:flex`, invisible on mobile) into the composer row next to
   the prompt-library button; header chip and its `provider`/`model` props
   removed (single entry point: chip → Ctrl/Cmd+M switcher).
4. **TUI parity**: `/settings` field 24 (reasoning effort) cycles only the
   active model's documented vocabulary. Levels are host-injected via
   `getActiveModelReasoningEffortLevels()` built in
   `packages/cli/src/wiring/cli-execute-builder.ts` from `activeReasoningConfig`
   (sync, same freshness contract as `getEnhancerReasoning`), threaded through
   execute-deps → runtime-controller-deps → execution → run-tui-options →
   run-tui → AppProps → usePanelControllers, dispatched inside the existing
   `settingsOpen` action. Row detail shows `documented for this model: …`.

### Failed (what actually broke, and the fix)

- `test` tool could not spawn vitest (`ENOENT`) → run suites via
  `pnpm --filter <pkg> exec vitest run <files>` instead.
- `quick-model-switcher.test.tsx`: 4 failures — the new effort `<select>` made
  `getByRole('combobox')` ambiguous → scoped assertions by accessible name
  (`{ name: 'Provider' }`).
- TUI narrowing test: first expectations assumed the desync value appends to
  the cycle tail; the implementation keeps canonical order and the
  unadvertised value participates only while current (same recomputed-options
  semantics as WebUI) → test walk corrected, backwards-step assertion proves
  the desync slot.
- Chimera HIGH on `RuntimeControllerDepsInput`: new resolver was declared
  required, breaking the existing test-literal call (TS2741) → made optional,
  mirroring `ControllerDeps`.
- **Silent wiring drop (the dangerous one)**: first pass missed the
  `execution.ts` re-listing. That file force-casts the run-tui options
  (`as never as RunTuiOptions`), so the omitted optional field was type-silent
  and the TUI control would have been dead at runtime. Caught by self-audit
  against the known `installStorageObservability` anti-pattern; both ends
  (destructure + assembly) now list the field explicitly.

### Blocked / open

- Nothing blocked this arc. Attributed to peer workstreams (not ours to fix):
  - `provider-runtime-setup.ts` + `core/src/storage/memory-curator.ts`
    (peer WIP): chimera Mediums — `memoryCurator` gate nesting contradicts the
    doc comment; `memory-curator.md` names nonexistent tools
    (`view_file`/`grep_search`).
  - Explorer agents reported phantom `[REDACTED:json_credential_key]`
    placeholders in locale JSONs — verified **nonexistent** in working tree and
    HEAD (`rg` + `git grep`); the redaction happened in the agents' own
    file-read layer, not the files.

### Evidence

- Typecheck: `packages/tui`, `packages/cli`, `packages/webui`,
  `packages/webui-server` — all 0 errors.
- WebUI: targeted 97/97; full suite 389 files / 5817 tests green (post-chip-move).
- WebUI-server: full suite 181 files / 2086 tests green.
- TUI: `tests/reducer.test.ts` + `tests/settings-value-set.test.ts` 160/160
  (incl. new field-24 narrowing test).
- Lint (biome): clean on every touched file; i18n catalogs parse and carry the
  new key in all 7 locales.
- Chimera reviews of the changed surfaces: all clear (one real HIGH found and
  fixed mid-arc, see above).
