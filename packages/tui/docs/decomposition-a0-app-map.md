# TUI Phase 4 — A0 Dependency Map of `app.tsx`

Companion to `decomposition-plan.md` (Phases, D1–D4, behavior contract) and
`decomposition-remaining-work.md` (recipes). Recorded 2026-09-10 from a full read of the
current file (1,059 lines; `App` spans L98–1058). Line numbers are dated — re-read regions
before editing (contract §0.6).

## Method

Full body read; every hook call inventoried (72 call-sites, ~40 distinct hooks: 5 inline
React primitives + 67 custom-hook call-sites from `src/hooks/*` plus ink's `useApp`/
`useStdout`). Membership below assigns each to one of the eight D2-approved facades.
`tsc --noEmit` is the final arbiter of membership during A1–A8: a facade extraction is
correct when the remaining `App` body still typechecks with the hook's products flowing
through the facade's return object.

## Facade membership (hook → line → produces)

### useAppState (state + dispatch + derived state) — A1 (with useAppRefSpine)

| Line | Hook / fn | Produces |
|---|---|---|
| 248 | `useAppSessionState(...)` | `state`, `dispatch`, `layoutStore` |
| 268 | `todosForScreen(...)` (pure) | `liveTodos` |
| 662 | `useSettingsAutoSave(...)` | — (state→settings persistence effect) |
| 995 | `deriveAppViewState(...)` (pure) | `viewState` |

### useAppRefSpine (all refs, created once) — A1 (with useAppState)

| Line | Hook / fn | Produces |
|---|---|---|
| 346 | `useAppRuntimeRefs(...)` | `promptUsageRef, builderRef, activeCtrlRef, eternalLoopRunningRef, parallelLoopRunningRef, activeRunSettledRef, exitRequestedRef, inputGateRef, lastEnterAtRef, tokenPreviewsRef, streamingTextRef, streamSegmentsRef, pendingDeltaRef, flushTimerRef, sessionGenerationRef, activeRunGenerationRef, assistantCommittedThisRunRef, stateRef, draftRef, runBlocksRef, lastEscAtRef, dismissedEscAtRef, submitRef` (20) |
| 269 | `useRef` | `historyScrollRef` |
| 241 | `useRef` ×2 | `linesRef`, `densitiesRef` |
| 503 | `useRef` | `statusBarClickMapRef` |
| 713 | `useEnhanceRuntimeState(...)` | `enhanceEnabledRef, midRunSendPickerRef, enhanceAbortRef, enhanceCancelledRef, enhanceOriginalRef` + `enhanceCountdown/StartedAt/DurationMs` state + `refineProviderId/refineModel` |
| 734 | `usePasteHandling(...)` | `pasteAccumRef, pasteFlushTimerRef, commitPaste, pasteClipboardImage, pasteClipboardText` |

### useAppEnvironment (theme, env state, layout, syncs) — A2

| Line | Hook / fn | Produces |
|---|---|---|
| 193–194 | `useActiveTheme`, `useThemeState` | — |
| 196 | `useTuiEnvironmentState(...)` | `environment` (liveModel/liveProvider/activeMaxContext/yoloLive/autonomyLive/liveModeLabel/hiddenItems/lines/densities + setters + hiddenItemsRef/memoryContextMonitorRef/memoryRecordTotalRef/setSessionCount/setLiveToolCount) |
| 241–244 | `useRef` mirrors | `linesRef`, `densitiesRef` (mirror `environment.lines/densities`) |
| 382 | `React.useMemo` | `projectName` |
| 387 | `useWorkingDirChip(...)` | `workingDirChip` |
| 389 | `useLiveSettingsState(...)` | `liveSettings, liveStatuslineMode, liveAnimationStyle, liveThinkingWord, chimeRef, confirmExitRef` |
| 401 | `resolveAppSidebarLayout(...)` (pure) | `sidebarLayout` |
| 408 | `useEffect` | title model sync |
| 488 | `useMouseTracking(...)` | `mouseMode, setMouseMode, nativeMouse, setNativeMouse` |
| 496 | `useHistoryViewportSync(...)` | `bottomRegionRef, statusBarWrapRef, belowStatusBarRef, termRows, statusBarRows` |
| 538 | `useStatusSyncInterval(...)` | — |
| 559 | `useGitSessionStatus(...)` | `gitInfo` |
| 319 | `useStatuslineHiddenSync(...)` | — |
| 326 | `useStatuslineLayoutSync(...)` | — |
| 337 | `useStreamChipExpiration(...)` | — |
| 662 | `useSettingsAutoSave` (alt home: session; environment chosen — settings domain) | — |

### useAppSession (todos, history, interrupts, rewind, exit) — A3

| Line | Hook / fn | Produces |
|---|---|---|
| 247 | `useLiveTodos(...)` | `sessionTodos` |
| 269–274 | `useRef` + `useCallback` | `historyScrollRef`, `onScrollInfo` |
| 275 | `useHistoryAutoScroll(...)` | `onHistoryScrollActivity` |
| 279 | `useHistoryArchive(...)` | `onRequestOlderEntries` |
| 285 | `useHistoryCopyNotice(...)` | `onHistoryCopy` |
| 288 | `useInputHistoryPersistence(...)` | — |
| 505 | `useSessionRewind(...)` | `handleRewindTo` |
| 759–764 | `useCallback` ×2 | `getActiveSessionId`, `getLeaderTranscript` |
| 787 | `useSessionInterruptController(...)` | — |
| 809 | `useExitCommand(...)` | — |
| 869 | `useInterruptLadder(...)` | `interruptsSyncRef`, `runInterruptLadder` |
| 993 | `useInitialPrompt(...)` | — |

### useAppBridges (event bridges + telemetry + cross-system VMs) — A4

| Line | Hook / fn | Produces |
|---|---|---|
| 344 | `useAutonomousCoordinator(...)` | — |
| 372 | `useBugHuntLoop(...)` | `bugHuntLoop` |
| 398 | `useMailboxViewModel(...)` | `mailbox` (feeds sidebar layout + slash bag) |
| 561 | `useTokenCounterRefresh(...)` | `tokenRefresh` |
| 688 | `useProviderEventBridge(...)` | — |
| 702 | `useClientTelemetry(...)` | — |
| 766 | `useTuiEventBridge(...)` | — |
| 819 | `useDirectorFleetBridge(...)` | — |

### useAppPanels (openable surfaces + their pickers) — A5

| Line | Hook / fn | Produces |
|---|---|---|
| 286 | `useKanbanBoardFocus(...)` | `focusedBoardId, setFocusedBoardId, boardFocusRef` |
| 294 | `usePromptPicker(...)` | `openPromptPicker, setPromptFavorite` |
| 295 | `useModePicker(...)` | `openModePicker` |
| 297 | `useModelPickRequest(...)` | `requestModelPick, handleModelPicked` |
| 302–315 | `useBrainPanel`, `useBrainRiskSync`, `useShadowPanel` | `brainCtl/openBrainPanel`, `changeBrainRisk`, `openShadowPanel/handleShadowStart/handleShadowStop` |
| 317 | `useHelpPanel(...)` | `openHelpPanel` |
| 444–462 | `useAuthPanel(...)` + secret-controller swap `useEffect` | `authPanelController` |
| 464–486 | `useCallback` ×2 | `statuslineHiddenForPicker`, `openStatuslinePicker` |
| 585 | `useCoreTuiCommands(...)` | `getCronJobs`, `runSteerSequence` |
| 606 | `usePanelControllers(...)` | `openModelPicker, openProjectPicker, openFKeyPicker, loadLiveSessions, openSettings` |
| 827 | `useFileSearch(...)` | `onPickerEnter` |
| 837 | `useThemePickerHandler(...)` | `onThemePickerEnter` |
| 844 | `useAppPickerKeys(...)` | `tryPickerKey` (aggregates: `host: props`, state/dispatch/environment/statusbar/panelControllers/authPanelController/brainCtl + refs + composer fns) |
| 748 | `useQueueManager(...)` (alt home: composer; panels chosen — queue panel + `/queue`) | — |

### useAppComposer (draft + composer-side helpers) — A6

| Line | Hook / fn | Produces |
|---|---|---|
| 513–521 | plain fns | `setDraft`, `clearDraft` |
| 578 | `useSlashPicker(...)` | `acceptSlashPickerSelection` |

(`setDraft`/`clearDraft` are consumed by composer routes via the key-handler pipeline AND
by panels hooks (`useAppPickerKeys`, `useFileSearch`, `useSlashPicker`) — they are returned
from the facade and passed down; no hook re-creation.)

### useAppExecution (activity, pipeline, app-pipeline bag) — A7 (LAST)

| Line | Hook / fn | Produces |
|---|---|---|
| 412 | `useTuiActivity(...)` | `activity` (`displayThinkingWord`, `refreshGoalSummary`) — note: feeds AppView + `useAutonomyDrivers` |
| 426–442 | `useCallback` ×2 | `liveDirector`, `clearPendingConfirms` |
| 523 | `useAutonomyDrivers(...)` | `runEternalLoopRef, runParallelLoopRef` |
| 888–991 | `buildAppPipelineArgs(...)` + `useAppExecutionPipeline(...)` | `stableOnKey` (the ~100-field bag: consumes products of EVERY other facade) |

## Cross-facade ordering constraints (drives A1–A8 sequence)

1. `useAppRuntimeRefs` (ref spine) is consumed by nearly every later hook → **A1 first**.
2. `environment` feeds `useMouseTracking` (overlayOpen via sidebarLayout) and
   `useAppPickerKeys` → **environment (A2) before panels**.
3. `sidebarLayout` depends on `mailbox` (bridges) + `liveSettings` (environment) → bridges
   before layout consumers.
4. `pipelineArgs` consumes: refs (A1), environment setters (A2), `runInterruptLadder` +
   `handleRewindTo` + history fns (A3), `bugHuntLoop` + `runSteerSequence` (A4/A5),
   `openProjectPicker/loadLiveSessions/openStatuslinePicker/openModelPicker` (A5),
   `setDraft/clearDraft` (A6), `tryPickerKey` (A5), `acceptSlashPickerSelection` (A6),
   `pasteClipboard*` + `commitPaste` (A1 paste refs) → **execution (A7) must be LAST**.
5. `useAppPickerKeys` (A5) consumes `tryPickerKey` inputs from A2 (environment),
   A3 (refs), A5 siblings (panelControllers, auth/brain controllers), A6 (setDraft,
   acceptSlashPickerSelection) → panels extraction needs composer's `setDraft` first or
   takes it via parameter — **composer (A6) before panels (A5) in call order is NOT
   required** (hooks are called unconditionally in fixed order; facade *extraction* order
   is what matters, not call order).

**Revised A1–A7 sequence** (supersedes the plan's provisional A1–A8 order; the plan's
A1 was "state + ref spine" as one commit — kept):

- A1: `useAppState` + `useAppRefSpine` (+ `usePasteHandling`, `useEnhanceRuntimeState`
  stay in ref spine — they are ref factories)
- A2: `useAppEnvironment`
- A3: `useAppSession`
- A4: `useAppBridges`
- A5: `useAppPanels`
- A6: `useAppComposer`
- A7: `useAppExecution` (`buildAppPipelineArgs` + pipeline + activity + autonomy drivers)

Each: one fenced commit, gate = biome + `tsc --noEmit` (both projects) + full tui suite;
Phase 0 freeze tests untouched and green. Final `App` target: composition only, ≤ ~250 lines.

## Known stale references (do NOT trust these line numbers)

- SAGE memories citing `app.tsx:1371`, `:4357`, `:5744`, `:5804-5837`, `:6533` predate the
  decomposition-era shrink to 1,059 lines; their durable content (slash echo as invocation
  record, safeDispatch allow-list history, mid-run picker Esc-restore) remains valid, the
  anchors do not. Superseding warning recorded in SAGE at A0 recording time.
- `docs/decomposition-plan.md` header line counts are self-declared perishable.
