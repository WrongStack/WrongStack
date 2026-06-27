import { expectDefined, projectSlug } from '@wrongstack/core';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import type {
  Agent,
  AttachmentStore,
  ContentBlock,
  CoordinatorEvent,
  Director,
  EventBus,
  Message,
  QueueStore,
  SlashCommandRegistry,
  TokenCounter,
  TokenSavingTier,
} from '@wrongstack/core';
import { type AutonomyStage, DefaultSessionRewinder } from '@wrongstack/core';
import { loadGoal, resolveWstackPaths } from '@wrongstack/core';
import { clearActiveKit, clearPersistedActiveKit, getDesignKitLoader, isDesignStack, setActiveKit } from '@wrongstack/core';
import { InputBuilder, buildGoalPreamble, formatTodosList, writeOut } from '@wrongstack/core';
import { enhanceUserPrompt, normalizedEqual, recentTextTurns, shouldEnhance } from '@wrongstack/core';
import { type VisionAdapters, routeImagesForModel } from '@wrongstack/runtime/vision';
import { getProcessRegistry, getIndexState, onIndexStateChange } from '@wrongstack/tools';
import { Box, type DOMElement, Text, measureElement, useApp, useStdout } from './ink.js';
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { readClipboardImage, readClipboardText } from './clipboard.js';
import { AgentsMonitor } from './components/agents-monitor.js';
import { AUTONOMY_OPTIONS, AutonomyPicker } from './components/autonomy-picker.js';
import { DesignPicker } from './components/design-picker.js';
import { BrainDecisionPrompt } from './components/brain-decision-prompt.js';
import { CheckpointTimeline } from './components/checkpoint-timeline.js';
import { type ConfirmDecision, ConfirmPrompt } from './components/confirm-prompt.js';
import { EnhancePanel } from './components/enhance-panel.js';
import { EscConfirmPrompt } from './components/esc-confirm-prompt.js';
import { FilePicker } from './components/file-picker.js';
import { FleetMonitor } from './components/fleet-monitor.js';
import { FleetPanel } from './components/fleet-panel.js';
import { FKeyPicker, F_KEY_ENTRIES } from './components/f-key-picker.js';
import { actionForFKeyPanel } from './f-key-panels.js';
import { MailboxPanel } from './components/mailbox-panel.js';
import { HelpOverlay } from './components/help-overlay.js';
import { History, type HistoryEntry } from './components/history.js';
import { ScrollableHistory, scrollOffsetForTrackRow } from './components/scrollable-history.js';
import { startHeapWatchdog } from './heap-watchdog.js';
import { hitRegion, statusBarLineRow } from './hit-test.js';
import { Input, type KeyEvent } from './components/input.js';
import { ModelPicker, type ProviderOption } from './components/model-picker.js';
import { PhaseMonitor } from './components/phase-monitor.js';
import { SddBoardOverlay } from './components/sdd-board-overlay.js';
import { PhasePanel } from './components/phase-panel.js';
import { ProjectPicker } from './components/project-picker.js';
import { QueuePanel } from './components/queue-panel.js';
import { ProcessListMonitor } from './components/process-list.js';
import { GoalPanel } from './components/goal-panel.js';
import { PlanPanel } from './components/plan-panel.js';
import { CoordinatorPanel } from './components/coordinator-panel.js';
import { ResumePicker } from './components/resume-picker.js';
import { SessionsPanel } from './components/sessions-panel.js';
import {
  SettingsPicker,
  THINKING_WORD_FIELD,
  getSettingsFieldValue,
  formatAllSettingsSummary,
  resetSettingsFieldValue,
  resolveSettingsFieldValue,
  settingsPickerJumpByName,
  settingsPickerJumpField,
  settingsPickerJumpNames,
  type ContextMode,
  type StatuslineMode,
} from './components/settings-picker.js';
import { StatuslinePicker, STATUSLINE_ITEMS, isChipExpired, type StatuslineItem } from './components/statusline-picker.js';
import { SlashMenu } from './components/slash-menu.js';
import { KeyHintBar, type KeyHintContext } from './components/key-hint-bar.js';
import {
  COMPACT_THRESHOLD,
  StatusBar,
  statusBarAutonomySpan,
  statusBarModelSpan,
  statusBarTodosSpan,
  type MailboxStatus,
} from './components/status-bar.js';
import { TodosMonitor } from './components/todos-monitor.js';
import { WorktreeMonitor } from './components/worktree-monitor.js';
import { WorktreePanel } from './components/worktree-panel.js';
import { searchFiles } from './file-search.js';
import { type GitInfo, readGitInfo } from './git-info.js';
import { useDirectorFleetBridge } from './hooks/use-director-fleet-bridge.js';
import { useAutonomousCoordinator } from './hooks/use-autonomous-coordinator.js';
import { useStatuslineState } from './hooks/use-statusline-state.js';
import { useTuiControllers } from './hooks/use-tui-controllers.js';
import { useTuiEventBridge } from './hooks/use-tui-event-bridge.js';
import {
  INLINE_TOKEN_SRC,
  deleteTokenBackward,
  inputIndexAtRowCol,
  layoutInputRows,
  tokenLengthForward,
  tokenSpanAt,
} from './input-tokens.js';
import { createKillSlashCommand } from './kill-slash.js';
import { MOUSE_CLICK_ON, MOUSE_OFF } from './mouse.js';
import { feedPaste } from './paste-accumulator.js';
import { createPsSlashCommand } from './ps-slash.js';
import { createQueueSlashCommand } from './queue-slash.js';
import { buildSlashCommandMatches } from './slash-command-search.js';
import { buildSteeringPreamble } from './steering-preamble.js';
import { isRandomTuiThinkingWord, pickRandomTuiThinkingWord } from './thinking-word.js';

// Types imported from app-reducer.ts (single source of truth for reducer + State types)
import {
  type FleetEntry,
  type ResumeSessionEntry,
  type Settings,
  type SlashCommandMatch,
  type State,
  reducer,
} from './app-reducer.js';
export {
  reducer,
  type Action,
  type FleetEntry,
  type QueueItem,
  type ResumeSessionEntry,
  type Settings,
  type SlashCommandMatch,
  type State,
} from './app-reducer.js';

/** Input prompt — mirrors the <Input> default so click-to-position-cursor maps
 *  columns the same way the input renders them. */
const INPUT_PROMPT = '› ';

export function selectedSlashCommandLine(picker: {
  open: boolean;
  matches: SlashCommandMatch[];
  selected: number;
}): string | null {
  if (!picker.open || picker.matches.length === 0) return null;
  const picked = picker.matches[picker.selected];
  return picked ? `/${picked.name}` : null;
}

function isInputWordSeparator(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

export function previousInputWordStart(buffer: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, buffer.length));
  const chipAtCursor = tokenSpanAt(buffer, i);
  if (chipAtCursor && i > chipAtCursor.start) return chipAtCursor.start;
  while (i > 0 && isInputWordSeparator(buffer[i - 1])) i--;
  const chipBeforeCursor = tokenSpanAt(buffer, i);
  if (chipBeforeCursor && i === chipBeforeCursor.end) return chipBeforeCursor.start;
  while (i > 0 && !isInputWordSeparator(buffer[i - 1])) {
    const chip = tokenSpanAt(buffer, i - 1);
    if (chip) {
      i = chip.start;
      continue;
    }
    i--;
  }
  return i;
}

export function nextInputWordStart(buffer: string, cursor: number): number {
  let i = Math.max(0, Math.min(cursor, buffer.length));
  const chipAtCursor = tokenSpanAt(buffer, i);
  if (chipAtCursor && i < chipAtCursor.end) i = chipAtCursor.end;
  else while (i < buffer.length && !isInputWordSeparator(buffer[i])) {
    const chip = tokenSpanAt(buffer, i);
    if (chip) {
      i = chip.end;
      continue;
    }
    i++;
  }
  while (i < buffer.length && isInputWordSeparator(buffer[i])) i++;
  return i;
}

/**
 * Convert restored session messages into TUI history entries so a resumed
 * session renders its prior conversation visually, not just in the LLM context.
 *
 * Order MUST match what the user saw before the crash — assistant text and
 * tool executions are interleaved chronologically. The data path makes this
 * straightforward:
 *
 *  - `messages` carries user_input / llm_response / tool_result events in
 *    JSONL order (see DefaultSessionStore.load).
 *  - For assistant messages whose `content` is an array, tool_use blocks
 *    appear in JSONL order. Each has a stable `id`.
 *  - `toolCalls` is the JSONL-ordered list of `tool_call_end` events, each
 *    carrying the same `id` as the tool_use block it resolves.
 *
 * Algorithm:
 *  - System messages are skipped (not displayed).
 *  - User messages → `kind: 'user'`.
 *  - Assistant messages → `kind: 'assistant'` (text only; tool_use blocks
 *    are dropped from the body since the tool entry renders the execution).
 *  - After each assistant message, emit a `kind: 'tool'` entry for each
 *    tool_use id that appears in that assistant's content, looking up the
 *    matching tool_call_end by id. If the assistant has multiple tool_use
 *    blocks, the tool entries appear in the same order as those blocks.
 *  - Unmatched tool_call_ends (legacy / id drift) are appended at the end
 *    in their original JSONL order so they aren't silently dropped.
 */
export function rehydrateHistory(
  messages: Message[],
  startId: number,
  toolCalls?: Array<{
    name: string;
    id: string;
    durationMs: number;
    ok: boolean;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  }> | undefined,
): import('./components/history/types.js').HistoryEntry[] {
  type ToolEntry = import('./components/history/types.js').HistoryEntry;
  const entries: ToolEntry[] = [];
  // Build a one-shot id → tool_call_end index. tool_call_end events are
  // already in JSONL order (DefaultSessionStore.extractToolCallEnds walks
  // events in file order); when two tool_use blocks share an id (shouldn't
  // happen, but defensive) we keep the first end so the timeline stays sane.
  const toolCallsById = new Map<string, NonNullable<typeof toolCalls>[number]>();
  if (toolCalls) {
    for (const tc of toolCalls) {
      if (!toolCallsById.has(tc.id)) toolCallsById.set(tc.id, tc);
    }
  }
  const consumed = new Set<string>();
  const fallback: ToolEntry[] = [];

  let nextId = startId;
  const textOf = (msg: Message): string => {
    if (typeof msg.content === 'string') return msg.content;
    return msg.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
  };
  const toolEntryFor = (tc: NonNullable<typeof toolCalls>[number]): ToolEntry => ({
    id: nextId++,
    kind: 'tool',
    name: tc.name,
    durationMs: tc.durationMs,
    ok: tc.ok,
    outputBytes: tc.outputBytes,
    outputTokens: tc.outputTokens,
    outputLines: tc.outputLines,
  });

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const text = textOf(msg).trim();
    if (!text) continue;
    if (msg.role === 'user') {
      entries.push({ id: nextId++, kind: 'user', text });
      continue;
    }
    if (msg.role === 'assistant') {
      entries.push({ id: nextId++, kind: 'assistant', text });
      // Walk the assistant content for tool_use blocks and emit a tool entry
      // for each, in the order the blocks appear. Skips text/thinking blocks
      // — the body text was already pushed above.
      if (Array.isArray(msg.content)) {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type !== 'tool_use') continue;
          const tc = toolCallsById.get(block.id);
          if (!tc) continue;
          entries.push(toolEntryFor(tc));
          consumed.add(block.id);
        }
      }
    }
  }

  // Fallback: any tool_call_end we couldn't match to a tool_use block in
  // an assistant message. Emit them in their original JSONL order so the
  // user still sees the audit trail, but only at the end of the timeline.
  if (toolCalls) {
    for (const tc of toolCalls) {
      if (!consumed.has(tc.id)) fallback.push(toolEntryFor(tc));
    }
  }
  entries.push(...fallback);
  return entries;
}

export interface AppProps {
  agent: Agent;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  events: EventBus;
  tokenCounter?: TokenCounter | undefined;
  visionAdapters?: VisionAdapters | undefined;
  /** Resolve current model vision support. Falls back to provider capability when omitted. */
  supportsVision?: (() => boolean | Promise<boolean>) | undefined;
  model: string;
  banner?: boolean | undefined;
  /** Persists the queue across crashes; rehydrated on mount, written on every mutation. */
  queueStore?: QueueStore | undefined;
  /**
   * Mirrors the queue's display texts (head first) to the host on every
   * queue change, so a running agent can be told what's waiting (queue
   * awareness — see core's queued-messages.ts). Display state is unaffected.
   */
  onQueueChange?: ((items: string[]) => void) | undefined;
  /** Reflects the policy's --yolo flag for the status bar's "⚠ YOLO" chip. */
  yolo?: boolean | undefined;
  /** Play terminal bell when an agent run completes. */
  chime?: boolean | undefined;
  /** When true, the first Ctrl+C aborts work and shows "confirm exit" rather than "exit". */
  confirmExit?: boolean | undefined;
  /** Live on/off control for the animated terminal title. Lets `/settings`
   *  toggle the title animation within the running session. */
  titleController?: { setEnabled: (on: boolean) => void } | undefined;
  /**
   * Token-saving mode indicator. When true, the status bar shows a "💾 save"
   * chip and the tool count reflects registered (non-omitted) tools.
   */
  tokenSavingMode?: boolean | undefined;
  /** Number of registered tools, displayed on the status bar line 2. */
  toolCount?: number | undefined;
  /**
   * Global mouse tracking. When true, SGR mouse reporting stays on for the
   * whole session. When false (default), the App still enables it *only* while
   * a selectable overlay (model/autonomy/settings/slash/@ picker) is open, so
   * the wheel scrolls the picker selection without sacrificing native
   * scrollback in the chat. See mouse.ts for the trade-off.
   */
  mouse?: boolean | undefined;
  /**
   * When true, free-text prompts are run through the prompt refiner
   * ("did you mean this?") before reaching the main agent. Default on;
   * toggled live via the `/enhance` slash command + `enhanceController`.
   */
  enhanceEnabled?: boolean | undefined;
  /**
   * Shared controller for the `/enhance on|off` toggle. The TUI rebinds
   * `setEnabled` on mount to a dispatch-backed setter so the slash command
   * (handled in the CLI) flips the reducer flag. Mirrors `fleetStreamController`.
   */
  enhanceController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /** Auto-send countdown (ms) for the refinement preview panel. Default 4000. */
  enhanceDelayMs?: number | undefined;
  /**
   * Returns a capability-gated low-effort reasoning hint for the prompt
   * refiner (or undefined when nothing can be safely reduced). Forwarded to
   * `enhanceUserPrompt` so a slow reasoning model does not burn thinking
   * tokens on this shallow rewrite. Absent → the refiner sends no reasoning
   * field, exactly as before.
   */
  getEnhancerReasoning?: (() => import('@wrongstack/core').ReasoningRequest | undefined) | undefined;
  /**
   * Query the live YOLO state from the permission policy. Called after
   * every slash-command dispatch so `/yolo off` (which mutates the
   * policy inside the CLI) is immediately reflected in the status bar.
   * Mirrors the `agent.ctx.model` → `setLiveModel` pattern used for
   * provider/model sync.
   */
  getYolo?: (() => boolean) | undefined;
  /** Query the live autonomy mode. */
  getAutonomy?: (() => 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') | undefined;
  /** Query the live agent mode label for the status bar (e.g. "teach"). */
  getModeLabel?: (() => string) | undefined;
  /**
   * Access the eternal-autonomy engine. When autonomy mode goes to
   * 'eternal' the TUI drives `runOneIteration()` from a post-slash hook
   * so the engine and TUI never race for the shared Context.
   */
  getEternalEngine?: (() => import('@wrongstack/core').EternalAutonomyEngine | null) | undefined;
  /**
   * Access the parallel-eternal engine. When autonomy mode goes to
   * 'eternal-parallel' the TUI drives `runOneIteration()` from a post-slash
   * hook so the engine and TUI never race for the shared Context.
   */
  getParallelEngine?: (() => import('@wrongstack/core').ParallelEternalEngine | null) | undefined;
  /**
   * Access the active SDD parallel run's control surface (or null). The SIGINT
   * handler uses it to stop a running `/sdd parallel` on the first Ctrl+C — the
   * run has its own coordinator, so it is otherwise unreachable from there.
   */
  getSddRun?: (() => import('@wrongstack/core').SddRunControl | null) | undefined;
  /**
   * Subscribe to live per-iteration events from the eternal engine. The
   * TUI installs this on mount to render each iteration as a timeline
   * entry the moment it lands — strictly more responsive than reading
   * goal.json after the fact.
   */
  subscribeEternalIteration?: ((
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void) | undefined;
  /**
   * Subscribe to per-iteration stage transitions from the autonomy engines.
   * Drives `state.eternalStage` used by the status bar to show the
   * engine's current location.
   */
  subscribeEternalStage?: ((fn: (stage: AutonomyStage) => void) => () => void) | undefined;
  /**
   * Subscribe to AutoPhase phase/task events from the PhaseOrchestrator.
   * Drives `state.autoPhase` used by the PhaseMonitor component.
   * Handlers receive the event name and payload from PhaseEventMap.
   */
  subscribeAutoPhase?: ((handler: (event: string, payload: unknown) => void) => () => void) | undefined;
  /**
   * Read the persisted autonomy settings (defaultMode, autoProceedDelayMs).
   * Used by the SettingsPicker in the TUI on mount and after Ctrl+S toggle.
   */
  /** Settings shape — shared between getSettings and saveSettings. */
  getSettings?: (() => Settings) | undefined;
  /**
   * Persist settings changes. Returns null on success, or an
   * error string on failure (so the TUI can display it as a hint).
   */
  saveSettings?: ((s: Settings) => string | null | Promise<string | null>) | undefined;
  /**
   * Predict likely next steps after a completed turn (/next). The CLI owns the
   * gating (toggle + autonomy off) and returns [] when disabled, so the App can
   * call it unconditionally on a done turn. Display-only — never executed.
   */
  predictNext?: ((input: {
    userRequest: string;
    assistantSummary: string;
  }) => Promise<string[]>) | undefined;
  /**
   * Called after each agent turn with the assistant's final output text.
   * The host parses "<next_steps>" or "💡 Next steps" suggestions from the text and stores
   * them in the shared suggestion store so `/next 1`, `/next 1 2 3` work.
   */
  onSuggestionsParsed?: ((finalText: string) => void) | undefined;
  /**
   * Retrieve current suggestions from the shared suggestion store.
   * Used by the TUI for next-steps auto-submit countdown in 'auto' mode.
   */
  getSuggestions?: (() => string[]) | undefined;
  /**
   * Retrieve current auto suggestions (items with auto="true" attribute).
   * Used by YOLO+auto mode for automatic next-step submission.
   */
  getAutoSuggestions?: (() => string[]) | undefined;
  /**
   * Autonomy next prompt template for YOLO+auto mode. Contains {{suggestion}} placeholder.
   */
  autonomyNextPrompt?: string | undefined;
  /**
   * Store suggestions in the shared suggestion store. Used by the Entry
   * component after parsing "<next_steps>" or "💡 Next steps" from assistant output so the
   * /next command and auto-submit countdown can access them.
   */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /**
   * SDD session context getter. When an SDD session is active, returns
   * the AI prompt context to inject into user messages so the model
   * knows it's in a spec-building conversation.
   */
  getSDDContext?: (() => Promise<string | null>) | undefined;
  /**
   * Process AI output for SDD auto-detection (spec, tasks, plan).
   * Called after every agent.run() completes. Returns displayable
   * status messages (e.g. "✓ Spec detected and saved!").
   */
  onSDDOutput?: ((output: string) => Promise<string[]>) | undefined;
  /** Surfaced in the startup banner. Falls back to "dev" when omitted. */
  appVersion?: string | undefined;
  /** Provider id shown in the banner ("openai", "anthropic", …). Defaults to "agent". */
  provider?: string | undefined;
  /** Wire family for the configured provider — rendered under provider in the banner. */
  family?: string | undefined;
  /** Last 3 chars of the active API key, shown in the banner for "did I pick the right key?" verification. */
  keyTail?: string | undefined;
  /**
   * Snapshot the keyed providers (and their model lists) for the
   * `/model` picker. Called every time the picker opens, so the result
   * stays in sync with config edits / new aliases. Async because the
   * host may need to load the models.dev catalog.
   */
  getPickableProviders?: (() => Promise<ProviderOption[]>) | undefined;
  /**
   * Apply a (provider, model) pair after the picker confirms. Returns
   * an error message on failure; null on success. The host owns the
   * actual Provider construction + Context mutation.
   */
  switchProviderAndModel?:
    | ((providerId: string, modelId: string) => string | null | Promise<string | null>)
    | undefined;
  /**
   * Apply an autonomy mode after the picker confirms. Returns
   * an error string on failure; null on success.
   */
  switchAutonomy?: ((
    mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel',
  ) => string | null) | undefined;
  /**
   * Real max-context token budget for the *active model*, resolved by the
   * CLI via the ModelsRegistry. The provider object only knows its family
   * default (e.g. anthropic = 200k) which is wrong for variants like the
   * 1M-context Opus model. The status bar's context chip uses this when
   * provided and falls back to the provider baseline otherwise.
   */
  effectiveMaxContext?: number | undefined;
  /** Absolute project root for goal.json loading. */
  projectRoot?: string | undefined;
  onExit: (code: number) => void;
  /** Called when /clear is dispatched — the TUI should wipe its history entries (but keep the banner). */
  onClearHistory?: ((
    dispatch: React.Dispatch<
      | { type: 'clearHistory' }
      | { type: 'resetContextChip' }
      | { type: 'streamReset' }
      | { type: 'toolStreamClear' }
    >,
  ) => void) | undefined;
  /**
   * Called on `/clear` to physically wipe the terminal (visible screen +
   * native scrollback) before the chat history is reset. Without this, the
   * `clearHistory` remount only reprints the banner *below* the old chat,
   * which stays reachable in scrollback. Owned by `run-tui` because it needs
   * the live Ink instance to reset frame tracking and avoid a smeared status
   * bar. No-op outside the TUI.
   */
  clearTerminal?: (() => void) | undefined;

  /**
   * Called when the user selects a session in the /resume picker. The host
   * loads the session JSONL, replays history entries, rebuilds the agent
   * context, and returns the hydrated history entries + nextId for display.
   * Returns null when resume fails (session not found, corrupt JSONL, etc.).
   *
   * The returned entries replace the TUI's current entries in a single
   * `replaceHistory` dispatch, so the user sees the prior conversation
   * exactly as it appeared during live interaction.
   */
  onResumeSession?: ((sessionId: string) => Promise<{
    entries: HistoryEntry[];
    nextId: number;
    sessionId: string;
  } | null>) | undefined;

  /**
   * List recent session summaries for the /resume picker. The host reads
   * from the session store and returns ResumeSessionEntry-shaped data.
   * Used both by the /resume slash command (to populate the picker) and
   * optionally by the startup rehydration path.
   */
  listSessions?: ((limit?: number) => Promise<ResumeSessionEntry[]>) | undefined;

  /**
   * Goal text passed from `--goal "..."` on the command line. When set,
   * the App mounts, renders the banner, then automatically dispatches
   * a synthetic `/goal <text>` so the user lands in goal mode without
   * having to type the slash command. Mutually advisory with `initialSteer`
   * — `initialGoal` wins if both are present.
   */
  initialGoal?: string | undefined;
  /**
   * Initial user message passed from `--ask "..."` on the command line.
   * Submitted verbatim as the first turn (no preamble) so users can
   * launch the TUI and pre-populate one turn from a shell alias / script.
   */
  initialAsk?: string | undefined;
  /** Directory for session JSONL files. Passed to App for /rewind. */
  sessionsDir?: string | undefined;

  /**
   * Load project picker items from the global manifest.
   * Called each time the project picker panel opens (F1).
   */
  getProjectPickerItems?: (() => Promise<import('./components/project-picker.js').ProjectPickerItem[]>) | undefined;

  /**
   * Called when the user selects a project or action in the project picker.
   * The host CLI handles project switching (stopping agents, spawning new session).
   */
  onProjectSelect?: ((key: string, kind: 'project' | 'action') => void) | undefined;

  /**
   * Request the TUI to exit with a specific code. When a project is selected in
   * the F1 picker, this is called to trigger a clean exit before the host CLI
   * spawns a new wstack process in the target project directory.
   */
  requestExit?: ((code: number) => void) | undefined;

  /**
   * Load live session data from the cross-process SessionRegistry.
   * Called when the sessions panel opens (F10).
   */
  getLiveSessions?: (() => Promise<import('./components/sessions-panel.js').LiveSessionEntry[]>) | undefined;

  /**
   * Called when the user selects a session from a DIFFERENT project
   * in the F10 sessions panel. Spawns a new wstack terminal in the
   * target project directory. Same-project sessions use onResumeSession.
   */
  onSwitchToSession?: ((sessionId: string, projectRoot: string, projectName: string) => void) | undefined;

  // --- Fleet ---
  /** Live director for fleet panel rendering. Null when director mode is off. */
  director: Director | null;
  /** Optional roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }> | undefined;
  /**
   * Shared controller for the `/fleet stream on|off` slash command. The
   * App installs a dispatch-backed setter on mount so the slash command
   * can flip the reducer's `streamFleet` flag from the CLI surface.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  } | undefined;
  /**
   * Shared controller for the `/interrupt` slash command. The App installs the
   * real `abortLeader` on mount so the command can abort the in-flight leader
   * run (slash commands don't get the RunController). The fleet teardown is the
   * command's own `onFleetKill`.
   */
  interruptController?:
    | {
        abortLeader: () => boolean;
      }
    | undefined;
  /**
   * Controller for status bar hidden items. App installs a dispatch-backed
   * setter on mount so the /statusline slash command can update the TUI's
   * visible bar without a round-trip. The initial value is loaded from
   * the config file before App mounts.
   */
  statuslineHiddenItems: StatuslineItem[];
  setStatuslineHiddenItems: (items: StatuslineItem[]) => void;
  /**
   * Atomically persists statusline hidden items to disk. Used by the
   * statusline picker so each toggle is immediately durable.
   */
  saveStatuslineHiddenItems: (items: StatuslineItem[]) => Promise<void>;
  /**
   * Controller for the agents monitor overlay. App installs a dispatch-backed
   * setter on mount so the `/agents on|off` slash command can toggle the
   * overlay without a round-trip.
   */
  agentsMonitorController?:
    | {
        visible: boolean;
        setVisible: (visible: boolean) => void;
      }
    | undefined;
  /**
   * Mutable ref for opening TUI panels from slash commands. The slash commands
   * call `onPanelOpen.current(action)` to open panels. The App sets
   * `onPanelOpen.current` to its actual dispatch function on mount.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
  /** Active agent mode label shown in the status bar (e.g. "teach", "brief"). */
  modeLabel?: string | undefined;
  /**
   * Called ONCE on mount by the App to install its debug-stream telemetry
   * callback. The callback receives throttled DebugStreamStats every ~200 ms
   * while the stream debug feature is active. The App dispatches to its
   * reducer; the StatusBar renders the stats on line 3. When omitted (headless
   * CLI/no TTY), debug stats go to stderr via the default callback.
   */
  registerDebugStreamCallback?: ((cb: (stats: {
    chunkCount: number;
    lastChunkSize: number;
    lastDeltaMs: number;
    totalBytes: number;
    lastChunkAt: string;
  }) => void) => void) | undefined;
  /**
   * Called on App unmount (via useEffect cleanup). Restores the debug-stream
   * callback to the default stderr writer so non-TUI invocations continue to
   * print debug lines.
   */
  restoreDebugStreamCallback?: (() => void) | undefined;
  /**
   * Messages restored from a previous session. When provided (non-empty),
   * the TUI renders the prior conversation as history entries so a resumed
   * session shows its full chat context, not just the LLM's internal state.
   */
  restoredMessages?: Message[] | undefined;
  /**
   * Tool execution records from a previous session, keyed by tool_use id.
   * Used to render tool entries (name, duration, ok/error) in the TUI on
   * resume. Events are `tool_call_end` records from the session JSONL.
   */
  restoredToolCalls?: Array<{
    name: string;
    id: string;
    durationMs: number;
    ok: boolean;
    outputBytes?: number | undefined;
    outputTokens?: number | undefined;
    outputLines?: number | undefined;
  }> | undefined;
  /**
   * When true, the agents monitor (F3) is open by default at TUI startup.
   * Used by the `wrongstack quick` command to show agents panel immediately.
   */
  initialAgentsMonitorOpen?: boolean | undefined;

  // --- AutonomousCoordinator (project-level multi-session coordination) ---

  /**
   * Subscribe to live events from the AutonomousCoordinator. Returns an unsubscribe
   * function. TUI uses this to drive the coordinator panel live view.
   */
  subscribeCoordinatorEvents?: ((fn: (event: CoordinatorEvent) => void) => (() => void)) | undefined;

  /** Start the AutonomousCoordinator with the given goal text. */
  onCoordinatorStart?: ((goal: string) => void) | undefined;
  /** Stop the AutonomousCoordinator. */
  onCoordinatorStop?: (() => void) | undefined;
  /** Whether the AutonomousCoordinator is currently running. */
  coordinatorRunning?: boolean | undefined;
  /** List available coordinator tasks the current terminal can claim. */
  onCoordinatorTasks?: (() => Promise<Array<{ id: string; title: string; priority: string; tags: string[] }> | null>) | undefined;
  /** Claim a coordinator task. Returns description on success. */
  onCoordinatorClaim?: ((taskId: string) => Promise<string | null | { description: string }>) | undefined;
  /** Mark a claimed task as completed. */
  onCoordinatorComplete?: ((taskId: string, result?: string) => Promise<string | null>) | undefined;
  /** Mark a claimed task as failed. */
  onCoordinatorFail?: ((taskId: string, error: string) => Promise<string | null>) | undefined;
  /** Get coordinator stats for status display. */
  onCoordinatorStatus?: (() => Promise<{
    goals: { total: number; done: number; pending: number; failed: number };
    dag: { running: number; ready: number; done: number; failed: number };
    auction: { pending: number; inProgress: number };
  } | null>) | undefined;
  /**
   * Unique client identifier (e.g. `tui@<uuid>`) used to tag `client.status`
   * events emitted to the EventBus for the WebUI FleetHQ map HUD. When omitted,
   * the App skips status emission.
   */
  clientId?: string | undefined;
}

const PASTE_THRESHOLD_CHARS = 200;

/** Horizontal padding used by StatusBar line content (column where chips start). Must match the SB_PADX constant in status-bar.tsx. */
const SB_PADX = 2;

// Re-exported for backward compatibility with tests importing from '../src/app.js'.
// Actual implementation lives in ./steering-preamble.ts.
export { buildSteeringPreamble } from './steering-preamble.js';

// `buildGoalPreamble` was relocated to @wrongstack/core so headless and
// WebUI callers (which depend on @wrongstack/cli but not @wrongstack/tui)
// can issue `/goal set` without dragging the TUI package in. Re-exported
// from this module for backward compatibility with consumers still
// importing from @wrongstack/tui; also used locally within this file
// where `/goal …` is wired into the chat-input handler.
export { buildGoalPreamble } from '@wrongstack/core';

export function App({
  agent,
  slashRegistry,
  attachments,
  events,
  tokenCounter,
  visionAdapters = [],
  supportsVision,
  model,
  banner = true,
  queueStore,
  onQueueChange,
  yolo = false,
  chime = false,
  confirmExit = true,
  titleController,
  mouse = false,
  enhanceEnabled = true,
  enhanceController,
  enhanceDelayMs = 15_000,
  getEnhancerReasoning,
  getYolo,
  getAutonomy,
  getEternalEngine,
  getParallelEngine,
  getSddRun,
  subscribeEternalIteration,
  subscribeEternalStage,
  subscribeAutoPhase,
  getSDDContext,
  onSDDOutput,
  appVersion,
  provider,
  family,
  keyTail,
  tokenSavingMode,
  toolCount,
  getPickableProviders,
  switchProviderAndModel,
  getSettings,
  saveSettings,
  predictNext,
  onSuggestionsParsed,
  getSuggestions,
  getAutoSuggestions,
  autonomyNextPrompt,
  setSuggestions,
  switchAutonomy,
  effectiveMaxContext,
  onExit,
  director,
  fleetRoster,
  onClearHistory,
  clearTerminal,
  listSessions,
  onResumeSession,
  fleetStreamController,
  interruptController,
  statuslineHiddenItems,
  setStatuslineHiddenItems,
  saveStatuslineHiddenItems,
  agentsMonitorController,
  initialGoal,
  initialAsk,
  sessionsDir,
  modeLabel,
  getModeLabel,
  registerDebugStreamCallback,
  restoreDebugStreamCallback,
  restoredToolCalls,
  getProjectPickerItems,
  onProjectSelect,
  requestExit,
  getLiveSessions,
  onSwitchToSession,
  initialAgentsMonitorOpen,
  onPanelOpen,
  subscribeCoordinatorEvents,
  onCoordinatorStart,
  onCoordinatorStop,
  // Reserved for the coordinator monitor panel: terminal-driven task discovery/claim.
  onCoordinatorTasks: _onCoordinatorTasks,
  onCoordinatorClaim: _onCoordinatorClaim,
  coordinatorRunning = false,
  clientId,
}: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Reactive mirrors of agent.ctx.{model,provider.id} so the status bar
  // re-renders when /model or /use mutate them. The banner is `Static`
  // and never re-renders — the user gets the textual confirmation from
  // the slash command's message in history instead.
  //
  // Statusline state was previously inlined as 8 useState calls here; it
  // lives in `useStatuslineState` now (PR 1b of the tui/app.tsx split,
  // see docs/issues/2026-06-13-tui-app-refactor-tasks.md). The destructured
  // local names (`liveModel`, `setLiveProvider`, etc.) are preserved so
  // every existing call site in this file continues to work unchanged.
  const {
    liveModel, setLiveModel,
    liveProvider, setLiveProvider,
    activeMaxContext, setActiveMaxContext,
    yoloLive, setYoloLive,
    autonomyLive, setAutonomyLive,
    liveModeLabel, setLiveModeLabel,
    hiddenItems, setHiddenItems,
    sessionCount, setSessionCount,
  } = useStatuslineState({
    model,
    provider,
    effectiveMaxContext,
    yolo,
    getAutonomy,
    modeLabel,
    statuslineHiddenItems,
  });

  // Ref mirror of the hook's hiddenItems so the /statusline slash handler
  // (registered in a useEffect below) can read the latest value without
  // capturing a stale closure.
  const hiddenItemsRef = useRef(hiddenItems);
  hiddenItemsRef.current = hiddenItems;

  // Track previous git branch to detect switches
  const prevBranchRef = useRef<string | null>(null);

  // Codebase indexing state — synced from the process-wide indexer
  // so the status bar shows "⚙ indexing 42/500" while the index builds.
  const [indexState, setIndexState] = useState(() => getIndexState());
  useEffect(() => {
    setIndexState(getIndexState());
    return onIndexStateChange((next) => setIndexState(next));
  }, []);

  // Process circuit-breaker auto kill/reset countdown — rendered as an urgent
  // chip on status-bar line 1. Applies the persisted breaker config on mount
  // (so a restart honours `/settings breaker on`), then subscribes to the
  // registry's arm/cancel events and ticks every second while armed.
  const [breakerCountdown, setBreakerCountdown] = useState(() =>
    getProcessRegistry().getBreakerCountdown(),
  );
  useEffect(() => {
    const s = getSettings?.();
    if (s) {
      getProcessRegistry().setBreakerConfig({
        enabled: s.breakerEnabled ?? false,
        autoKillResetMs: s.breakerAutoKillResetMs ?? 60_000,
      });
    }
    return getProcessRegistry().onBreakerCountdownChange((snap) => setBreakerCountdown(snap));
  }, [getSettings]);
  // Independent 1s tick so the countdown visibly decrements between events.
  const breakerArmed = breakerCountdown !== null;
  useEffect(() => {
    if (!breakerArmed) return;
    const t = setInterval(
      () => setBreakerCountdown(getProcessRegistry().getBreakerCountdown()),
      1000,
    );
    return () => clearInterval(t);
  }, [breakerArmed]);

  // Sync when parent re-loads from config file (e.g., after /statusline reset)
  useEffect(() => {
    setHiddenItems([...statuslineHiddenItems]);
  }, [statuslineHiddenItems]);

  // Push local changes back to the parent controller (in-memory) AND persist
  // to disk so they survive a restart. `saveStatuslineHiddenItems` is async
  // but we intentionally fire-and-forget — the caller handles errors.
  useEffect(() => {
    setStatuslineHiddenItems(hiddenItems);
    saveStatuslineHiddenItems(hiddenItems).catch?.((err: unknown) => {
      console.error('[statusline] failed to persist hidden items:', err);
    });
  }, [setStatuslineHiddenItems, saveStatuslineHiddenItems, hiddenItems]);

  // Statusline picker → status bar sync lives after useReducer (see below) —
  // it reads `state.statuslinePicker`, which doesn't exist until the reducer
  // is declared. Keeping it here would reference `state` in the temporal dead
  // zone ("Cannot access 'state' before initialization").

  // Stream chip auto-expiration code lives after useReducer (see below).

  const projectRoot = agent.ctx.projectRoot;

  // Read the single canonical goal.json — the per-project file under
  // ~/.wrongstack/projects/<slug>/ (resolveWstackPaths → projectGoal), the SAME
  // file `/goal` and the autonomy engines write (they all go through
  // goalFilePath, which now delegates here). The old code read
  // <projectRoot>/.wrongstack/goal.json — a repo-local path nothing writes — so
  // the F9 panel always showed "No goal set".
  const refreshGoalSummary = useCallback(() => {
    if (!projectRoot) return;
    const goalPath = resolveWstackPaths({ projectRoot }).projectGoal;
    loadGoal(goalPath)
      .then((goal) => {
        if (!goal) {
          // Goal was cleared or never existed — clear the panel so
          // stale data doesn't linger after /goal clear.
          dispatch({ type: 'goalSummary', summary: null });
          return;
        }
        const lastEntry = goal.journal?.[goal.journal.length - 1];
        dispatch({
          type: 'goalSummary',
          summary: {
            goal: goal.goal,
            refinedGoal: goal.refinedGoal,
            goalState: goal.goalState ?? 'active',
            iterations: goal.iterations,
            progress: goal.progress,
            progressNote: goal.progressNote,
            progressTrend: goal.progressTrend,
            deliverables: goal.deliverables,
            lastTask: lastEntry?.task,
            lastStatus: lastEntry?.status,
          },
        });
      })
      .catch(() => {
        // Unreadable/partial file — leave the previous summary in place.
      });
  }, [projectRoot]);

  // Load once on mount (startup banner / initial F9 state). The live-while-open
  // refresh lives further down, after `nowTick` is declared.
  useEffect(() => {
    refreshGoalSummary();
  }, [refreshGoalSummary]);

  // Rehydrate TUI chat history from restored messages (session resume).
  // agent.ctx.messages is populated by setupSession → context.state.replaceMessages()
  // when wstack resume <id> is used. These messages only exist in the LLM context
  // by default; we convert them to visible history entries here.
  // restoredToolCalls (from tool_call_end JSONL events) are appended as tool entries
  // showing name, duration, and ok/error status.
  const restoredEntries = (() => {
    const msgs = agent.ctx.messages;
    if (!msgs || msgs.length === 0) return [];
    // Filter out system prompt messages (role === 'system') — the banner
    // already shows the provider/model, and system prompts are not user-visible.
    const visible = msgs.filter((m) => m.role !== 'system');
    if (visible.length === 0) return [];
    return rehydrateHistory(visible, /* startId */ 1, restoredToolCalls);
  })();
  const initialNextId = 1 + restoredEntries.length;

  const [state, dispatch] = useReducer(reducer, {
    entries: [
      ...(banner
        ? [
            {
              id: 0,
              kind: 'banner' as const,
              version: appVersion ?? 'dev',
              provider: provider ?? 'agent',
              model,
              cwd: agent.ctx.cwd,
              family,
              keyTail,
            },
          ]
        : []),
      ...restoredEntries,
    ],
    historyGen: 0,
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle' as const,
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    brain: { state: 'idle' as const },
    brainPrompt: null,
    nextId: initialNextId,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    modelPicker: {
      open: false,
      step: 'provider' as const,
      providerOptions: [],
      modelOptions: [],
      filteredOptions: [],
      selected: 0,
      searchQuery: '',
    },
    autonomyPicker: { open: false, options: [], selected: 0 },
    designPicker: { open: false, kits: [], selected: 0, stack: 'web' },
    resumePicker: { open: false, sessions: [], selected: 0, busy: false, hint: undefined, error: undefined },
    settingsPicker: { open: false, field: 0, lastSettingsField: 0, filter: '', mode: 'off', delayMs: 0, titleAnimation: true, yolo: false, streamFleet: true, chime: false, confirmExit: true, nextPrediction: false, featureMcp: true, featurePlugins: true, featureMemory: true, featureSkills: true, featureModelsRegistry: true, tokenSavingTier: 'off' as TokenSavingTier, allowOutsideProjectRoot: true, contextAutoCompact: true, contextStrategy: 'hybrid', contextMode: 'balanced' as ContextMode, maxConcurrent: 10, logLevel: 'info', auditLevel: 'standard', indexOnStart: true, multiDiffSummaryThreshold: 5, maxIterations: 500, autoProceedMaxIterations: 50, enhanceDelayMs: 60_000, enhanceEnabled: true, enhanceLanguage: 'original', debugStream: false, statuslineMode: 'detailed' as StatuslineMode, reasoningMode: 'auto' as 'auto', reasoningEffort: 'high', reasoningPreserve: false, thinkingWord: 'thinking', thinkingWordEditing: false, thinkingWordDraft: '', cacheTtl: 'default', configScope: 'global' },
    statuslinePicker: { open: false, field: 0, hiddenItems: [], visibleChips: [], hint: undefined },
    projectPicker: { open: false, allItems: [], items: [], selected: 0, filter: '', hint: undefined },
    fKeyPicker: { open: false, selected: 0 },
    confirmQueue: [],
    enhance: null,
    enhanceEnabled,
    enhanceBusy: false,
    escConfirm: null,
    contextChipVersion: 0,
    fleet: {},
    leader: {
      iterations: 0,
      toolCalls: 0,
      recentTools: [],
      currentTool: undefined,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      iterating: false,
    },
    fleetCost: 0,
    fleetTokens: { input: 0, output: 0 },
    fleetConcurrency: 4,
    streamFleet: true,
    monitorOpen: false,
    agentsMonitorOpen: initialAgentsMonitorOpen ?? false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    planPanelOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    sessionResumeConfirm: null,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    autoPhase: null,
    sddBoard: null,
    worktrees: {},
    worktreeMonitorOpen: false,
    coordinator: {
      goals: [],
      timeline: [],
      knowledgeCount: 0,
      monitorOpen: false,
      healthy: false,
    },
    scrollOffset: 0,
    totalLines: 0,
    viewportRows: 0,
    pendingNewLines: 0,
    debugStreamStats: null,
    countdown: null,
  });

  // Sync picker toggles instantly to the status bar — when the user toggles an
  // item in the statusline picker, the reducer updates
  // state.statuslinePicker.hiddenItems. We mirror that change into the
  // useStatuslineState hook so the StatusBar re-renders immediately.
  // (Declared after useReducer: it reads `state`.)
  useEffect(() => {
    if (state.statuslinePicker.open) {
      const pickerHidden = state.statuslinePicker.hiddenItems;
      // Only sync if the lists differ (avoid infinite loops). Compare as plain
      // Compare as plain strings to avoid order-only churn.
      const currentHidden = new Set<string>(hiddenItems);
      const pickerHiddenSet = new Set<string>(pickerHidden);
      const differs =
        currentHidden.size !== pickerHiddenSet.size ||
        pickerHidden.some((item) => !currentHidden.has(item)) ||
        hiddenItems.some((item) => !pickerHiddenSet.has(item));
      if (differs) {
        setHiddenItems([...pickerHidden] as typeof hiddenItems);
      }
    }
  }, [state.statuslinePicker.hiddenItems, state.statuslinePicker.open, setHiddenItems, hiddenItems]);

  // ── Stream chip auto-expiration ────────────────────────────────────────
  // Show/hide stream chips (brain, mailbox, enhance, debug_stream) based on
  // data availability. These chips auto-expire unless the user has toggled them on.
  const prevBrainPromptRef = useRef(state.brainPrompt);
  const prevEnhanceRef = useRef(state.enhance);

  useEffect(() => {
    // brain: show when prompt appears, expire when it clears
    if (state.brainPrompt && !prevBrainPromptRef.current) {
      dispatch({ type: 'statuslineChipShow', key: 'brain', expiresIn: 5 });
    } else if (!state.brainPrompt && prevBrainPromptRef.current) {
      if (state.statuslinePicker.visibleChips.some((c) => c.key === 'brain')) {
        dispatch({ type: 'statuslineChipExpire', key: 'brain' });
      }
    }
    prevBrainPromptRef.current = state.brainPrompt;

    // enhance: show when enhance panel opens, expire when it closes
    if (state.enhance && !prevEnhanceRef.current) {
      dispatch({ type: 'statuslineChipShow', key: 'enhance', expiresIn: 5 });
    } else if (!state.enhance && prevEnhanceRef.current) {
      if (state.statuslinePicker.visibleChips.some((c) => c.key === 'enhance')) {
        dispatch({ type: 'statuslineChipExpire', key: 'enhance' });
      }
    }
    prevEnhanceRef.current = state.enhance;
  }, [
    state.brainPrompt,
    state.enhance,
    state.statuslinePicker.visibleChips,
    dispatch,
  ]);

  // Periodic expiration checker — runs every 30 s to remove chips whose
  // time window has elapsed. Chips with no expiresIn are permanent.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const expired = state.statuslinePicker.visibleChips.filter((c) => isChipExpired(c, now));
      for (const chip of expired) {
        dispatch({ type: 'statuslineChipExpire', key: chip.key });
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [state.statuslinePicker.visibleChips, dispatch]);

  // ── AutonomousCoordinator bridge ─────────────────────────────────────
  // Wire project-level coordinator events into the TUI reducer so the
  // CoordinatorPanel can render live goals, tasks, and knowledge.
  useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);

  const builderRef = useRef<InputBuilder | null>(null);
  if (builderRef.current === null) {
    builderRef.current = new InputBuilder({ store: attachments });
  }

  // Bracketed-paste accumulator. A single paste can be delivered across
  // several stdin/keypress events: only the first carries the \x1b[200~
  // begin marker and only the last carries \x1b[201~. We buffer every
  // fragment here between those markers and finalize once, so a paste never
  // fragments into multiple placeholders or leaks newlines into the buffer.
  // `null` means "not currently inside a paste".
  const pasteAccumRef = useRef<string | null>(null);
  // Safety net: if the closing \x1b[201~ marker never arrives (a terminal
  // dropped it, or Ink split the escape across chunks), flush the buffered
  // payload after a short idle period so accumulation can't swallow input
  // indefinitely. Real pastes deliver all fragments back-to-back, well
  // inside this window.
  const pasteFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeCtrlRef = useRef<AbortController | null>(null);
  // Set once we've asked Ink to unmount on a Ctrl+C exit. A synchronous ref
  // (not React state) because consecutive SIGINTs can fire faster than a
  // re-render — without it, `stateRef.current.interrupts` reads stale and a
  // wedged unmount could never escalate to a hard exit.
  const exitRequestedRef = useRef(false);
  // Prevent re-entrant handleKey: some terminals emit \r\n as two separate
  // stdin events for Enter. While the first event is being processed (submit
  // or picker accept), the second arrives with stale state and would trigger
  // a duplicate action. The gate blocks the stale-second event entirely.
  const inputGateRef = useRef(false);
  // Separate guard JUST for the submit path. The full `inputGateRef`
  // is held across `await foo()` blocks (picker accept, model picker
  // commit) — that's fine because those resolve in milliseconds. But
  // `await submit()` resolves only when `agent.run()` finishes, which
  // can be minutes for a delegated subagent task. Using the same gate
  // would lock ALL keystrokes (typing, backspace, slash menu) for the
  // entire agent run. This timestamp-based guard fires for the few
  // milliseconds needed to debounce a terminal-side `\r\n` double-event
  // and then auto-releases — leaving the input live for the user.
  const lastEnterAtRef = useRef(0);
  // Maps an inline attachment token (e.g. `[pasted #1, 123 lines]`) to a short
  // preview of its content, so the chat-history entry can show the collapsed
  // text below the message. Append-only for the lifetime of the session; the
  // token strings are unique per attachment seq, so stale entries are inert.
  const tokenPreviewsRef = useRef<Map<string, string>>(new Map());
  // The status-bar chip surfaces the basename so multiple WrongStack
  // windows running against different repos are immediately distinguishable.
  // Empty / root fallback to undefined so the chip just hides itself.
  const projectName = React.useMemo(() => {
    const base = path.basename(projectRoot);
    return base && base !== path.sep ? base : undefined;
  }, [projectRoot]);

  // Working directory chip — relative path within the project. Uses
  // React state + subscription to ctx.onWorkingDirChanged() so it stays
  // live when the agent or user changes directories mid-session.
  const [workingDirChip, setWorkingDirChip] = React.useState<string | undefined>(() => {
    const ctx = agent.ctx;
    if (ctx.workingDir && ctx.workingDir !== projectRoot) {
      return path.relative(projectRoot, ctx.workingDir) || '.';
    }
    return undefined;
  });
  React.useEffect(() => {
    const ctx = agent.ctx;
    return ctx.onWorkingDirChanged((newDir) => {
      const rel = path.relative(projectRoot, newDir) || '.';
      setWorkingDirChip(rel === '.' ? undefined : rel);
    });
  }, [agent.ctx, projectRoot]);

  // chime/confirmExit must reflect LIVE `/settings` changes, not just the boot
  // props. getSettings() reads the in-memory configStore, which saveSettings
  // updates on every ←/→ change, so these refs stay current within the running
  // session without a restart. Falls back to the boot prop when unavailable.
  const liveSettings = getSettings?.();
  const liveStatuslineMode = liveSettings?.statuslineMode ?? 'detailed';
  const liveThinkingWord = liveSettings?.thinkingWord ?? 'thinking';
  // When the user hasn't pinned a word (unset, the literal default, or
  // 'random'), surface a fresh fun word from the pool for each working spell;
  // an explicit custom word is shown verbatim. We re-roll only on the
  // idle→working transition so the chip stays stable while a single turn runs.
  const [rolledThinkingWord, setRolledThinkingWord] = useState(() =>
    pickRandomTuiThinkingWord(),
  );
  const thinkingWorking = state.status === 'running' || state.status === 'streaming';
  const prevThinkingWorkingRef = useRef(false);
  useEffect(() => {
    if (thinkingWorking && !prevThinkingWorkingRef.current) {
      setRolledThinkingWord((prev) => pickRandomTuiThinkingWord(prev));
    }
    prevThinkingWorkingRef.current = thinkingWorking;
  }, [thinkingWorking]);
  const displayThinkingWord = isRandomTuiThinkingWord(liveThinkingWord)
    ? rolledThinkingWord
    : liveThinkingWord;
  // Mirror to a ref so the (possibly memoized) mouse handler reads the same
  // word the statusline rendered when computing the model-chip hit span.
  const displayThinkingWordRef = useRef(displayThinkingWord);
  displayThinkingWordRef.current = displayThinkingWord;
  const chimeRef = useRef(chime);
  chimeRef.current = liveSettings?.chime ?? chime;
  const confirmExitRef = useRef(confirmExit);
  confirmExitRef.current = liveSettings?.confirmExit ?? confirmExit;

  // Apply a live `titleAnimation` change to the out-of-band terminal title
  // controller (set up in run-tui). Reads the configStore-backed live value so
  // it tracks ←/→ changes in `/settings`; the boolean primitive keeps the
  // effect from re-firing on unrelated renders.
  const liveTitleAnimation = liveSettings?.titleAnimation;
  useEffect(() => {
    if (!titleController) return;
    titleController.setEnabled(liveTitleAnimation !== false);
  }, [titleController, liveTitleAnimation]);

  // Source of truth for the streamed assistant text — kept here, not in
  // React state, because we need to read it synchronously when `agent.run`
  // returns. The React `streamingText` shown in the live tail is throttled
  // (~10fps) for redraw cost, so it can lag the actual stream by up to
  // FLUSH_MS. Reading from this ref instead removes the race where the
  // final chunk lands in pending after run() returns and ends up flashing
  // into the next frame's tail (leaking into scrollback).
  const streamingTextRef = useRef('');
  const pendingDeltaRef = useRef('');
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest state snapshot — async callbacks (the queue drainer, slash command
  // closures) read this instead of capturing `state` to avoid stale closures.
  const stateRef = useRef<State>(state);
  stateRef.current = state;
  const draftRef = useRef({ buffer: state.buffer, cursor: state.cursor });
  draftRef.current = { buffer: state.buffer, cursor: state.cursor };

  const statuslineHiddenForPicker = useCallback((): StatuslineItem[] => {
    const hookHidden = hiddenItemsRef.current;
    const hookHiddenSet = new Set<StatuslineItem>(hookHidden);
    const reducerOnlyHidden = stateRef.current.statuslinePicker.hiddenItems.filter(
      (item) => !hookHiddenSet.has(item),
    );
    return [...hookHidden, ...reducerOnlyHidden];
  }, []);

  const openStatuslinePicker = useCallback((field?: number) => {
    if (field !== undefined) {
      dispatch({ type: 'statuslineFieldSet', field });
    }
    dispatch({ type: 'statuslineOpen', hiddenItems: statuslineHiddenForPicker() });
  }, [statuslineHiddenForPicker]);

  // Live mirror of the `mouse` opt-in so `/mouse` can toggle full mouse mode
  // mid-session (swap History ↔ ScrollableHistory, flip SGR tracking) without a
  // restart. Seeded from the prop (--mouse / WRONGSTACK_MOUSE / saved setting).
  const [mouseMode, setMouseMode] = useState(mouse);

  // Mouse tracking ownership. We enable SGR mouse reporting while a selectable
  // overlay is open (so the wheel scrolls the picker selection — see the wheel
  // handlers in handleKey), and while the global `mouse` prop is set. Outside
  // those cases tracking stays OFF so the wheel scrolls the terminal's native
  // scrollback in the chat. A ref tracks the last write so we only emit a
  // sequence on an actual transition. Cleanup disables tracking on unmount;
  // run-tui also sends MOUSE_OFF as a belt-and-suspenders on process exit.
  const pickerOverlayOpen =
    state.modelPicker.open ||
    state.autonomyPicker.open ||
    state.designPicker.open ||
    state.settingsPicker.open ||
    state.projectPicker.open ||
    state.slashPicker.open ||
    state.statuslinePicker.open ||
    state.fKeyPicker.open ||
    state.picker.open;
  const mouseTrackingOn = mouseMode || pickerOverlayOpen;
  const mouseWrittenRef = useRef(false);
  useEffect(() => {
    if (mouseWrittenRef.current === mouseTrackingOn) return;
    mouseWrittenRef.current = mouseTrackingOn;
    try {
      process.stdout.write(mouseTrackingOn ? MOUSE_CLICK_ON : MOUSE_OFF);
    } catch {
      // stdout closed during shutdown — ignore.
    }
  }, [mouseTrackingOn]);
  useEffect(
    () => () => {
      try {
        process.stdout.write(MOUSE_OFF);
      } catch {
        // ignore — process tearing down.
      }
    },
    [],
  );

  // Mouse-mode managed scroll. With SGR tracking on, the terminal's native
  // wheel-scroll is captured by us, so the chat history can no longer ride the
  // terminal's scrollback — it's rendered into a fixed-height ScrollableHistory
  // viewport that the App scrolls itself. The viewport height is (terminal rows
  // − bottom-region height): we measure the bottom region (input + pickers +
  // status bar + panels) after layout and subtract from the live row count.
  // Guarded against a measure → dispatch → re-measure loop by only dispatching
  // when the computed height actually changes.
  const bottomRegionRef = useRef<DOMElement | null>(null);
  // Measured on click to locate clickable status-bar chips: the status bar is
  // bottom-anchored above `belowStatusBarRef`'s panels, so its absolute rows are
  // termRows − belowHeight − statusBarHeight … See statusBarLineRow / handleKey.
  const statusBarWrapRef = useRef<DOMElement | null>(null);
  const belowStatusBarRef = useRef<DOMElement | null>(null);
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24);
  useEffect(() => {
    const onResize = () => setTermRows(process.stdout.rows ?? 24);
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);
  useLayoutEffect(() => {
    if (!mouseMode) return;
    const node = bottomRegionRef.current;
    if (!node) return;
    const { height } = measureElement(node);
    const vp = Math.max(1, termRows - height);
    if (vp !== stateRef.current.viewportRows) {
      dispatch({ type: 'setViewportRows', rows: vp });
    }
  });

  // Latest handleKey, so the keyboard event pipeline can be accessed from
  // effects and callbacks defined above handleKey in the component body.
  const handleKeyRef = useRef<((input: string, key: KeyEvent) => void) | null>(null);

  // handleRewindTo must be declared before the /rewind useEffect (line 1803)
  // so the closure can capture it. It is intentionally NOT in useCallback
  // — each call needs a fresh rewinder referencing the current sessionsDir.
  const handleRewindTo = React.useCallback(
    async (checkpointIndex: number) => {
      const sessionId = agent.ctx.session.id;
      if (!sessionId) return;
      const rewinder = new DefaultSessionRewinder(sessionsDir ?? '', agent.ctx.projectRoot ?? agent.ctx.cwd);
      // Revert file system changes first (read-only, safe to do eagerly).
      await rewinder.rewindToCheckpoint(sessionId, checkpointIndex);
      // Then truncate the conversation history — this fires session.rewound
      // on the EventBus, which the useEffect at line 2212 listens to and
      // dispatches sessionRewound + clearHistory.
      await agent.ctx.session.truncateToCheckpoint(checkpointIndex);
    },
    [agent.ctx.session, sessionsDir, agent.ctx.projectRoot, agent.ctx.cwd],
  );

  const setDraft = (buffer: string, cursor: number): void => {
    draftRef.current = { buffer, cursor };
    dispatch({ type: 'setBuffer', buffer, cursor });
  };

  const clearDraft = (): void => {
    draftRef.current = { buffer: '', cursor: 0 };
    dispatch({ type: 'clearInput' });
  };

  // Global clock tick. Deliberately slow (10s). The StatusBar tracks its own 1s
  // elapsed-time display internally; this tick only feeds monitor overlays and
  // the todos poll (which have their own faster intervals when open).
  const startedAtRef = useRef<number>(Date.now());
  const [nowTick, setNowTick] = React.useState<number>(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(t);
  }, []);

  // Heap watchdog. Long autonomous sessions (10h+) have crashed at the V8
  // heap limit ("Ineffective mark-compacts near heap limit") with nothing
  // attributing what grew. Sample memory every minute, append diagnostics
  // (incl. history/conversation sizes) to ~/.wrongstack/logs/heap.jsonl,
  // and surface in-chat warnings at 60% / 85% of the heap limit so the user
  // can checkpoint and restart BEFORE the hard OOM.
  useEffect(() => {
    const approxChars = (v: unknown): number => {
      try {
        return JSON.stringify(v)?.length ?? 0;
      } catch {
        return -1;
      }
    };
    return startHeapWatchdog({
      collectStats: () => ({
        historyEntries: stateRef.current.entries.length,
        historyChars: approxChars(stateRef.current.entries),
        messages: agent.ctx.state.messages.length,
        messagesChars: approxChars(agent.ctx.state.messages),
        runningTools: stateRef.current.runningTools.size,
        // Bytes queued in stdout's writable buffer. On Windows, TTY writes
        // are asynchronous — a render storm (e.g. high-frequency tool
        // progress dispatches) queues whole ANSI frames here as live heap
        // strings, invisible to every other counter.
        stdoutQueued: process.stdout.writableLength ?? 0,
      }),
      onWarn: (level, message) => {
        dispatch({
          type: 'addEntry',
          entry: { kind: level === 'critical' ? 'error' : 'warn', text: message },
        });
      },
    });
  }, [agent.ctx]);

  // Keep the F9 goal panel live: refresh the moment it opens and on every tick
  // while it stays open, so a goal set mid-session via `/goal` — or progress
  // updated by the autonomy engine — appears without restarting the TUI.
  useEffect(() => {
    if (state.goalPanelOpen) refreshGoalSummary();
  }, [state.goalPanelOpen, nowTick, refreshGoalSummary]);

  // Animated dot indicator for the refine-in-progress bar. Cycles 0..3
  // while `enhanceBusy` is true so the user sees a live "still working" cue.
  const [enhanceDots, setEnhanceDots] = useState(0);
  useEffect(() => {
    if (!state.enhanceBusy) return;
    const t = setInterval(() => setEnhanceDots((n) => (n + 1) % 4), 400);
    return () => clearInterval(t);
  }, [state.enhanceBusy]);

  // ── Consolidated 2s tick: todos status + autonomy/yolo/mode/model/provider sync ──
  // Previously two separate 2s intervals, each triggering its own React state
  // update and re-render when their values changed. Merged into one tick so the
  // two checks share a single interval timer, and when BOTH change in the same
  // cycle (common after an agent turn that calls the `todo` tool and potentially
  // mutates the model), they batch into one re-render instead of two.
  const todosRef = useRef(JSON.stringify([]));
  const staleGuardRef = useRef(JSON.stringify({ a: '', y: false, m: '', model: '', provider: '' }));
  useEffect(() => {
    const poll = () => {
      // ── Todos check ──
      const todoSnap = JSON.stringify(agent.ctx.todos.map((t) => ({ s: t.status })));
      if (todoSnap !== todosRef.current) {
        todosRef.current = todoSnap;
        setNowTick(Date.now());
      }
      // ── Status-bar live sync (autonomy, yolo, mode, model, provider) ──
      const a = getAutonomy?.() ?? 'off';
      const y = getYolo?.() ?? false;
      const m = getModeLabel?.() ?? '';
      const curModel = agent.ctx.model;
      const curProvider = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id ?? '';
      const snap = JSON.stringify({ a, y, m, model: curModel, provider: curProvider });
      if (snap !== staleGuardRef.current) {
        staleGuardRef.current = snap;
        if (a !== autonomyLive) setAutonomyLive(a);
        if (y !== yoloLive) setYoloLive(y);
        if (m !== liveModeLabel) setLiveModeLabel(m);
        if (curModel !== liveModel) setLiveModel(curModel);
        if (curProvider !== liveProvider) setLiveProvider(curProvider);
        if (a === 'eternal' && getEternalEngine) void runEternalLoopRef.current();
        if (a === 'eternal-parallel' && getParallelEngine) void runParallelLoopRef.current();
      }
    };
    const t = setInterval(poll, 2000);
    return () => clearInterval(t);
  }, [
    getAutonomy, getYolo, getModeLabel,
    getEternalEngine, getParallelEngine,
    autonomyLive, yoloLive, liveModeLabel, liveModel, liveProvider,
    agent.ctx.model, agent.ctx.provider, agent.ctx.todos,
  ]);

  // Git branch + change counts. Polled every 5s (cheap, two short-lived
  // `git` subprocesses). Skipped silently when the cwd isn't a repo or
  // git isn't installed — the chip just doesn't render.
  const [gitInfo, setGitInfo] = React.useState<GitInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      readGitInfo(agent.ctx.cwd)
        .then((info) => {
          if (cancelled) return;
          setGitInfo(info);

          // Detect branch switch
          if (info?.branch) {
            const prev = prevBranchRef.current;
            if (prev !== null && prev !== info.branch) {
              // Branch changed — inject system message so the agent knows
              const msg: Message = {
                role: 'user',
                content: [{ type: 'text', text: `[system] Git branch switched: ⎇ ${prev} → ⎇ ${info.branch}. The working tree is now on branch "${info.branch}". Any file changes from the previous branch are no longer visible.` }],
              };
              agent.ctx.messages.push(msg);
              // Update SessionRegistry with the new branch (best-effort)
              try {
                import('@wrongstack/core').then(({ getSessionRegistry }) => {
                  const reg = getSessionRegistry();
                  if (reg) {
                    reg.updateAgents([]).catch(() => {});
                  }
                }).catch(() => {});
              } catch { /* silent */ }
            }
            prevBranchRef.current = info.branch;
          }
        })
        .catch(() => {
          if (!cancelled) setGitInfo(null);
        });
    };
    refresh();
    // Initialize prev branch on first successful read
    if (gitInfo?.branch && prevBranchRef.current === null) {
      prevBranchRef.current = gitInfo.branch;
    }
    const t = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [agent.ctx.cwd, gitInfo?.branch]);

  // Live session count — polled from SessionRegistry every 30s for the status bar
  useEffect(() => {
    if (!getLiveSessions) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const sessions = await getLiveSessions();
        if (!cancelled) setSessionCount(sessions.length);
      } catch { /* silent */ }
    };
    void poll();
    const t = setInterval(poll, 30_000);
    if (t.unref) t.unref();
    return () => { cancelled = true; clearInterval(t); };
  }, [getLiveSessions]);

  // ── Mailbox status for the status bar (4th line) ────────────────────
  // Subscribes to mailbox events to keep unread count + online agents + latest message in sync.
  const [mailboxStatus, setMailboxStatus] = useState<MailboxStatus>({
    unread: 0,
    onlineAgents: 0,
    onlineClients: { tui: 0, webui: 0, repl: 0 },
  });
  useEffect(() => {
    const seenAgents = new Set<string>();
    const unsub1 = events.onPattern('mailbox.unread_count', (_e, payload) => {
      const p = payload as { count: number } | undefined;
      setMailboxStatus((prev) => ({ ...prev, unread: p?.count ?? 0 }));
    });
    const unsub2 = events.onPattern('mailbox.received', (_e, payload) => {
      const p = payload as { subject?: string; from?: string } | undefined;
      setMailboxStatus((prev) => ({
        ...prev,
        lastSubject: p?.subject ?? prev.lastSubject,
        lastFrom: p?.from ?? prev.lastFrom,
      }));
    });
    // Track online agents from registration + heartbeat events
    const unsub3 = events.onPattern('mailbox.agent_registered', (_e, payload) => {
      const p = payload as { agentId?: string } | undefined;
      if (p?.agentId) seenAgents.add(p.agentId);
      setMailboxStatus((prev) => ({ ...prev, onlineAgents: seenAgents.size }));
    });
    const unsub4 = events.onPattern('mailbox.agent_heartbeat', (_e, payload) => {
      const p = payload as { agentId?: string } | undefined;
      if (p?.agentId) seenAgents.add(p.agentId);
      setMailboxStatus((prev) => ({ ...prev, onlineAgents: seenAgents.size }));
    });
    // `mailbox.sync_clients` is the authoritative source of truth — emitted every
    // 30s by the TUI that holds the GlobalMailbox. It overwrites whatever the
    // fast-path event handlers above may have set, correcting counts when clients
    // disconnect and their registrations expire (CLIENT_STALE_MS = 60s).
    const unsub5 = events.onPattern('mailbox.sync_clients', (_e, payload) => {
      const p = payload as { tui?: number; webui?: number; repl?: number } | undefined;
      if (p) {
        setMailboxStatus((prev) => ({
          ...prev,
          onlineClients: {
            tui: p.tui ?? 0,
            webui: p.webui ?? 0,
            repl: p.repl ?? 0,
          },
        }));
      }
    });
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); };
  }, [events]);

  // ── Mailbox panel state ──────────────────────────────────────────────
  const [mailboxPanelOpen, setMailboxPanelOpen] = useState(false);
  const [mailboxMessages, setMailboxMessages] = useState<Array<{
    id: string; from: string; to: string; type: string; subject: string;
    body: string; priority: string; timestamp: string; readByCount: number;
    readByMe: boolean; completed: boolean; completedBy?: string; outcome?: string;
  }>>([]);
  const [mailboxAgents, setMailboxAgents] = useState<Array<{
    agentId: string; name: string; role?: string | undefined; sessionId: string;
    status: string; currentTool?: string | undefined; currentTask?: string | undefined;
    lastSeenAt: string; online: boolean; source?: string | undefined;
  }>>([]);

  // Poll mailbox when panel is open
  useEffect(() => {
    if (!mailboxPanelOpen) return;
    const poll = async () => {
      try {
        // We call the mailbox tool indirectly — the agent exposes a method
        // or we rely on events. For now, rely on events already subscribed.
        // The mailboxStatus already has unread count and last subject.
      } catch { /* silent */ }
    };
    void poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, [mailboxPanelOpen]);

  // Populate mailbox panel data from events
  useEffect(() => {
    const unsub = events.onPattern('mailbox.received', (_e, payload) => {
      const p = payload as {
        messageId?: string; from?: string; subject?: string; type?: string;
      } | undefined;
      if (!p?.messageId) return;
      setMailboxMessages((prev) => {
        if (prev.some((m) => m.id === p.messageId)) return prev;
        return [
          {
            id: p.messageId!,
            from: p.from ?? 'unknown',
            to: '*',
            type: p.type ?? 'note',
            subject: p.subject ?? '',
            body: '',
            priority: 'normal',
            timestamp: new Date().toISOString(),
            readByCount: 0,
            readByMe: false,
            completed: false,
          },
          ...prev,
        ].slice(0, 50);
      });
    });
    const unsub2 = events.onPattern('mailbox.agent_registered', (_e, payload) => {
      const p = payload as {
        agentId?: string; name?: string; role?: string; sessionId?: string; source?: string;
      } | undefined;
      if (!p?.agentId) return;
      setMailboxAgents((prev) => {
        if (prev.some((a) => a.agentId === p.agentId)) return prev;
        return [...prev, {
          agentId: p.agentId!, name: p.name ?? p.agentId!,
          role: p.role, sessionId: p.sessionId ?? '?',
          status: 'idle', lastSeenAt: new Date().toISOString(),
          online: true, source: p.source as 'cli' | 'webui' | undefined,
        }].slice(0, 30);
      });
    });
    return () => { unsub(); unsub2(); };
  }, [events]);

  // Latest provider request's input-token count. Tracked separately
  // from `tokenCounter` (which is cumulative) because for the context
  // fullness bar we want the live size of the conversation as it sat
  // on the wire — that's what determines how close we are to the
  // model's max context window.
  //
  // We sum input + cacheRead + cacheWrite so the chip reflects the TRUE
  // total context the model loaded (Usage is disjoint by design — see the
  // doc on Usage). Without this, prompt-cached turns would show only the
  // fresh-token delta and the chip would read 0% even when the context
  // was near the limit.
  // Cumulative "effective context" from tokenCounter: fresh input tokens
  // PLUS cached tokens that were sent as part of this prompt. All three
  // contribute to context-window pressure — cache tokens are still tokens
  // the model must process. (usage.input is disjoint from cacheRead/
  // cacheWrite, so simple sum is correct.)

  // Per-model maxContext. CLI passes the startup value, then model-switch and
  // ctx.pct events keep activeMaxContext in sync with the live agent context.
  const maxContext = activeMaxContext ?? agent.ctx.provider.capabilities.maxContext;

  // Per-request context pressure: current prompt tokens (input + cacheRead).
  // Unlike the cumulative tokenCounter.total() which grows across all turns,
  // this tracks the live request's context weight — what actually determines
  // how close we are to the maxContext ceiling.
  // Cached tokens (cacheWrite) are excluded because they are an accounting
  // artifact of THIS request (provider charges for them separately); they
  // are already counted in usage.input as part of the prompt the model sees.
  const currentContextTokens =
    (tokenCounter?.currentRequestTokens()?.input ?? 0) +
    (tokenCounter?.currentRequestTokens()?.cacheRead ?? 0);

  const contextWindow = useMemo(() => {
    void state.contextChipVersion;
    return currentContextTokens > 0 && maxContext > 0
      ? { used: currentContextTokens, max: maxContext }
      : undefined;
  }, [currentContextTokens, maxContext, state.contextChipVersion]);

  // Todo counts come from the agent's context, which is mutated by
  // the `todo` tool. Re-read on each render — array access is O(N) on
  // a list that's typically < 20 items.
  const todos = useMemo(() => {
    const counts = { pending: 0, inProgress: 0, completed: 0 };
    for (const t of agent.ctx.todos) {
      if (t.status === 'pending') counts.pending++;
      else if (t.status === 'in_progress') counts.inProgress++;
      else if (t.status === 'completed') counts.completed++;
    }
    return counts;
    // Tick on `nowTick` so we pick up todo changes even though
    // agent.ctx.todos isn't React state — the 1s clock doubles as a
    // poll for ctx-side state.
  }, [nowTick, agent.ctx.todos]);

  // Fleet breakdown for the status-bar chip. Derived from `state.fleet`,
  // which the FleetBus event listeners already maintain — re-bucket
  // into running / idle / pending / completed because that's the slice
  // the user cares about at a glance. Recomputes on every state.fleet
  // change (cheap — fleet usually has <10 entries).
  const fleetCounts = useMemo(() => {
    const entries = Object.values(state.fleet);
    if (entries.length === 0) return undefined;
    let running = 0;
    let idle = 0;
    let completed = 0;
    for (const e of entries) {
      if (e.status === 'running') running += 1;
      else if (e.status === 'idle') idle += 1;
      else completed += 1; // success/failed/timeout/stopped all count as "done"
    }
    return { running, idle, pending: 0, completed };
  }, [state.fleet]);

  // Synthesize LEADER as AGENT#0 and prepend to the live fleet so the
  // monitor / FleetPanel are never empty even when no subagents have been
  // spawned. The 'leader' key can't collide with subagent IDs (those are
  // ULIDs). status maps from the high-level run state — streaming/running/
  // iterating → 'running', else 'idle'.
  const entriesWithLeader = useMemo<Record<string, FleetEntry>>(() => {
    const leaderEntry: FleetEntry = {
      id: 'leader',
      name: 'LEADER',
      provider: liveProvider,
      model: liveModel,
      status:
        state.status === 'running' || state.status === 'streaming' || state.leader.iterating
          ? 'running'
          : 'idle',
      streamingText: '',
      iterations: state.leader.iterations,
      toolCalls: state.leader.toolCalls,
      recentTools: state.leader.recentTools,
      recentMessages: [],
      // Leader (main session) cost — the same number the statusline shows.
      // Kept distinct from fleet (subagent) cost so the monitor can show a
      // trustworthy grand total = leader + fleet.
      cost: tokenCounter?.estimateCost().total ?? 0,
      startedAt: state.leader.startedAt,
      lastEventAt: state.leader.lastEventAt,
      currentTool: state.leader.currentTool,
      ctxPct: state.leader.ctxPct,
      ctxTokens: state.leader.ctxTokens,
      ctxMaxTokens: state.leader.ctxMaxTokens ?? effectiveMaxContext,
    };
    return { leader: leaderEntry, ...state.fleet };
  }, [state.fleet, state.leader, state.status, liveProvider, liveModel, effectiveMaxContext, tokenCounter]);

  // Plan counts come from `<sessionId>.plan.json` on disk, not React
  // state. We poll lazily every few ticks so the chip stays current
  // without slamming the FS — plans change at human pace (a few times
  // per session at most), so 3s granularity is plenty.
  const [planCounts, setPlanCounts] = useState<{
    open: number;
    inProgress: number;
    done: number;
  } | null>(null);
  useEffect(() => {
    const planPath = (agent.ctx.meta as Record<string, unknown>)['plan.path'];
    if (typeof planPath !== 'string' || !planPath) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fs.readFile(planPath, 'utf8');
        const parsed = JSON.parse(data) as {
          items?: Array<{ status?: string | undefined }>;
        };
        if (cancelled) return;
        if (!Array.isArray(parsed.items)) {
          setPlanCounts(null);
          return;
        }
        let open = 0;
        let inProgress = 0;
        let done = 0;
        for (const it of parsed.items) {
          if (it?.status === 'done') done++;
          else if (it?.status === 'in_progress') inProgress++;
          else open++;
        }
        setPlanCounts(open + inProgress + done > 0 ? { open, inProgress, done } : null);
      } catch {
        // Missing or corrupt — clear the chip.
        if (!cancelled) setPlanCounts(null);
      }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [agent.ctx.meta]);

  // Task counts — polled from <sessionId>.tasks.json, same 3s cadence.
  const [taskCounts, setTaskCounts] = useState<{
    pending: number;
    inProgress: number;
    completed: number;
    blocked: number;
    failed: number;
  } | null>(null);
  useEffect(() => {
    const taskPath = (agent.ctx.meta as Record<string, unknown>)['task.path'];
    if (typeof taskPath !== 'string' || !taskPath) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const data = await fs.readFile(taskPath, 'utf8');
        const parsed = JSON.parse(data) as {
          tasks?: Array<{ status?: string | undefined }>;
        };
        if (cancelled) return;
        if (!Array.isArray(parsed.tasks)) { setTaskCounts(null); return; }
        let pending = 0, inProgress = 0, completed = 0, blocked = 0, failed = 0;
        for (const t of parsed.tasks) {
          switch (t?.status) {
            case 'completed': completed++; break;
            case 'in_progress': inProgress++; break;
            case 'blocked': blocked++; break;
            case 'failed': failed++; break;
            default: pending++; break;
          }
        }
        const total = pending + inProgress + completed + blocked + failed;
        setTaskCounts(total > 0 ? { pending, inProgress, completed, blocked, failed } : null);
      } catch { if (!cancelled) setTaskCounts(null); }
    };
    void poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [agent.ctx.meta]);

  // Live-region shrink mitigation. Ink's log-update tracks the previous
  // render's logical line count; when content visually wraps past the
  // terminal width, the visual-row count exceeds the logical count and
  // log-update's clear-and-rewrite leaves the extra visual rows behind.
  // Those extras then slide into native scrollback as the next render
  // commits new Static items above the live region — looking to the user
  // like an extra echo of the input (the empty input sliding into
  // scrollback when Enter is pressed without text).
  //
  // We can't reach log-update directly, but we can issue an erase-below-
  // cursor (\x1b[J) at the moments most likely to leak: when a picker /
  // dialog transitions from open → closed (the live region's height
  // drops sharply), when a fresh history entry was just committed, and
  // when the terminal resizes (Ink re-renders the live region but the
  // cleanup logic above doesn't fire since none of its deps changed).
  // \x1b[J only touches what's below the cursor, so committed Static
  // history above is preserved.
  const prevAnyOverlayOpen = useRef(false);
  const prevEntriesCount = useRef(0);
  // Track tool-stream text length so we can fire eraseLiveRegion when the
  // live tool-output box grows — prevents the ◆ bash ⏱ Xms header line
  // from duplicating into scrollback on every 500ms tick.
  const prevToolStreamLen = useRef(0);
  // Stable erase function — only calls process.stdout.write which is a stable global.
  const eraseLiveRegion = useCallback(() => {
    try {
      // \x1b[J = erase from cursor to end of screen. The cursor sits at the
      // top of log-update's live region, so this clears the stale live
      // region only and leaves committed Static history (in scrollback)
      // untouched. Do NOT prefix with \x1b[H: homing to (0,0) wipes the
      // visible committed output and forces the input/status bar to redraw
      // at the top of the viewport instead of staying pinned to the bottom.
      writeOut('\x1b[J');
    } catch {
      // stdout might be detached during shutdown — ignore.
    }
  }, []);
  // useLayoutEffect fires synchronously in the commit phase, BEFORE Ink
  // flushes the new tree to the terminal. This means \x1b[J cleans the old
  // live region BEFORE new Static items are written — preventing stale
  // input/statusbar content from bleeding into scrollback.
  // useEffect (async microtask) was too late: the terminal had already
  // scrolled the old content into scrollback by the time it fired.
  React.useLayoutEffect(() => {
    const anyOpenNow =
      state.picker.open ||
      state.slashPicker.open ||
      state.modelPicker.open ||
      state.autonomyPicker.open ||
      state.designPicker.open ||
      state.resumePicker.open ||
      state.settingsPicker.open ||
      state.enhanceBusy ||
      state.enhance != null ||
      state.coordinator.monitorOpen ||
      state.escConfirm != null ||
      state.confirmQueue.length > 0;
    const overlayClosed = prevAnyOverlayOpen.current && !anyOpenNow;
    const newEntryCommitted = state.entries.length > prevEntriesCount.current;
    const curToolStreamLen = state.toolStream?.text.length ?? 0;
    const toolStreamGrew = curToolStreamLen > 0 && curToolStreamLen > prevToolStreamLen.current;
    prevAnyOverlayOpen.current = anyOpenNow;
    prevEntriesCount.current = state.entries.length;
    prevToolStreamLen.current = curToolStreamLen;
    if (overlayClosed || newEntryCommitted || toolStreamGrew) {
      eraseLiveRegion();
    }
  }, [
    state.picker.open,
    state.slashPicker.open,
    state.modelPicker.open,
    state.autonomyPicker.open,
    state.designPicker.open,
    state.settingsPicker.open,
    state.enhanceBusy,
    state.enhance,
    state.coordinator.monitorOpen,
    state.escConfirm,
    state.confirmQueue.length,
    state.entries.length,
    state.toolStream?.text,
    eraseLiveRegion,
  ]);

  // ── Terminal resize: close panels, let terminal settle, restore ──
  // When the terminal resizes, the terminal itself reflows visible text
  // BEFORE Ink can react. This reflow corrupts rendered content (Unicode
  // borders, ANSI-styled text, wrapped input) in a way that scrolls into
  // the terminal's native scrollback before Ink's next render can fix it.
  // By closing all overlays BEFORE the reflow, the live region shrinks to
  // its minimal height (input + status bar), which resizes cleanly. After
  // a short debounce the panels are restored at the new dimensions.
  const resizeGateRef = useRef(0);
  const preResizePanelsRef = useRef<{
    settings: boolean;
    projectPicker: boolean;
    help: boolean;
    monitor: boolean;
    agents: boolean;
    worktree: boolean;
    todos: boolean;
    queue: boolean;
    processList: boolean;
    goalPanel: boolean;
    sessionsPanel: boolean;
    coordinator: boolean;
  } | null>(null);
  const resizeRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    const handleResize = () => {
      // Debounce: terminal emitters often fire 2-3 resize events in quick
      // succession during a drag. Gate to one "close" cycle per burst, plus
      // one final "restore" at the end.
      const seq = ++resizeGateRef.current;

      // Capture current panel state from the latest render.
      preResizePanelsRef.current = {
        settings: stateRef.current.settingsPicker.open,
        projectPicker: stateRef.current.projectPicker.open,
        help: stateRef.current.helpOpen,
        monitor: stateRef.current.monitorOpen,
        agents: stateRef.current.agentsMonitorOpen,
        worktree: stateRef.current.worktreeMonitorOpen,
        todos: stateRef.current.todosMonitorOpen,
        queue: stateRef.current.queuePanelOpen,
        processList: stateRef.current.processListOpen,
        goalPanel: stateRef.current.goalPanelOpen,
        sessionsPanel: stateRef.current.sessionsPanelOpen,
        coordinator: stateRef.current.coordinator.monitorOpen,
      };

      // Close all open panels so the live region shrinks to input+statusbar.
      if (stateRef.current.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (stateRef.current.projectPicker.open) dispatch({ type: 'projectPickerClose' });
      if (stateRef.current.modelPicker.open) dispatch({ type: 'modelPickerClose' });
      if (stateRef.current.autonomyPicker.open) dispatch({ type: 'autonomyPickerClose' });
      if (stateRef.current.designPicker.open) dispatch({ type: 'designPickerClose' });
      if (stateRef.current.resumePicker.open) dispatch({ type: 'resumePickerClose' });
      if (stateRef.current.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      if (stateRef.current.picker.open) dispatch({ type: 'pickerClose' });
      if (stateRef.current.rewindOverlay) dispatch({ type: 'rewindOverlayClose' });
      if (stateRef.current.helpOpen) dispatch({ type: 'toggleHelp' });
      if (stateRef.current.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (stateRef.current.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (stateRef.current.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (stateRef.current.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (stateRef.current.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (stateRef.current.processListOpen) dispatch({ type: 'toggleProcessList' });
      if (stateRef.current.planPanelOpen) dispatch({ type: 'togglePlanPanel' });
      if (stateRef.current.goalPanelOpen) dispatch({ type: 'toggleGoalPanel' });
      if (stateRef.current.sessionsPanelOpen) dispatch({ type: 'toggleSessionsPanel' });

      eraseLiveRegion();

      // After the terminal settles at the new size, restore panels that
      // were open. The 300ms delay gives Ink time to re-render the minimal
      // live region at the new width before we grow it again.
      resizeRestoreTimerRef.current = setTimeout(() => {
        // Guard: if the component unmounted, don't dispatch.
        if (!mountedRef.current) return;
        // If another resize happened while we waited, discard this restore.
        if (resizeGateRef.current !== seq) return;
        const prev = preResizePanelsRef.current;
        if (!prev) return;
        if (prev.settings) {
          const sp = stateRef.current.settingsPicker;
          dispatch({
            type: 'settingsOpen',
            mode: sp.mode,
            delayMs: sp.delayMs,
            titleAnimation: sp.titleAnimation,
            yolo: sp.yolo,
            streamFleet: sp.streamFleet,
            chime: sp.chime,
            confirmExit: sp.confirmExit,
            nextPrediction: sp.nextPrediction,
            featureMcp: sp.featureMcp,
            featurePlugins: sp.featurePlugins,
            featureMemory: sp.featureMemory,
            featureSkills: sp.featureSkills,
            featureModelsRegistry: sp.featureModelsRegistry,
            tokenSavingTier: sp.tokenSavingTier,
            allowOutsideProjectRoot: sp.allowOutsideProjectRoot,
            contextAutoCompact: sp.contextAutoCompact,
            contextStrategy: sp.contextStrategy,
            contextMode: sp.contextMode,
            maxConcurrent: sp.maxConcurrent,
            logLevel: sp.logLevel,
            auditLevel: sp.auditLevel,
            indexOnStart: sp.indexOnStart,
            multiDiffSummaryThreshold: sp.multiDiffSummaryThreshold,
            lastSettingsField: sp.lastSettingsField,
            maxIterations: sp.maxIterations,
            autoProceedMaxIterations: sp.autoProceedMaxIterations,
            enhanceDelayMs: sp.enhanceDelayMs,
            enhanceEnabled: sp.enhanceEnabled,
            enhanceLanguage: sp.enhanceLanguage,
            debugStream: sp.debugStream,
            statuslineMode: sp.statuslineMode,
            reasoningMode: sp.reasoningMode,
            reasoningEffort: sp.reasoningEffort,
            reasoningPreserve: sp.reasoningPreserve,
            thinkingWord: sp.thinkingWord,
            cacheTtl: sp.cacheTtl,
            configScope: sp.configScope,
          });
        }
        if (prev.projectPicker) {
          const pp = stateRef.current.projectPicker;
          dispatch({ type: 'projectPickerOpen', items: pp.allItems });
        }
        if (prev.help) dispatch({ type: 'toggleHelp' });
        if (prev.monitor) dispatch({ type: 'toggleMonitor' });
        if (prev.agents) dispatch({ type: 'toggleAgentsMonitor' });
        if (prev.worktree) dispatch({ type: 'worktreeMonitorToggle' });
        if (prev.todos) dispatch({ type: 'toggleTodosMonitor' });
        if (prev.queue) dispatch({ type: 'toggleQueuePanel' });
        if (prev.processList) dispatch({ type: 'toggleProcessList' });
        if (prev.goalPanel) dispatch({ type: 'toggleGoalPanel' });
        if (prev.sessionsPanel) dispatch({ type: 'toggleSessionsPanel' });
        if (prev.coordinator) dispatch({ type: 'toggleCoordinatorMonitor' });
        preResizePanelsRef.current = null;
        resizeRestoreTimerRef.current = null;
      }, 300);
    };

    process.stdout.on('resize', handleResize);
    return () => {
      // Clear any pending resize-restore timer and mark the component
      // as unmounted so the callback doesn't dispatch to a dead reducer.
      if (resizeRestoreTimerRef.current) {
        clearTimeout(resizeRestoreTimerRef.current);
        resizeRestoreTimerRef.current = null;
      }
      mountedRef.current = false;
      process.stdout.off('resize', handleResize);
    };
  }, [eraseLiveRegion]);

  // While the prompt-refinement flow is active, the EnhancePanel's countdown
  // re-renders the live region every second. In inline mode each redraw can
  // bleed the region's top rows into native scrollback, so the preview
  // "clones" itself. Erase the stale region before every paint — no dep
  // array so this runs pre-flush on *every* render, not just state transitions.
  React.useLayoutEffect(() => {
    if (state.enhanceBusy || state.enhance != null) eraseLiveRegion();
  });

  // Detect an active `@<query>` token at the cursor and drive the picker.
  // Reruns whenever buffer/cursor changes — guards against stale results.
  useEffect(() => {
    const detected = detectAtToken(state.buffer, state.cursor);
    if (!detected) {
      if (state.picker.open) dispatch({ type: 'pickerClose' });
      return;
    }
    if (!state.picker.open || state.picker.query !== detected.query) {
      dispatch({ type: 'pickerOpen', query: detected.query });
    }
    let cancelled = false;
    searchFiles(projectRoot, detected.query, 8)
      .then((matches) => {
        if (!cancelled) {
          dispatch({ type: 'pickerSetMatches', query: detected.query, matches });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, state.cursor, projectRoot]);

  // Detect an active `/<query>` token at the cursor and drive the slash picker.
  useEffect(() => {
    const trimmed = state.buffer.trimStart();
    if (!trimmed.startsWith('/')) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    // Once any whitespace appears after the leading '/', the user has moved
    // past the command name into argument territory (e.g. `/model glm-5.1`).
    // Keeping the picker open here is actively harmful: arrow keys would
    // still target the command menu even though the user is typing args.
    // Close it so Enter submits the full line.
    if (/\s/.test(trimmed)) {
      if (state.slashPicker.open) dispatch({ type: 'slashPickerClose' });
      return;
    }
    const query = trimmed.slice(1).toLowerCase();
    const matches = buildSlashCommandMatches(slashRegistry.listWithOwner(), query);

    if (!state.slashPicker.open) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    } else if (state.slashPicker.query !== query) {
      dispatch({ type: 'slashPickerOpen', query, matches });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.buffer, slashRegistry]);

  const pasteClipboardImage = async (): Promise<void> => {
    const builder = builderRef.current;
    if (!builder) return;
    try {
      const img = await readClipboardImage();
      if (!img) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'No image on the clipboard.' },
        });
        return;
      }
      // Register-only: the token goes inline into the editable buffer (like a
      // pasted block) so it renders as a chip and expands from the buffer at
      // submit — not into a separate pill above the input.
      const token = await builder.registerImage(img.base64, img.mediaType);
      const kb = (img.bytes / 1024).toFixed(0);
      tokenPreviewsRef.current.set(token, `image, ${kb} KB`);
      const { buffer, cursor } = draftRef.current;
      const next = buffer.slice(0, cursor) + token + buffer.slice(cursor);
      setDraft(next, cursor + token.length);
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Clipboard image error: ${toErrorMessage(err)}`,
        },
      });
    }
  };

  // Ctrl+V → read text from the system clipboard and insert it. In raw mode the
  // terminal hands Ctrl+V to us as a control byte instead of doing a native
  // paste, and we never enable bracketed-paste mode, so without this nothing
  // happens. Route through commitPaste so long/multi-line content collapses to a
  // [pasted #N] chip exactly like a bracketed paste would.
  const pasteClipboardText = async (): Promise<void> => {
    try {
      const text = await readClipboardText();
      if (!text) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'No text on the clipboard.' },
        });
        return;
      }
      await commitPaste(text);
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Clipboard error: ${toErrorMessage(err)}`,
        },
      });
    }
  };

  const acceptPickerSelection = async (): Promise<void> => {
    const { open, matches, selected } = state.picker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const builder = builderRef.current;
    if (!builder) return;

    // Find the @-token span we're replacing.
    const draft = draftRef.current;
    const tok = detectAtToken(draft.buffer, draft.cursor);
    if (!tok) {
      dispatch({ type: 'pickerClose' });
      return;
    }

    // Register the file (no builder display mutation) and put a path-keyed
    // `[file:<path>]` token inline in the visible buffer (replacing @query).
    // The buffer is the single source of truth — the token expands back to the
    // file content at submit via the store's path lookup.
    const absPath = path.isAbsolute(picked) ? picked : path.join(projectRoot, picked);
    try {
      const data = await fs.readFile(absPath, 'utf8');
      const token = await builder.registerFile({
        kind: 'file',
        data,
        meta: { filename: picked, label: picked },
      });
      // Store the full file content so slash commands like /fix can resolve
      // @-mention tokens to their actual text instead of just the placeholder.
      tokenPreviewsRef.current.set(token, data);
      const before = draft.buffer.slice(0, tok.start);
      const after = draft.buffer.slice(tok.end);
      const next = `${before}${token}${after}`;
      setDraft(next, tok.start + token.length);
      dispatch({ type: 'pickerClose' });
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Attach failed: ${toErrorMessage(err)}`,
        },
      });
      dispatch({ type: 'pickerClose' });
    }
  };

  /** Fill the buffer with the selected slash command and close the picker. */
  const acceptSlashPickerSelection = (): void => {
    const { open, matches, selected } = state.slashPicker;
    if (!open || matches.length === 0) return;
    const picked = matches[selected];
    if (!picked) return;
    const cmd = picked.argsHint !== undefined ? `/${picked.name} ` : `/${picked.name}`;
    setDraft(cmd, cmd.length);
    dispatch({ type: 'slashPickerClose' });
  };

  // Rehydrate any queue items persisted by a previous (crashed) run.
  // Fires once at mount; the persist effect below picks up afterwards.
  // We dispatch one enqueue per item so the reducer's id allocation
  // stays the single source of truth — no need to import its internals.
  useEffect(() => {
    if (!queueStore) return;
    let cancelled = false;
    queueStore
      .read()
      .then((items) => {
        if (cancelled || items.length === 0) return;
        for (const item of items) {
          dispatch({
            type: 'enqueue',
            item: { displayText: item.displayText, blocks: item.blocks },
          });
        }
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Restored ${items.length} queued message${items.length === 1 ? '' : 's'} from a previous run.`,
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueStore]);

  // Persist the queue snapshot on every change. Strip the in-memory id
  // before writing — it's render bookkeeping, not part of the message.
  // Errors are swallowed: the queue lives in memory regardless, so a
  // persistence failure only loses crash-recovery, not the queue itself.
  useEffect(() => {
    if (!queueStore) return;
    queueStore
      .write(state.queue.map(({ displayText, blocks }) => ({ displayText, blocks })))
      .catch(() => undefined);
  }, [state.queue, queueStore]);

  // Mirror the queue snapshot to the host on every change (enqueue, /queue
  // delete, /queue clear, dequeue-for-delivery) so a running agent learns
  // what's waiting at its next iteration boundary — without the queued
  // messages being delivered early. See core's queued-messages.ts.
  useEffect(() => {
    onQueueChange?.(state.queue.map((q) => q.displayText));
  }, [state.queue, onQueueChange]);

  // Register the TUI-only /queue command for the lifetime of this App.
  useEffect(() => {
    const cmd = createQueueSlashCommand({
      getQueue: () => stateRef.current.queue,
      clear: () => dispatch({ type: 'queueClear' }),
      deleteAt: (positions) => dispatch({ type: 'queueDelete', positions }),
    });
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('queue');
    };
  }, [slashRegistry]);

  // Register /kill (list/kill tracked bash/exec processes) and /ps (list only).
  useEffect(() => {
    slashRegistry.register(createKillSlashCommand());
    slashRegistry.register(createPsSlashCommand());
    return () => {
      slashRegistry.unregister('kill');
      slashRegistry.unregister('ps');
    };
  }, [slashRegistry]);

  // Kill all tracked bash/exec processes when the TUI unmounts.
  // This fires on natural exit, Ctrl+C, and any other unmount path,
  // ensuring no orphaned child processes survive after the session ends.
  useEffect(() => {
    return () => {
      getProcessRegistry().killAll();
    };
  }, []);

  // `/steer <message>` — slash-command equivalent of Esc-to-steer.
  // Useful when Esc is consumed by an outer terminal multiplexer, or
  // when the user wants a single-shot redirect without the typed
  // follow-up (the message is the new direction). Performs the same
  // sequence the Esc handler does: snapshot context, abort the active
  // run, terminate the fleet, drop the queue, then sets steeringPending
  // so the message — submitted as the slash command's return — picks
  // up the rich STEERING preamble in the normal submit path.
  //
  // Unlike Esc, this slash command can be invoked at any state. When
  // the agent is idle the abort and fleet-termination are no-ops; the
  // steering preamble still gets prepended, which is harmless extra
  // context ("nothing was running") for the next turn.
  useEffect(() => {
    const cmd = {
      name: 'steer',
      description: 'Interrupt the running agent (incl. fleet) and redirect: /steer <new direction>',
      help: [
        'Usage: /steer <new direction>',
        '',
        'Aborts the active iteration, terminates any running subagents,',
        'drops queued messages, and sends your text to the model with a',
        'STEERING preamble explaining what was in flight and what the',
        'model is authorised to do (pivot hard, respawn subagents, ask',
        'for clarification). Equivalent to pressing Esc then typing.',
      ].join('\n'),
      async run(args: string) {
        const text = args.trim();
        if (!text) {
          return { message: 'Usage: /steer <new direction>' };
        }
        // Capture BEFORE mutating — same as the Esc handler.
        const s = stateRef.current;
        const runningTools = Array.from(s.runningTools.values()).map((t) => t.name);
        const subagents = Object.values(s.fleet)
          .filter((e) => e.status === 'running')
          .map((e) => ({ label: e.name, status: e.status, tool: e.currentTool?.name }));
        const subagentsTerminated = subagents.length;
        const partialAssistantText = streamingTextRef.current.slice(-1500);

        activeCtrlRef.current?.abort('user interrupt (/steer)');
        dispatch({
          type: 'steerStart',
          snapshot: { runningTools, subagents, subagentsTerminated, partialAssistantText },
        });
        const droppedCount = s.queue.length;
        if (droppedCount > 0) dispatch({ type: 'queueClear' });
        if (director && subagentsTerminated > 0) {
          const cap = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500);
            t.unref?.();
          });
          void Promise.race([director.terminateAll().catch(() => undefined), cap]);
        }

        // Build the full preamble + direction here, return it as the
        // slash command output's `runText` so the submit pipeline
        // sends THIS to the model instead of "/steer …".
        const preamble = buildSteeringPreamble(
          { runningTools, subagents, subagentsTerminated, partialAssistantText },
          text,
        );
        // Consume immediately — the runText below already carries the
        // preamble; the steeringPending flag would otherwise double up.
        dispatch({ type: 'steerConsume' });

        const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
        const fleetTag =
          subagentsTerminated > 0
            ? ` · stopped ${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'}`
            : '';
        return {
          message: `↯ Steering${droppedTag}${fleetTag}.`,
          runText: preamble,
        };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('steer');
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashRegistry, director]);

  // `/rewind` — open the checkpoint timeline overlay. If a checkpoint
  // index is provided as argument, rewinds directly to it.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- handleRewindTo is stable via useCallback
  useEffect(() => {
    const cmd = {
      name: 'rewind',
      description: 'Open checkpoint timeline to rewind session: /rewind [checkpoint-index]',
      help: [
        'Usage: /rewind [checkpoint-index]',
        '',
        'Opens a checkpoint timeline. Use ↑/↓ to navigate, Enter to rewind,',
        'Esc to cancel. The session is reverted to the selected checkpoint',
        'and conversation history is truncated — LLM continues fresh.',
        '',
        'If a checkpoint index is provided the timeline is skipped and',
        'rewind happens immediately.',
      ].join('\n'),
      async run(args: string) {
        const idx = Number.parseInt(args.trim(), 10);
        if (!Number.isNaN(idx) && idx >= 0) {
          handleRewindTo(idx);
          return {};
        }
        // No arg — open the timeline overlay
        const s = stateRef.current;
        if (s.checkpoints.length === 0) {
          return { message: 'No checkpoints in this session yet.' };
        }
        dispatch({ type: 'rewindOverlayOpen' });
        return {};
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('rewind');
    };
  }, [slashRegistry, handleRewindTo]);

  // `/agents` — bare `/agents` and `/agents monitor` toggle the overlay.
  // `/agents <id>` falls through to the CLI builtin (same-name registration
  // from the same 'core' owner is a no-op per SlashCommandRegistry semantics,
  // so we own the bare/monitor forms here and let the builtin handle IDs).
  useEffect(() => {
    const cmd = {
      name: 'agents',
      description: 'Toggle the agents monitor overlay.',
      async run(args: string) {
        const arg = args.trim().toLowerCase();
        if (!arg || arg === 'monitor') {
          dispatch({ type: 'toggleAgentsMonitor' });
          return { message: undefined };
        }
        // Any other arg falls through to the CLI builtin (same owner
        // 'core' re-registration = silently ignored). The builtin handles
        // onAgents UUID lookups and /agents on|off.
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd);
    return () => {
      slashRegistry.unregister('agents');
    };
  }, [slashRegistry]);

  // `/goal` is registered as a CLI builtin (packages/cli/src/slash-commands/
  // goal.ts) which handles both the preamble lock-in (the former TUI
  // behavior) and goal.json persistence for /autonomy eternal. The TUI
  // does NOT register its own /goal here — that would collide with the
  // builtin and throw "already registered" on mount.

  // Open routines shared by their slash command AND a mouse click on the
  // matching status-bar chip. Kept in refs (below) so the empty-dep mouse
  // handler can fire the latest version without re-subscribing.
  const openModelPicker = React.useCallback(async () => {
    if (!getPickableProviders) return;
    const providers = await getPickableProviders();
    dispatch({ type: 'modelPickerOpen', providers });
  }, [getPickableProviders]);
  const openProjectPicker = React.useCallback(async () => {
    if (!getProjectPickerItems) return;
    const items = await getProjectPickerItems();
    dispatch({ type: 'projectPickerOpen', items });
  }, [getProjectPickerItems]);
  const openFKeyPicker = React.useCallback(() => {
    dispatch({ type: 'fKeyPickerOpen' });
  }, [dispatch]);
  const loadLiveSessions = React.useCallback(async () => {
    if (!getLiveSessions) {
      // No-op: show empty state (busy stays false from initial state).
      // Do NOT dispatch busy:true — that would leave the panel stuck in
      // "Loading..." forever with no way for the user to dismiss it.
      dispatch({ type: 'sessionsPanelSet', sessions: [] });
      return;
    }
    dispatch({ type: 'sessionsPanelBusy', on: true });
    try {
      const sessions = await getLiveSessions();
      dispatch({ type: 'sessionsPanelSet', sessions });
    } catch {
      dispatch({ type: 'sessionsPanelBusy', on: false });
    }
  }, [getLiveSessions]);
  // Keep the F10 sessions panel live: refresh every 5s while open
  useEffect(() => {
    if (!state.sessionsPanelOpen || !getLiveSessions) return undefined;
    const t = setInterval(() => { void loadLiveSessions(); }, 5_000);
    return () => clearInterval(t);
  }, [state.sessionsPanelOpen, getLiveSessions, loadLiveSessions]);
  const openSettings = React.useCallback(() => {
    if (!getSettings) return;
    const s = getSettings();
    dispatch({
      type: 'settingsOpen',
      mode: s.mode,
      delayMs: s.delayMs,
      titleAnimation: s.titleAnimation ?? true,
      yolo: s.yolo ?? false,
      streamFleet: s.streamFleet ?? true,
      chime: s.chime ?? false,
      confirmExit: s.confirmExit ?? true,
      nextPrediction: s.nextPrediction ?? false,
      featureMcp: s.featureMcp ?? true,
      featurePlugins: s.featurePlugins ?? true,
      featureMemory: s.featureMemory ?? true,
      featureSkills: s.featureSkills ?? true,
      featureModelsRegistry: s.featureModelsRegistry ?? true,
      tokenSavingTier: s.featureTokenSaving ?? ('off' as TokenSavingTier),
      allowOutsideProjectRoot: s.allowOutsideProjectRoot ?? true,
      contextAutoCompact: s.contextAutoCompact ?? true,
      contextStrategy: s.contextStrategy ?? 'hybrid',
      contextMode: (s.contextMode as ContextMode) ?? 'balanced',
      maxConcurrent: s.maxConcurrent ?? 10,
      logLevel: s.logLevel ?? 'info',
      auditLevel: s.auditLevel ?? 'standard',
      indexOnStart: s.indexOnStart ?? true,
      multiDiffSummaryThreshold: s.multiDiffSummaryThreshold ?? 5,
      lastSettingsField: s.lastSettingsField ?? 0,
      maxIterations: s.maxIterations ?? 500,
      autoProceedMaxIterations: s.autoProceedMaxIterations ?? 50,
      enhanceDelayMs: s.enhanceDelayMs ?? 60_000,
      enhanceEnabled: s.enhanceEnabled ?? true,
      enhanceLanguage: (s.enhanceLanguage as 'original' | 'english') ?? 'original',
      debugStream: s.debugStream ?? false,
      statuslineMode: s.statuslineMode ?? 'detailed',
      reasoningMode: s.reasoningMode ?? 'auto',
      reasoningEffort: s.reasoningEffort ?? 'high',
      reasoningPreserve: s.reasoningPreserve ?? false,
      thinkingWord: s.thinkingWord ?? 'thinking',
      cacheTtl: s.cacheTtl ?? 'default',
      configScope: s.configScope ?? 'global',
    });
  }, [getSettings]);

  // NOTE: there is deliberately NO local "auto-proceed countdown" timer here.
  // The StatusBar's "⏳ auto in Ns" chip is driven exclusively by real
  // `countdown.tick` events (state.countdown) emitted while an actual
  // auto-proceed cooldown runs. A previous display-only local timer started
  // the moment autonomy flipped to 'auto' — with no suggestions and nothing
  // pending it showed a phantom 45s countdown on an idle, empty session,
  // then silently vanished. The real TUI-side countdown (with execution) is
  // the next-steps auto-submit below.

  // ── Next-steps auto-submit countdown ─────────────────────────────────
  // When autonomy is 'auto' and suggestions are available, start a countdown
  // on line 3 of the status bar. When it expires, auto-submit the first
  // suggestion. Autonomy is the USER'S setting — this loop never flips it
  // off. Runaway protection is the consecutive-turn cap instead
  // (settings `autoProceedMaxIterations`, same knob the REPL honors):
  // at the cap the loop pauses and waits for input; manual input re-arms it.
  //
  // Declared HERE (not with the countdown useState further down) because
  // `nextStepsRecheck` sits in the effect's deps array, which is evaluated
  // at render time — declaring it after the effect would TDZ-throw.
  // Consecutive auto-submitted turns since the last MANUAL input.
  const autoSubmitStreakRef = useRef(0);
  const autoSubmitCapWarnedRef = useRef(false);
  // Bumped on a slow poll while idle+auto with no suggestions, so the
  // auto-submit effect re-checks for suggestions that arrived out-of-band.
  const [nextStepsRecheck, setNextStepsRecheck] = useState(0);
  // A mode change is always a user action (the system never flips autonomy)
  // — re-arm the cap on any switch. Deliberately NOT tied to state.status:
  // every automatic turn passes through 'running', and resetting there
  // would defeat the cap entirely.
  useEffect(() => {
    autoSubmitStreakRef.current = 0;
    autoSubmitCapWarnedRef.current = false;
  }, [autonomyLive]);
  useEffect(() => {
    // Only run when idle and in auto mode
    if (state.status !== 'idle' || autonomyLive !== 'auto') {
      clearInterval(nextStepsAutoSubmitTimerRef.current);
      nextStepsAutoSubmitTimerRef.current = undefined;
      setNextStepsAutoSubmitCountdown(null);
      nextStepsAutoSubmitSuggestionRef.current = null;
      return;
    }

    // Don't start while enhance panel is active
    if (state.enhance != null || state.enhanceBusy) {
      return;
    }

    // Don't start if already counting down
    if (nextStepsAutoSubmitTimerRef.current != null) {
      return;
    }

    const suggestions = getSuggestions?.() ?? [];
    if (suggestions.length === 0) {
      // Suggestions can arrive while we sit idle (e.g. /suggest, a fleet
      // turn finishing) without any dep of this effect changing. Re-check
      // on a slow poll instead of waiting for the next status transition.
      const recheck = setTimeout(() => setNextStepsRecheck((t) => t + 1), 1_500);
      return () => clearTimeout(recheck);
    }

    const cfg = getSettings?.();

    // Consecutive-cap: pause (don't even show a countdown that won't fire)
    // once the streak hits the limit. 0 = unlimited (user's explicit choice).
    const maxAuto = cfg?.autoProceedMaxIterations ?? 50;
    if (maxAuto > 0 && autoSubmitStreakRef.current >= maxAuto) {
      if (!autoSubmitCapWarnedRef.current) {
        autoSubmitCapWarnedRef.current = true;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Auto-proceed paused after ${maxAuto} consecutive automatic turns — type anything to continue (autonomy stays on).`,
          },
        });
      }
      return;
    }

    // Use the same delay as auto-proceed countdown
    const delay = cfg?.delayMs ?? 45_000;

    // YOLO+auto mode: prefer auto suggestions (items with auto="true" attribute)
    const isYolo = getYolo?.() ?? false;
    const autoSuggestions = isYolo ? (getAutoSuggestions?.() ?? []) : [];
    const useAutoSuggestions = isYolo && autoSuggestions.length > 0;
    const top = useAutoSuggestions ? autoSuggestions[0] : suggestions[0];
    if (!top) return;

    // For YOLO+auto, apply the autonomy_next prompt template
    let promptToSubmit = top;
    if (useAutoSuggestions && autonomyNextPrompt) {
      promptToSubmit = autonomyNextPrompt.replace('{{suggestion}}', top);
    }

    nextStepsAutoSubmitSuggestionRef.current = promptToSubmit;
    const start = Date.now();
    setNextStepsAutoSubmitCountdown(Math.ceil(delay / 1000));
    setNextStepsAutoSubmitLabel(promptToSubmit);

    nextStepsAutoSubmitTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((delay - (Date.now() - start)) / 1000));
      if (remaining <= 0) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        // Auto-submit the suggestion
        const suggestion = nextStepsAutoSubmitSuggestionRef.current;
        nextStepsAutoSubmitSuggestionRef.current = null;
        if (suggestion) {
          autoSubmitStreakRef.current += 1;
          // Trigger submit — input field is cleared after submission completes
          // (see clearDraft in finally block below). Do not pre-populate the
          // input with the suggestion text.
          void (async () => {
            const trimmed = suggestion.trim();
            if (!trimmed) {
              clearDraft();
              return;
            }
            // Build blocks for the suggestion
            const blocks: ContentBlock[] = [{ type: 'text', text: trimmed }];
            dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed } });
            // Via ref: `runBlocks` is declared ~2000 lines below — naming it
            // in this effect's deps array evaluates it at render time and
            // throws a TDZ ReferenceError. The ref is only dereferenced when
            // the countdown fires, long after mount.
            try {
              await runBlocksRef.current(blocks);
            } finally {
              // Always clear the input field after submit, even on error.
              clearDraft();
            }
          })();
        }
      } else {
        setNextStepsAutoSubmitCountdown(remaining);
      }
    }, 500);

    return () => {
      clearInterval(nextStepsAutoSubmitTimerRef.current);
      nextStepsAutoSubmitTimerRef.current = undefined;
      setNextStepsAutoSubmitCountdown(null);
      setNextStepsAutoSubmitLabel(null);
    };
  }, [state.status, autonomyLive, state.enhance, state.enhanceBusy, nextStepsRecheck, getSettings, getSuggestions, dispatch]);

  // ── Auto-save settings on value change (←/→ arrow keys) ──
  // Gate ref: skip the first effect fire when settings just opened (all fields
  // were populated from getSettings(), so saving would be a no-op double-write).
  const settingsAutoSaveGateRef = useRef(true);

  // Reset the gate when settings opens.
  useEffect(() => {
    if (state.settingsPicker.open) {
      settingsAutoSaveGateRef.current = true;
    }
  }, [state.settingsPicker.open]);

  // Persist settings whenever a value field changes (mode, delayMs, toggles, …).
  // Does NOT fire on field-navigation (↑/↓) — only on value mutation (←/→).
  useEffect(() => {
    const sp = state.settingsPicker;
    const save = saveSettings;
    if (!sp.open || !save) return;

    if (settingsAutoSaveGateRef.current) {
      settingsAutoSaveGateRef.current = false;
      return;
    }

    Promise.resolve(save({
      mode: sp.mode,
      delayMs: sp.delayMs,
      titleAnimation: sp.titleAnimation,
      yolo: sp.yolo,
      streamFleet: sp.streamFleet,
      chime: sp.chime,
      confirmExit: sp.confirmExit,
      nextPrediction: sp.nextPrediction,
      featureMcp: sp.featureMcp,
      featurePlugins: sp.featurePlugins,
      featureMemory: sp.featureMemory,
      featureSkills: sp.featureSkills,
      featureModelsRegistry: sp.featureModelsRegistry,
      featureTokenSaving: sp.tokenSavingTier,
      allowOutsideProjectRoot: sp.allowOutsideProjectRoot,
      contextAutoCompact: sp.contextAutoCompact,
      contextStrategy: sp.contextStrategy,
      contextMode: sp.contextMode,
      maxConcurrent: sp.maxConcurrent,
      logLevel: sp.logLevel,
      auditLevel: sp.auditLevel,
      indexOnStart: sp.indexOnStart,
      multiDiffSummaryThreshold: sp.multiDiffSummaryThreshold,
      lastSettingsField: sp.lastSettingsField,
      maxIterations: sp.maxIterations,
      autoProceedMaxIterations: sp.autoProceedMaxIterations,
      enhanceDelayMs: sp.enhanceDelayMs,
      enhanceEnabled: sp.enhanceEnabled,
      enhanceLanguage: sp.enhanceLanguage,
      debugStream: sp.debugStream,
      statuslineMode: sp.statuslineMode,
      reasoningMode: sp.reasoningMode,
      reasoningEffort: sp.reasoningEffort,
      reasoningPreserve: sp.reasoningPreserve,
      thinkingWord: sp.thinkingWord,
      cacheTtl: sp.cacheTtl,
      configScope: sp.configScope,
    })).then((err: string | null) => {
      if (err) dispatch({ type: 'settingsHint', text: err });
    });
  }, [
    state.settingsPicker.open,
    state.settingsPicker.mode,
    state.settingsPicker.delayMs,
    state.settingsPicker.titleAnimation,
    state.settingsPicker.yolo,
    state.settingsPicker.streamFleet,
    state.settingsPicker.chime,
    state.settingsPicker.confirmExit,
    state.settingsPicker.nextPrediction,
    state.settingsPicker.featureMcp,
    state.settingsPicker.featurePlugins,
    state.settingsPicker.featureMemory,
    state.settingsPicker.featureSkills,
    state.settingsPicker.featureModelsRegistry,
    state.settingsPicker.tokenSavingTier,
    state.settingsPicker.allowOutsideProjectRoot,
    state.settingsPicker.contextAutoCompact,
    state.settingsPicker.contextStrategy,
    state.settingsPicker.contextMode,
    state.settingsPicker.maxConcurrent,
    state.settingsPicker.logLevel,
    state.settingsPicker.auditLevel,
    state.settingsPicker.indexOnStart,
    state.settingsPicker.maxIterations,
    state.settingsPicker.autoProceedMaxIterations,
    state.settingsPicker.enhanceDelayMs,
    state.settingsPicker.enhanceEnabled,
    state.settingsPicker.enhanceLanguage,
    state.settingsPicker.debugStream,
    state.settingsPicker.statuslineMode,
    state.settingsPicker.reasoningMode,
    state.settingsPicker.reasoningEffort,
    state.settingsPicker.reasoningPreserve,
    state.settingsPicker.thinkingWord,
    state.settingsPicker.cacheTtl,
    state.settingsPicker.configScope,
    saveSettings,
  ]);

  // Register the TUI-only `/model` command — opens a two-step picker
  // (provider → model). All work is local state mutation; the actual
  // switch fires only after the user confirms a model in step 2.
  useEffect(() => {
    if (!getPickableProviders || !switchProviderAndModel) return;
    const cmd = {
      name: 'model',
      aliases: ['provider', 'switch'],
      description: 'Pick a provider + model interactively (two-step).',
      async run() {
        await openModelPicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it can override a CLI built-in
    // of the same name (owner='tui' + official=true → claims the bare name).
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('model');
    };
  }, [slashRegistry, getPickableProviders, switchProviderAndModel, openModelPicker]);

  // Register the TUI-only `/f` command — opens the keyboard-navigable F-key panel picker.
  useEffect(() => {
    const cmd = {
      name: 'f',
      description: 'Open F-key panel picker. Arrow keys to navigate, Enter to open, Esc to close.',
      async run() {
        openFKeyPicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /f command. Without this, only /f 1..12 would work.
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('f');
    };
  }, [slashRegistry, openFKeyPicker]);

  // Register the TUI-only `/design` command. With no args it opens the visual
  // kit picker; with args it pins/clears like the CLI command. The picker's
  // Enter routes back through `/design <id> <stack>`, so this one handler
  // serves both the visual and typed paths.
  useEffect(() => {
    const cmd = {
      name: 'design',
      description: 'Open the Design Studio kit picker (or /design <kit> [stack] | off | foundations).',
      async run(args: string) {
        const loader = getDesignKitLoader(projectRoot);
        const tokens = (args ?? '').trim().split(/\s+/).filter(Boolean);
        const sub = tokens[0]?.toLowerCase();
        if (!sub) {
          const kits = await loader.listEntries();
          dispatch({ type: 'designPickerOpen', kits });
          return { message: undefined };
        }
        if (sub === 'off') {
          clearActiveKit(agent.ctx);
          await clearPersistedActiveKit(projectRoot);
          return { message: 'Cleared the active design kit.' };
        }
        if (sub === 'foundations') {
          return { runText: 'design foundations' };
        }
        const kit = await loader.find(sub);
        if (!kit) {
          const menu = await loader.menuText();
          return { message: `Unknown kit "${sub}".\n\n${menu}` };
        }
        const stackArg = tokens[1]?.toLowerCase();
        const stack = stackArg && isDesignStack(stackArg) ? stackArg : undefined;
        setActiveKit(agent.ctx, kit.id, stack);
        return { runText: `design use ${kit.id}${stack ? ` --stack ${stack}` : ''}` };
      },
    };
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('design');
    };
  }, [slashRegistry, projectRoot, agent]);

  // Register the TUI-only `/settings` command — opens the interactive
  // SettingsPicker immediately, same as Ctrl+S. Accepts an optional
  // row-name argument that jumps the picker to that row on open
  // (e.g. `/settings multi-diff` → opens the picker on the multi-diff
  // summary row). Gated on the settings accessors being wired by the
  // host (CLI passes them in).
  useEffect(() => {
    if (!getSettings || !saveSettings) return;
    const cmd = {
      name: 'settings',
      aliases: ['config', 'prefs'],
      description:
        'Open the settings editor, or set a value inline: /settings [<chord> [<value>]].',
      argsHint: '[<chord> [<value>]]',
      help:
        'Open the settings editor.\n\n' +
        '  /settings              Open on the last-visited row\n' +
        '  /settings <chord>      Open on that row\n' +
        '  /settings <chord> <v>  Set <chord> to <v> without opening the picker\n' +
        '  /settings reset <chord> Reset <chord> to its factory default\n\n' +
        'Examples:\n' +
        '  /settings yolo on      Enable YOLO mode\n' +
        '  /settings multi-diff 8  Set multi-diff threshold to 8\n' +
        '  /settings thinking-word pondering  Set the working-state word\n\n' +
        'Available chords:\n  ' +
        settingsPickerJumpNames().join('\n  '),
      async run(args: string) {
        const query = args.trim();
        if (query === '') {
          openSettings();
          return { message: undefined };
        }

        // `/settings reset <chord>` — reset a field to its factory default.
        if (query === 'reset' || query.startsWith('reset ')) {
          const subArg = query.slice('reset'.length).trim();
          if (subArg === '') {
            return {
              message: 'Usage: /settings reset <chord>\nAvailable: ' + settingsPickerJumpNames().join(', '),
            };
          }
          const field = settingsPickerJumpByName(subArg);
          if (field === undefined) {
            return {
              message:
                `Unknown settings row "${subArg}".\n` +
                `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
            };
          }
          const result = resetSettingsFieldValue(field);
          if (!result.ok) {
            return { message: result.error };
          }
          dispatch({ type: 'settingsValueSet', patch: result.patch });
          const cur = getSettings ? getSettings() : undefined;
          if (cur && saveSettings) {
            const { tokenSavingTier, ...rest } = result.patch;
            Promise.resolve(
              saveSettings({
                ...cur,
                ...rest,
                ...(tokenSavingTier !== undefined
                  ? { featureTokenSaving: tokenSavingTier }
                  : {}),
              }),
            ).then((err: string | null) => {
              if (err) dispatch({ type: 'settingsHint', text: err });
            });
          }
          return { message: `↺ ${result.label} reset to ${result.displayValue}` };
        }

        // Check for `<chord> <value>` syntax — a space separates the
        // row name from the value. Everything after the first space is
        // the value (allows multi-word values like "thinking-word").
        const spaceIdx = query.indexOf(' ');
        if (spaceIdx > 0) {
          const rowName = query.slice(0, spaceIdx);
          const valueStr = query.slice(spaceIdx + 1).trim();
          const field = settingsPickerJumpByName(rowName);
          if (field === undefined) {
            return {
              message:
                `Unknown settings row "${rowName}".\n` +
                `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
            };
          }
          if (valueStr === '') {
            // Trailing space but no value — fall back to navigation.
            dispatch({ type: 'settingsFieldSet', field });
            openSettings();
            return { message: undefined };
          }

          const result = resolveSettingsFieldValue(field, valueStr);
          if (!result.ok) {
            return { message: result.error };
          }

          // 1. Update runtime state so the picker (if opened later)
          //    reflects the change immediately.
          dispatch({ type: 'settingsValueSet', patch: result.patch });

          // 2. Persist to the canonical Settings shape. The auto-save
          //    effect only fires while the picker is open, so we do it
          //    manually here. The only key mapping is tokenSavingTier →
          //    featureTokenSaving; all others are identical.
          const cur = getSettings ? getSettings() : undefined;
          if (cur && saveSettings) {
            const { tokenSavingTier, ...rest } = result.patch;
            const updated: Settings = {
              ...cur,
              ...rest,
              ...(tokenSavingTier !== undefined
                ? { featureTokenSaving: tokenSavingTier }
                : {}),
            };
            Promise.resolve(saveSettings(updated)).then((err: string | null) => {
              if (err) dispatch({ type: 'settingsHint', text: err });
            });
          }

          return { message: `✓ ${result.label} → ${result.displayValue}` };
        }

        // Single token: navigation mode (open picker on that row).
        const field = settingsPickerJumpByName(query);
        if (field === undefined) {
          return {
            message:
              `Unknown settings row "${query}".\n` +
              `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
          };
        }
        dispatch({ type: 'settingsFieldSet', field });
        openSettings();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /settings command. Without this, only Ctrl+S could open the picker.
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('settings');
    };
  }, [slashRegistry, getSettings, saveSettings, openSettings, dispatch]);

  // Register the TUI-only `/settings-get` command — reads a setting's
  // current value and displays it as a chat message without opening the
  // picker. Counterpart to `/settings <chord> <value>`.
  useEffect(() => {
    const cmd = {
      name: 'settings-get',
      aliases: ['config-get', 'get'],
      description: 'Read a setting value without opening the picker.',
      argsHint: '<chord>',
      help:
        'Show the current value of a setting.\n\n' +
        'Examples:\n' +
        '  /settings-get yolo         → "YOLO mode: off"\n' +
        '  /settings-get multi-diff   → "Multi-diff summary: 5"\n' +
        '  /settings-get log-level    → "Log level: info"\n\n' +
        'Available chords:\n  ' +
        settingsPickerJumpNames().join('\n  '),
      async run(args: string) {
        const query = args.trim();
        if (query === '') {
          // No argument: show all settings as a compact grouped summary.
          return { message: formatAllSettingsSummary(state.settingsPicker) };
        }
        const field = settingsPickerJumpByName(query);
        if (field === undefined) {
          return {
            message:
              `Unknown settings row "${query}".\n` +
              `Available chords:\n  ${settingsPickerJumpNames().join('\n  ')}`,
          };
        }
        const result = getSettingsFieldValue(state.settingsPicker, field);
        if (!result.ok) {
          return { message: result.error };
        }
        return { message: `${result.label}: ${result.displayValue}` };
      },
    };
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('settings-get');
    };
  }, [slashRegistry, state.settingsPicker]);

  // Register the TUI-only `/statusline` command — opens the interactive
  // StatuslinePicker overlay. Arguments (item, on|off) are handled here too
  // because official TUI commands do not fall through to the CLI builtin.
  useEffect(() => {
    const cmd = {
      name: 'statusline',
      aliases: ['sl'],
      description: 'Customize status bar chips: /statusline (interactive) or /statusline <item> [on|off]',
      async run(args: string) {
        const trimmed = args.trim();
        if (trimmed) {
          const [rawItem, rawAction] = trimmed.split(/\s+/);
          const item = rawItem as StatuslineItem | 'all' | 'reset' | undefined;
          const action = rawAction?.toLowerCase();
          const applyHidden = (items: StatuslineItem[]) => {
            const deduped = [...new Set(items)];
            hiddenItemsRef.current = deduped;
            setHiddenItems(deduped);
          };

          if (item === 'reset') {
            applyHidden([]);
            return { message: 'StatusBar config reset to defaults.' };
          }

          if (item === 'all') {
            if (action !== 'on' && action !== 'off') {
              return { message: 'Usage: /statusline all on|off' };
            }
            applyHidden(action === 'off' ? [...STATUSLINE_ITEMS] : []);
            return { message: `statusline all: ${action === 'on' ? 'showing all chips' : 'hiding all chips'}` };
          }

          if (!item || !STATUSLINE_ITEMS.includes(item as StatuslineItem)) {
            return { message: `Unknown item "${rawItem ?? ''}". Run /statusline to see available items.` };
          }

          if (action !== undefined && action !== 'on' && action !== 'off') {
            return { message: `Usage: /statusline ${item} on|off` };
          }

          const hidden = new Set<StatuslineItem>(hiddenItemsRef.current);
          const nextVisible = action ? action === 'on' : hidden.has(item);
          if (nextVisible) hidden.delete(item);
          else hidden.add(item);
          applyHidden([...hidden]);
          return { message: `statusline ${item}: ${nextVisible ? 'on' : 'off'}` };
        }
        openStatuslinePicker();
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /statusline command when called without arguments.
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('statusline');
    };
  }, [slashRegistry, openStatuslinePicker, setHiddenItems]);

  // Register the TUI-only `/mailbox` command — toggles the mailbox panel.
  useEffect(() => {
    const cmd = {
      name: 'mailbox',
      aliases: ['inbox', 'mail'],
      description: 'Toggle the inter-agent mailbox panel — messages, read receipts, online agents.',
      async run() {
        setMailboxPanelOpen((prev) => !prev);
        return { message: undefined };
      },
    };
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('mailbox');
    };
  }, [slashRegistry]);

  // Register the TUI-only `/autonomy` command — opens a single-step picker.
  // When the user types `/autonomy` with no arg, the picker appears.
  // If they type `/autonomy off` etc. with an arg, the CLI builtin handles it.
  useEffect(() => {
    if (!switchAutonomy) return;
    const cmd = {
      name: 'autonomy',
      aliases: ['auto'],
      description: 'Pick an autonomy mode interactively (picker).',
      async run() {
        dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /autonomy command. Opens the interactive picker instead.
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('autonomy');
    };
  }, [slashRegistry, switchAutonomy]);

  // Register the TUI-only `/resume` command — opens the session resume picker.
  // Lists recent sessions; selecting one triggers onResumeSession to load and
  // replay the full conversation history.
  useEffect(() => {
    const cmd = {
      name: 'resume',
      aliases: ['load'],
      description: 'Resume a previous session — pick from a list of recent sessions.',
      async run() {
        if (!listSessions) {
          return { message: 'Session listing not available.' };
        }
        try {
          const sessions = await listSessions(20);
          if (sessions.length === 0) {
            return { message: 'No saved sessions.' };
          }
          dispatch({ type: 'resumePickerOpen', sessions });
        } catch (err) {
          return {
            message: toErrorMessage(err),
          };
        }
        return { message: undefined };
      },
    };
    // Register as an official TUI plugin so it overrides the CLI's text-based
    // /resume command (which is an alias on /sessions).
    slashRegistry.register(cmd, 'tui', { official: true });
    return () => {
      slashRegistry.unregister('resume');
    };
  }, [slashRegistry, listSessions]);

  // Subscribe to provider streaming events.
  useEffect(() => {
    // Throttle stream delta DISPATCHES to reduce flicker — we batch into
    // React state at ~10fps. The full text is also written into
    // streamingTextRef synchronously on every delta, so `runBlocks` can
    // read the complete stream when `agent.run` returns without racing
    // the throttle's last unflushed batch.
    const FLUSH_MS = 100;
    const flush = () => {
      if (pendingDeltaRef.current) {
        dispatch({ type: 'streamDelta', delta: pendingDeltaRef.current });
        pendingDeltaRef.current = '';
      }
      flushTimerRef.current = null;
    };
    const offDelta = events.on('provider.text_delta', (e) => {
      // Strip any bracketed-paste DCS sequences that some providers echo
      // into the stream. They are invisible in a real terminal but appear as
      // junk text if Ink's raw rendering catches them. The ESC byte is
      // matched optionally — a stripped/split ESC would otherwise leave a
      // bare `[200~` in the rendered text (same failure as the input path).
      const text = e.text.replace(/\x1b?\[200~|\x1b?\[201~/g, '');
      streamingTextRef.current += text;
      pendingDeltaRef.current += text;
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    });
    const offToolStart = events.on('tool.started', (e) => {
      dispatch({ type: 'toolStarted', id: e.id, name: e.name });
      dispatch({ type: 'leaderToolStart', name: e.name });
    });
    const offIterStart = events.on('iteration.started', () => {
      dispatch({ type: 'leaderIterStart' });
    });
    const offIterEnd = events.on('iteration.completed', () => {
      dispatch({ type: 'leaderIterEnd' });
    });
    const offToolProgress = events.on('tool.progress', (e) => {
      // Only `partial_output` becomes the live tail. Other event kinds
      // (`log`, `warning`, `metric`, `file_changed`) are deliberately not
      // rendered here — they pile up too fast and would steal screen real
      // estate from the assistant text. They still flow through EventBus
      // for observability/metrics consumers.
      if (e.event.type !== 'partial_output' || !e.event.text) return;
      dispatch({
        type: 'toolStreamAppend',
        toolUseId: e.id,
        name: e.name,
        text: e.event.text,
        startedAt: Date.now(),
      });
    });
    const offTool = events.on('tool.executed', (e) => {
      // `delegate` renders its own readable start/finish lines via the
      // delegate.started / delegate.completed events below — skip the
      // generic tool entry so history doesn't also show the big JSON blob.
      if (e.name !== 'delegate') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'tool',
            name: e.name,
            durationMs: e.durationMs,
            ok: e.ok,
            input: e.input,
            output: e.output,
            // Real model-visible sizes — forwarded so the size chip beside
            // the tool header can show what the model paid for instead of
            // the misleading preview-byte count we used to surface.
            outputBytes: e.outputBytes,
            outputTokens: e.outputTokens,
            outputLines: e.outputLines,
          },
        });
      }
      // `tool.executed` has no tool_use id; the reducer falls back to
      // clearing the oldest running entry that matches this name.
      dispatch({ type: 'toolEnded', name: e.name });
      // Clear the live tail for this tool — the final entry is now in
      // <Static>, no need to keep mirroring it below.
      dispatch({ type: 'toolStreamClear', name: e.name });
      // Mirror into the leader-only counter so the AgentsMonitor's LEADER
      // row stays live even when no subagents exist.
      dispatch({ type: 'leaderToolEnd', name: e.name, ok: e.ok, durationMs: e.durationMs });
      // Echo the current todo list into chat whenever the `todo` tool
      // mutates ctx.todos — same format as `/todos list`. Snapshotted from
      // agent.ctx.todos at this point (the tool executor has already
      // applied the mutation by the time tool.executed fires).
      if (e.ok && e.name === 'todo') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: formatTodosList(agent.ctx.todos) },
        });
      }
    });
    const offRetry = events.on('provider.retry', (e) => {
      const secs = (e.delayMs / 1000).toFixed(e.delayMs >= 1000 ? 1 : 2);
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `⟳ retry ${e.attempt} in ${secs}s — ${e.description}` },
      });
    });
    const offProvErr = events.on('provider.error', (e) => {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: e.description },
      });
    });
    // Fallback hop — the chain rotated to a working model after the primary's
    // retries were exhausted. Surface which model is now answering.
    const offFallback = events.on('provider.fallback', (e) => {
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'warn',
          text: `↻ rate-limited (${e.status}) — switched to ${e.to.providerId}/${e.to.model}`,
        },
      });
    });
    // Per-iteration text flush. Without this, the entire run buffers all text
    // deltas in the live tail box and dumps them into history as ONE assistant
    // entry only after `agent.run()` returns. Tool results, in contrast, land
    // in history immediately via `tool.executed` — so a multi-iteration turn
    // renders as "all tools, then a wall of text" instead of the natural
    // text → tool → text → tool interleaving that matches the actual stream.
    //
    // We hook `provider.response` (fires once per LLM call, both for
    // intermediate `tool_use` stops and the final `end_turn`) and commit
    // whatever has accumulated in `streamingTextRef` as an assistant history
    // entry. The next iteration's deltas start a fresh buffer. `runBlocks`
    // becomes purely the loop driver — it no longer adds the assistant entry,
    // since the per-iteration flushes have already done so.
    const offProvResp = events.on('provider.response', () => {
      const text = streamingTextRef.current;
      streamingTextRef.current = '';
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });
      if (text.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text } });
      }
    });
    const offConfirmNeeded = events.on('tool.confirm_needed', (e) => {
      // Only show the ConfirmPrompt component — no duplicate history entry needed.
      // The full ConfirmPrompt with y/n/a/d keys is rendered below;
      // the history placeholder was redundant.
      dispatch({
        type: 'confirmOpen',
        info: {
          toolUseId: e.toolUseId,
          toolName: e.tool.name,
          input: e.input,
          suggestedPattern: e.suggestedPattern,
          resolve: e.resolve,
        },
      });
    });
    const offTrustPersisted = events.on('trust.persisted', (e) => {
      const icon = e.decision === 'always' ? '✓' : '✗';
      const label = e.decision === 'always' ? 'always allowed' : 'denied';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'info',
          text: `${icon} ${label}: ${e.tool}(${e.pattern})`,
        },
      });
    });
    // `delegate` lifecycle — render a "started" line up front (so the
    // minutes-long subagent wait doesn't look idle) and a humanized result
    // line on completion. These replace the suppressed generic tool entry.
    const offDelegateStart = events.on('delegate.started', (e) => {
      const task = e.task.length > 100 ? `${e.task.slice(0, 99)}…` : e.task;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: e.target,
          agentColor: 'magenta',
          icon: '🤝',
          text: 'delegating',
          detail: task,
        },
      });
    });
    const offDelegateDone = events.on('delegate.completed', (e) => {
      const cost = e.costUsd && e.costUsd > 0 ? `$${e.costUsd.toFixed(4)}` : undefined;
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'subagent',
          agentLabel: e.target,
          agentColor: e.ok ? 'green' : 'red',
          icon: e.ok ? '✓' : '✗',
          text: e.summary,
          detail: cost,
        },
      });
    });
    return () => {
      offDelta();
      offToolStart();
      offIterStart();
      offIterEnd();
      offToolProgress();
      offTool();
      offRetry();
      offProvErr();
      offFallback();
      offProvResp();
      offConfirmNeeded();
      offTrustPersisted();
      offDelegateStart();
      offDelegateDone();
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, [events, agent.ctx.todos]);

  // ── Client status reporting ─────────────────────────────────────────────────
  // Emit client.status events to the EventBus so the WebUI and other clients
  // can display real-time stats. This drives the FleetHQ map HUD and the
  // JSON status file written by setup-events.ts.
  useEffect(() => {
    if (!clientId || !events) return;

    // Track cumulative stats for client.status events
    let toolCalls = 0;

    const emitStatus = (): void => {
      const usage = tokenCounter?.total();
      const cost = tokenCounter?.estimateCost();
      const mode = getAutonomy?.() ?? 'off';
      events.emit('client.status', {
        clientType: 'tui',
        clientId,
        projectHash: agent.ctx.projectRoot ? projectSlug(agent.ctx.projectRoot) : 'unknown',
        agentCount: 1, // TUI is a single leader agent
        model: agent.ctx.model,
        mode,
        toolCalls,
        inputTokens: usage?.input ?? 0,
        outputTokens: usage?.output ?? 0,
        cacheTokens: (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0),
        costUsd: cost?.total ?? 0,
        timestamp: Date.now(),
        projectSlug: agent.ctx.projectRoot ? projectSlug(agent.ctx.projectRoot) : 'unknown',
      });
    };

    const offTool = events.on('tool.executed', () => {
      toolCalls++;
      emitStatus();
    });

    const offProviderResp = events.on('provider.response', () => {
      emitStatus();
    });

    const offIterCompleted = events.on('iteration.completed', () => {
      emitStatus();
    });

    // Emit initial status
    emitStatus();

    return () => {
      offTool();
      offProviderResp();
      offIterCompleted();
    };
  }, [events, clientId, tokenCounter, getAutonomy, agent.ctx.model, agent.ctx.projectRoot]);

  // ── Debug-stream callback bridge ──
  // The CLI passes a registerDebugStreamCallback prop; this effect
  // installs it once on mount and tears it down on unmount.
  // The callback translates throttled DebugStreamStats from
  // stream-debug-state.ts into reducer dispatches so the stats render
  // inside Ink's StatusBar line 3 instead of bypassing the layout.
  useEffect(() => {
    if (!registerDebugStreamCallback) return;

    let cancelled = false;
    registerDebugStreamCallback((stats) => {
      if (cancelled) return;
      dispatch({
        type: 'debugStreamStats',
        chunkCount: stats.chunkCount,
        lastChunkSize: stats.lastChunkSize,
        lastDeltaMs: stats.lastDeltaMs,
        totalBytes: stats.totalBytes,
        lastChunkAt: stats.lastChunkAt,
      });
    });

    // Clear stats on every provider.response (per-iteration stream reset).
    const offResp = events.on('provider.response', () => {
      dispatch({ type: 'debugStreamStatsClear' });
    });
    const offErr = events.on('provider.error', () => {
      dispatch({ type: 'debugStreamStatsClear' });
    });

    return () => {
      cancelled = true;
      offResp();
      offErr();
      restoreDebugStreamCallback?.();
    };
  }, [events, registerDebugStreamCallback, restoreDebugStreamCallback]);

  // Live mirror of the prompt-refinement toggle, read synchronously inside
  // submit() (which can't see the latest reducer state through its closure).
  const enhanceEnabledRef = useRef(state.enhanceEnabled);
  useEffect(() => {
    enhanceEnabledRef.current = state.enhanceEnabled;
  }, [state.enhanceEnabled]);
  // Abort handle for the in-flight refiner call, so Esc can cancel a slow
  // "refining..." and send the original immediately.
  const enhanceAbortRef = useRef<AbortController | null>(null);

  // Seconds remaining in the prompt-refinement auto-send countdown. Lifted
  // out of EnhancePanel so the statusline can display it — panel re-renders
  // during the countdown were causing blank entries in chat scrollback.
  const [enhanceCountdown, setEnhanceCountdown] = useState<number | null>(null);

  // Next-steps auto-submit countdown state: seconds remaining and the suggestion text.
  // When autonomy is 'auto' and suggestions exist, this countdown auto-submits the first suggestion.
  const [nextStepsAutoSubmitCountdown, setNextStepsAutoSubmitCountdown] = useState<number | null>(null);
  const [nextStepsAutoSubmitLabel, setNextStepsAutoSubmitLabel] = useState<string | null>(null);
  const nextStepsAutoSubmitSuggestionRef = useRef<string | null>(null);
  const nextStepsAutoSubmitTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useTuiEventBridge({
    events,
    dispatch,
    stateRef,
    setActiveMaxContext,
    subscribeAutoPhase,
    onClearHistory,
  });

  useTuiControllers({
    dispatch,
    streamFleet: state.streamFleet,
    enhanceEnabled: state.enhanceEnabled,
    agentsMonitorOpen: state.agentsMonitorOpen,
    fleetStreamController,
    enhanceController,
    agentsMonitorController,
    onPanelOpen,
  });

  // Install the leader-abort handler for the /interrupt slash command. Slash
  // commands don't get the RunController, so the command can't stop the current
  // iteration on its own — it calls this. The fleet teardown is /interrupt's
  // own onFleetKill, so this only aborts the leader + flips the status. Because
  // slash commands dispatch even mid-run in the TUI, /interrupt stops a run
  // that is wedged retrying a 429.
  useEffect(() => {
    if (!interruptController) return;
    interruptController.abortLeader = () => {
      if (stateRef.current.status === 'idle') return false;
      activeCtrlRef.current?.abort('user interrupt (/interrupt)');
      dispatch({ type: 'status', status: 'aborting' });
      return true;
    };
  }, [interruptController, dispatch, stateRef]);

  // Track double-Esc for input buffer clearing.
  const lastEscAtRef = useRef(0);
  const ESC_DOUBLE_PRESS_MS = 1000;

  useDirectorFleetBridge({
    director,
    dispatch,
    stateRef,
    streamFleet: state.streamFleet,
  });

  // Handle SIGINT as a three-stage escalation:
  //   1st press — stop work and stay at the prompt: cancel the foreground
  //     run + kill the fleet, OR (in autonomy / background-only mode) halt
  //     the engines + terminate the fleet. Pickers cancel instead.
  //   2nd press — exit: graceful Ink unmount (restores the terminal) with a
  //     hard-exit fallback timer in case the React tree is wedged.
  //   3rd press — immediate process.exit, so a wedged Ink loop can't trap
  //     the user.
  useEffect(() => {
    const onSigint = () => {
      const current = stateRef.current;
      // Second (or later) Ctrl+C — exit no matter what. Status may be
      // 'aborting', 'running', or 'streaming'; the user has clearly
      // decided they want out. Try Ink's graceful exit first, then
      // hard-exit on a short timer in case the React tree is wedged.
      if (current.interrupts >= 1) {
        // Second (or later) Ctrl+C — the user wants out. Force-kill tracked
        // processes regardless of state.
        getProcessRegistry().killAll({ force: true });
        // If we already asked Ink to unmount and the user pressed again, the
        // React tree is wedged — hard-exit immediately.
        if (exitRequestedRef.current) {
          process.exit(130);
        }
        exitRequestedRef.current = true;
        dispatch({ type: 'interrupt' });
        // Terminate any lingering fleet so subagents don't outlive the TUI.
        if (director) void director.terminateAll().catch(() => undefined);
        // Graceful Ink unmount first: it restores the terminal (raw mode off,
        // cursor shown) and routes the 130 exit code
        // through run-tui's settle(). A bare process.exit() here would skip
        // that and can leave the terminal in raw mode — the "exit feels
        // broken" symptom. Fall back to a hard exit if Ink never unmounts.
        onExit(130);
        exit();
        const hardExit = setTimeout(() => process.exit(130), 400);
        hardExit.unref?.();
        return;
      }
      dispatch({ type: 'interrupt' });

      // Pickers are safe to cancel outright — closing the overlay
      // restores the previous state cleanly with no side-effects.
      // Do this first so a single Ctrl+C from the model picker or
      // slash picker exits gracefully instead of doing nothing.
      if (current.modelPicker.open) {
        dispatch({ type: 'modelPickerClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Model picker cancelled.' },
        });
        return;
      }
      if (current.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Settings cancelled.' },
        });
        return;
      }
      if (current.slashPicker.open) {
        dispatch({ type: 'slashPickerClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: 'Cancelled.' },
        });
        return;
      }

      if (activeCtrlRef.current) {
        activeCtrlRef.current.abort('user interrupt (Ctrl+C)');
        dispatch({ type: 'status', status: 'aborting' });
        // Kill every running subagent on the first interrupt — without
        // this the parent agent.run() stays parked in `await delegate
        // → director.awaitTasks` forever and the "press again to exit"
        // hint becomes a lie.
        //
        // We `await` terminateAll AND race a 1500ms cap so a stuck
        // bridge or hung tool can't trap us in cleanup — the user
        // pressed Ctrl+C; their patience is finite. The second
        // Ctrl+C still forces exit immediately via the path above,
        // so this race only matters for the polite-shutdown window.
        if (director) {
          const cap = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500);
            t.unref?.();
          });
          void Promise.race([director.terminateAll().catch(() => undefined), cap]);
        }
        // Kill all tracked bash/exec processes from the process registry.
        // This ensures runaway child processes (including background bashes
        // that outlive the agent iteration) are cleaned up on Ctrl+C.
        const killed = getProcessRegistry().killAll();
        const procTag =
          killed.length > 0
            ? ` + killed ${killed.length} process${killed.length === 1 ? '' : 'es'}`
            : '';
        const droppedCount = stateRef.current.queue.length;
        if (droppedCount > 0) {
          dispatch({ type: 'queueClear' });
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}${procTag}. Dropped ${droppedCount} queued message${droppedCount === 1 ? '' : 's'}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
            },
          });
        } else {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `Iteration cancelled${director ? ' + fleet terminated' : ''}${procTag}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
            },
          });
        }
      } else {
        // No foreground (runBlocks) controller. We may still have background
        // work with no AbortController of its own: an autonomy engine driving
        // iterations, or a fleet of subagents. Eternal/parallel loops never
        // set activeCtrlRef, so this branch is the ONLY place their Ctrl+C is
        // handled — the first press must actually stop that work (and return
        // to the prompt), not merely announce "press again to exit".
        const fleetRunning = Object.values(current.fleet).filter(
          (e) => e.status === 'running',
        ).length;
        const autonomyRunning =
          eternalLoopRunningRef.current ||
          parallelLoopRunningRef.current ||
          getEternalEngine?.()?.currentState === 'running' ||
          getParallelEngine?.()?.currentState === 'running';
        // A `/sdd parallel` run drives its own coordinator (not the autonomy
        // engines / director fleet), so it must be stopped explicitly here — it's
        // the only Ctrl+C path while the run blocks the prompt.
        const sddRun = getSddRun?.();
        const sddRunning = sddRun?.isRunning() ?? false;
        if (autonomyRunning || fleetRunning > 0 || sddRunning) {
          // Halt the engines first — eternal's stop() aborts the in-flight
          // iteration; both flip their persisted state to 'stopped'. Then
          // flip autonomy off so the driver loop won't start another
          // iteration, and terminate the fleet + tracked processes.
          getEternalEngine?.()?.stop();
          getParallelEngine?.()?.stop();
          if (sddRunning) sddRun?.stop();
          if (autonomyRunning) switchAutonomy?.('off');
          if (director) {
            const cap = new Promise<void>((resolve) => {
              const t = setTimeout(resolve, 1500);
              t.unref?.();
            });
            void Promise.race([director.terminateAll().catch(() => undefined), cap]);
          }
          const killed = getProcessRegistry().killAll();
          const bits: string[] = [];
          if (autonomyRunning) bits.push('autonomy stopped');
          if (sddRunning) bits.push('SDD run stopped');
          if (fleetRunning > 0)
            bits.push(`${fleetRunning} agent${fleetRunning === 1 ? '' : 's'} terminated`);
          if (killed.length > 0)
            bits.push(`${killed.length} process${killed.length === 1 ? '' : 'es'} killed`);
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'warn',
              text: `${bits.join(' + ') || 'Background work stopped'}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
            },
          });
          return;
        }
        // Truly idle — nothing running. Kill any lingering processes and arm
        // the second-press exit.
        const killed = getProcessRegistry().killAll();
        const procTag =
          killed.length > 0
            ? ` Killed ${killed.length} process${killed.length === 1 ? '' : 'es'}.`
            : '';
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `Press Ctrl+C again to exit.${procTag}` },
        });
      }
    };
    process.on('SIGINT', onSigint);
    return () => {
      process.off('SIGINT', onSigint);
    };
  }, [director, getEternalEngine, getParallelEngine, getSddRun, switchAutonomy, onExit, exit]);

  // Finalize a fully-assembled paste payload. A collapse-worthy paste (long
  // or many-lined) or any multi-line paste becomes an inline `[pasted #N, L
  // lines]` chip in the editable row — the content lives in the AttachmentStore
  // and is expanded from the buffer at submit. A short single-line paste is
  // inserted straight into the row as raw text so the user can see and edit it.
  //
  // Exception: when the buffer starts with `/` (slash command), the paste
  // content is the command's argument — collapsing it to a chip would make
  // commands like `/fix` classify the placeholder text instead of the actual
  // error. Still collapse only truly massive pastes (>collapse threshold)
  // since they won't fit a CLI command line anyway.
  const commitPaste = async (full: string): Promise<void> => {
    const builder = builderRef.current;
    if (!builder || !full) return;
    const { buffer, cursor } = draftRef.current;
    const isSlashCmd = buffer.trimStart().startsWith('/');
    const mustCollapse = builder.wouldCollapse(full);
    const multiLine = full.includes('\n');

    if (isSlashCmd && !mustCollapse) {
      // Slash command: inline the paste so the command handler sees the real
      // content instead of a `[pasted #N]` placeholder. Multi-line content is
      // fine — slash command args span the rest of the line, newlines included.
      const next = buffer.slice(0, cursor) + full + buffer.slice(cursor);
      setDraft(next, cursor + full.length);
      return;
    }

    if (mustCollapse || multiLine) {
      // Register-only: store the paste, get back the inline token. The token
      // goes into the buffer (single source of truth); nothing is appended to
      // the builder's own display, so there's no double-expansion at submit.
      const token = await builder.registerPaste(full);
      // Store the full paste so slash commands like /fix can see the entire
      // content. Display truncation (6-line preview) happens at render time.
      tokenPreviewsRef.current.set(token, full);
      const next = buffer.slice(0, cursor) + token + buffer.slice(cursor);
      setDraft(next, cursor + token.length);
      return;
    }
    const next = buffer.slice(0, cursor) + full + buffer.slice(cursor);
    setDraft(next, cursor + full.length);
  };

  const handleKey = async (input: string, key: KeyEvent) => {
    // Note: we no longer block input while the agent is running. Enter
    // routes through the queue when busy (see submit()), but typing,
    // backspace, paste, and clipboard-image all stay live.
    // Exception: when status is 'aborting', all input is blocked — except
    // Ctrl+C which the SIGINT handler processes directly (not through handleKey).
    // We check interrupts here so the second Ctrl+C can still reach the handler
    // even though status is 'aborting'.
    // Block input while aborting — unless the user is mid-steering
    // (they need to type their new direction) or already pressed Ctrl+C
    // twice (exit ladder takes priority). Ctrl+C SIGINT handler bypasses
    // handleKey entirely so it always fires regardless of this guard.
    if (state.status === 'aborting' && !state.steeringPending && state.interrupts === 0) return;
    // Block all input while confirmation prompt is shown — the ConfirmPrompt
    // component handles y/n/a/d/escape/enter itself and Input's disabled prop
    // is not reliable when multiple useInput hooks are active.
    if (state.confirmQueue.length > 0) return;
    // While the refiner call is in flight, Esc cancels it (send original now);
    // all other keys are swallowed so nothing leaks into the input.
    if (state.enhanceBusy) {
      if (key.escape) enhanceAbortRef.current?.abort();
      return;
    }
    // The EnhancePanel owns Enter/Esc/e, so the main input stays out of the way.
    if (state.enhance) return;

    // The ESC-interrupt confirmation dialog is modal — EscConfirmPrompt owns
    // y/n/Esc/Enter; all other keys are swallowed.
    if (state.escConfirm) return;

    // The help overlay is modal: Esc / `?` / `q` dismiss it; every other key is
    // swallowed so nothing leaks into the editor or chat behind it.
    if (state.helpOpen) {
      if (key.escape || input === '?' || input === 'q') dispatch({ type: 'toggleHelp' });
      return;
    }

    // ── Monitor overlays are NON-modal ───────────────────────────────
    // F2 fleet, F3 agents, F4 worktree, F6 todos, F7 queue, and the
    // autoPhase monitor render in the lower region of the layout, but the
    // chat input above them stays LIVE — typing, backspace, paste, cursor
    // movement, and Enter (submit) all flow through to the input buffer.
    // Only the F-key toggles below and Esc are reserved for the panel:
    //   • F2/F3/F4/F6/F7 toggle their respective overlay
    //   • Esc closes whichever overlay is open
    // (Overlays with their own dedicated UI — `confirmQueue`, `enhance`,
    // `modelPicker`, `autonomyPicker`, `settingsPicker`, `rewindOverlay`,
    // `helpOpen` — are still modal and keep their own guards above.)
    // Ctrl+C still aborts via the SIGINT handler, which bypasses handleKey.

    // Re-entrancy guard: block stale-second events from \r\n terminals.
    if (inputGateRef.current) return;

    // ── Double-Esc clears input buffer ────────────────────────────────
    // When the user presses Esc twice within ESC_DOUBLE_PRESS_MS ms while
    // the buffer is non-empty, clear it. This mirrors the behaviour of bash's
    // Ctrl+C double-press clearing the line, adapted for Esc (no Ctrl needed).
    if (key.escape) {
      const now = Date.now();
      if (state.buffer.length > 0 && now - lastEscAtRef.current < ESC_DOUBLE_PRESS_MS) {
        dispatch({ type: 'clearInput' });
        lastEscAtRef.current = 0;
        return;
      }
      lastEscAtRef.current = now;
    }

    // ── Bracketed-paste accumulation ──────────────────────────────────
    // Must run before the Enter/key handling below: a paste split across
    // events can land a fragment that is exactly "\n", which would
    // otherwise be read as Enter and submit mid-paste. The begin marker
    // (\x1b[200~, or a bare [200~ when Ink ate the ESC) opens accumulation;
    // we swallow every fragment until the end marker (\x1b[201~ / [201~),
    // then finalize the whole payload at once.
    if (input) {
      const paste = feedPaste(pasteAccumRef.current, input);
      if (paste) {
        pasteAccumRef.current = paste.accum;
        if (pasteFlushTimerRef.current) clearTimeout(pasteFlushTimerRef.current);
        if (paste.complete !== null) {
          pasteFlushTimerRef.current = null;
          await commitPaste(paste.complete);
          return;
        }
        pasteFlushTimerRef.current = setTimeout(() => {
          pasteFlushTimerRef.current = null;
          const full = pasteAccumRef.current;
          pasteAccumRef.current = null;
          if (full) void commitPaste(full);
        }, 250);
        return;
      }
    }

    // Some terminals emit \r\n for Enter as two separate stdin events.
    // \r arrives with key.return=true (handled below); \n may arrive as
    // a stray character with key.return=false. Normalize both to Enter
    // and prevent them from polluting the buffer as literal text.
    // Mouse buttons inside a selectable overlay map to keyboard semantics:
    // left = confirm (Enter), right = cancel/back (Esc). Tracking is
    // overlay-scoped (see the mouse effect near stateRef), so this is gated on
    // an overlay being open and never disturbs normal chat clicks. Combined
    // with wheel-to-move in each picker block, this gives full mouse menu
    // control without any pixel hit-testing.
    const overlaySelectable =
      state.modelPicker.open ||
      state.autonomyPicker.open ||
      state.designPicker.open ||
      state.resumePicker.open ||
      state.settingsPicker.open ||
      state.projectPicker.open ||
      state.slashPicker.open ||
      state.picker.open;
    const clickConfirm =
      overlaySelectable && key.mouse?.kind === 'press' && key.mouse.button === 'left';
    const clickCancel =
      overlaySelectable && key.mouse?.kind === 'press' && key.mouse.button === 'right';
    const isEnter = key.return || input === '\r' || input === '\n' || clickConfirm;

    // Right-click cancels the open overlay (mirrors each picker's Esc path).
    if (clickCancel) {
      if (state.modelPicker.open) {
        dispatch(
          state.modelPicker.step === 'model'
            ? { type: 'modelPickerBack' }
            : { type: 'modelPickerClose' },
        );
      } else if (state.autonomyPicker.open) {
        dispatch({ type: 'autonomyPickerClose' });
      } else if (state.designPicker.open) {
        dispatch({ type: 'designPickerClose' });
      } else if (state.resumePicker.open) {
        dispatch({ type: 'resumePickerClose' });
      } else if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
      } else if (state.slashPicker.open) {
        dispatch({ type: 'slashPickerClose' });
      } else if (state.picker.open) {
        dispatch({ type: 'pickerClose' });
      }
      return;
    }

    // IMPORTANT: do NOT bail on `!input` here. Special keys (arrows,
    // Enter, Escape, Tab, Backspace) arrive with an empty `input`
    // string, and the slash/file pickers + cursor movement below all
    // depend on receiving those events. The late guard before text
    // insertion handles the empty-input case correctly.

    // Model picker takes absolute precedence: nothing else is meaningful
    // while the two-step overlay is open. Esc cancels (or backs out of
    // step 2 to step 1); Enter advances to the next step or confirms.
    // Step 2 additionally supports type-to-search and Backspace-to-delete.
    if (state.modelPicker.open) {
      if (key.escape) {
        if (state.modelPicker.step === 'model') {
          dispatch({ type: 'modelPickerBack' });
        } else {
          dispatch({ type: 'modelPickerClose' });
        }
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'modelPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'modelPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'modelPickerMove', delta: 1 });
        return;
      }
      // Step 2: type-to-search — printable characters append to the filter.
      if (state.modelPicker.step === 'model' && input && !key.return && !key.backspace) {
        dispatch({ type: 'modelPickerSearch', query: state.modelPicker.searchQuery + input });
        return;
      }
      // Step 2: Backspace — delete last char from filter, or go back if empty.
      if (state.modelPicker.step === 'model' && key.backspace) {
        const q = state.modelPicker.searchQuery;
        if (q.length > 0) {
          dispatch({ type: 'modelPickerSearch', query: q.slice(0, -1) });
        } else {
          dispatch({ type: 'modelPickerBack' });
        }
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        inputGateRef.current = true;
        try {
          if (state.modelPicker.step === 'provider') {
            const opt = state.modelPicker.providerOptions[state.modelPicker.selected];
            if (!opt) return;
            dispatch({
              type: 'modelPickerPickProvider',
              providerId: opt.id,
              models: opt.models,
            });
            return;
          }
          // step === 'model' → commit the switch (use filteredOptions for selected model)
          const providerId = state.modelPicker.pickedProviderId;
          const modelId = state.modelPicker.filteredOptions[state.modelPicker.selected];
          if (!providerId || !modelId) return;
          const err = await switchProviderAndModel?.(providerId, modelId);
          if (err) {
            dispatch({ type: 'modelPickerHint', text: err });
            return;
          }
          setLiveProvider(providerId);
          setLiveModel(modelId);
          setActiveMaxContext(agent.ctx.provider.capabilities.maxContext);
          dispatch({
            type: 'addEntry',
            entry: { kind: 'info', text: `Switched to ${providerId} / ${modelId}.` },
          });
          dispatch({ type: 'modelPickerClose' });
          return;
        } finally {
          inputGateRef.current = false;
        }
      }
      // Any other key while picker is open: ignore.
      return;
    }

    // Autonomy picker takes absolute precedence while open.
    if (state.autonomyPicker.open) {
      if (key.escape) {
        dispatch({ type: 'autonomyPickerClose' });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'autonomyPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'autonomyPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'autonomyPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        const opt = state.autonomyPicker.options[state.autonomyPicker.selected];
        if (!opt) return;
        const err = switchAutonomy?.(opt.mode);
        if (err) {
          dispatch({ type: 'autonomyPickerHint', text: err });
          return;
        }
        dispatch({ type: 'autonomyPickerClose' });
        return;
      }
      return;
    }

    // Design Studio kit picker — arrows navigate, ←/→ cycle the target stack,
    // Enter applies the kit by running `/design <id> <stack>` (pins + loads it).
    if (state.designPicker.open) {
      if (key.escape) {
        dispatch({ type: 'designPickerClose' });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'designPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'designPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'designPickerMove', delta: 1 });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const stacks = ['web', 'react-native', 'flutter', 'swiftui', 'compose'];
        const cur = stacks.indexOf(state.designPicker.stack);
        const delta = key.rightArrow ? 1 : -1;
        const next = stacks[(cur + delta + stacks.length) % stacks.length] ?? 'web';
        dispatch({ type: 'designPickerStack', stack: next });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        const kit = state.designPicker.kits[state.designPicker.selected];
        const stack = state.designPicker.stack;
        dispatch({ type: 'designPickerClose' });
        if (kit) void submit(`/design ${kit.id} ${stack}`);
        return;
      }
      return;
    }

    // Resume picker takes absolute precedence while open.
    if (state.resumePicker.open) {
      if (key.escape) {
        dispatch({ type: 'resumePickerClose' });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'resumePickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'resumePickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'resumePickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        const session = state.resumePicker.sessions[state.resumePicker.selected];
        if (!session || session.isCurrent) return;
        if (state.resumePicker.busy) return;
        // Fire the resume callback — the host loads the session and
        // returns the hydrated history entries.
        dispatch({ type: 'resumePickerBusy', on: true });
        onResumeSession?.(session.id).then((result) => {
          if (!result) {
            dispatch({ type: 'resumePickerError', text: `Failed to resume session ${session.id}.` });
            return;
          }
          dispatch({ type: 'replaceHistory', entries: result.entries, nextId: result.nextId });
          dispatch({ type: 'resumePickerClose' });
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'info',
              text: `Resumed session ${result.sessionId} — ${result.entries.length} entries replayed.`,
            },
          });
        }).catch((err) => {
          dispatch({
            type: 'resumePickerError',
            text: toErrorMessage(err),
          });
        });
        return;
      }
      return;
    }

    if (state.settingsPicker.open) {
      const sp = state.settingsPicker;
      // Modal free-text editing of the thinking word: while active, the row
      // captures every key — type to edit, Enter commits, Esc cancels (and
      // does NOT close the picker), Backspace deletes. Everything else is
      // swallowed so navigation can't fire mid-edit.
      if (sp.thinkingWordEditing) {
        if (key.escape) {
          dispatch({ type: 'settingsThinkingEditCancel' });
          return;
        }
        if (isEnter) {
          const now = Date.now();
          if (now - lastEnterAtRef.current < 50) return;
          lastEnterAtRef.current = now;
          dispatch({ type: 'settingsThinkingEditCommit' });
          return;
        }
        if (key.backspace) {
          dispatch({ type: 'settingsThinkingEditChange', draft: sp.thinkingWordDraft.slice(0, -1) });
          return;
        }
        if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
          dispatch({ type: 'settingsThinkingEditChange', draft: sp.thinkingWordDraft + input });
          return;
        }
        return;
      }
      if (key.escape || (key.ctrl && input === 's')) {
        dispatch({ type: 'settingsClose' });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'settingsFieldMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      // Ctrl+<letter>, Alt+<letter>, or Alt+Shift+<letter> → jump straight to the
      // named settings-picker row. Chords are registered in
      // SETTINGS_PICKER_JUMP_CHORDS (settings-picker.tsx) alongside the
      // help-overlay surface so the two stay in sync. Lives after the
      // thinking-word edit modal block so the typing shortcut never hijacks
      // a free-text edit. Avoids every globally-bound chord
      // (Ctrl+S/F/G/P/T/A/K and Alt+V) — see the JUMP_CHORDS docstring for
      // the full list. The Alt+Shift variant lets the Logging rows reuse
      // letters already taken by the Ctrl/Alt sets without colliding.
      if (input && input.length === 1 && (key.ctrl || key.meta)) {
        const mod: 'ctrl' | 'alt' | 'alt-shift' = key.ctrl
          ? 'ctrl'
          : key.shift
            ? 'alt-shift'
            : 'alt';
        const field = settingsPickerJumpField(mod, input);
        if (field !== undefined) {
          dispatch({ type: 'settingsFieldSet', field });
          return;
        }
      }
      // Filter mode (row search). Pressing `/` on an empty filter enters
      // filter mode; subsequent printable characters extend the query;
      // backspace removes the last character; Esc clears the filter.
      // The filter value always includes the leading `/` so the visual
      // cue is consistent (`Filter: /multi`); matchers strip it.
      if (input === '/' && sp.filter === '') {
        dispatch({ type: 'settingsFilterSet', filter: '/' });
        return;
      }
      if (sp.filter !== '') {
        if (key.escape) {
          dispatch({ type: 'settingsFilterSet', filter: '' });
          return;
        }
        if (key.backspace) {
          // Strip the trailing character, but keep the leading `/` so
          // the picker knows we're still in filter mode.
          const next = sp.filter.length > 1 ? sp.filter.slice(0, -1) : '';
          dispatch({ type: 'settingsFilterSet', filter: next });
          return;
        }
        if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
          dispatch({ type: 'settingsFilterSet', filter: sp.filter + input });
          return;
        }
        // Anything else (arrows, Enter, etc.) — fall through to the
        // default handling below, which navigates within the filtered
        // rows. Enter is special-cased below to "accept and clear".
      }
      if (key.upArrow) {
        dispatch({ type: 'settingsFieldMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'settingsFieldMove', delta: 1 });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: 'settingsValueChange', delta: -1 });
        return;
      }
      if (key.rightArrow) {
        dispatch({ type: 'settingsValueChange', delta: 1 });
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        // If the user is in filter mode, Enter accepts the current row
        // (the cursor is already on a matching row because navigation
        // works within the filtered set) and exits filter mode.
        if (sp.filter !== '') {
          dispatch({ type: 'settingsFilterSet', filter: '' });
          return;
        }
        // The thinking-word row opens free-text editing on Enter; every other
        // field cycles its value (same as ←/→).
        if (sp.field === THINKING_WORD_FIELD) {
          dispatch({ type: 'settingsThinkingEditStart' });
        } else {
          dispatch({ type: 'settingsValueChange', delta: 1 });
        }
        return;
      }
      return;
    }

    // Statusline picker — interactive status bar chip editor.
    if (state.statuslinePicker.open) {
      if (key.escape) {
        dispatch({ type: 'statuslineClose' });
        return;
      }
      // F5 deliberately NOT handled here — it falls through to the plan-panel
      // toggle below. Esc is the close key for the statusline picker.
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'statuslineFieldMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      // ↑/↓ navigate chips; ←/→ toggle the focused chip on/off.
      if (key.upArrow) {
        dispatch({ type: 'statuslineFieldMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'statuslineFieldMove', delta: 1 });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const focused = STATUSLINE_ITEMS[state.statuslinePicker.field];
        if (focused) {
          dispatch({ type: 'statuslineToggle', item: focused });
        }
        return;
      }
      // Enter is deliberately a no-op — ↑/↓ navigate, ←/→ toggle.
      return;
    }

    // Project picker — keyboard-driven project switching panel.
    if (state.projectPicker.open) {
      if (key.escape) {
        if (state.projectPicker.filter) {
          // First Esc clears the filter
          dispatch({ type: 'projectPickerFilter', filter: '' });
        } else {
          dispatch({ type: 'projectPickerClose' });
        }
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'projectPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'projectPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'projectPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        const items = state.projectPicker.items;
        const selected = state.projectPicker.selected;
        if (selected < 0 || selected >= items.length) return;
        const item = items[selected];
        if (!item || item.key === '__divider__' || item.key === 'quit') {
          dispatch({ type: 'projectPickerClose' });
          return;
        }
        // Project selections re-root the live app in place; no exit/restart.
        if (item.kind === 'project') {
          await onProjectSelect?.(item.key, item.kind);
          dispatch({ type: 'projectPickerClose' });
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: `Switched project: ${item.label.trim()}.` } });
          return;
        }
        // Actions: 'new-session' starts a fresh session in the current project;
        // 'prev-sessions' opens the in-TUI /resume picker. These used to be
        // dead menu items — onProjectSelect no-op'd on actions and nothing
        // else handled them.
        dispatch({ type: 'projectPickerClose' });
        if (item.key === 'new-session') {
          await onProjectSelect?.(item.key, item.kind);
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: 'Started a fresh session in this project.' } });
        } else if (item.key === 'prev-sessions') {
          void submit('/resume');
        }
        return;
      }
      // Printable characters → add to filter
      if (input && input.length === 1 && input.charCodeAt(0) >= 0x20 && input.charCodeAt(0) < 0x7f) {
        dispatch({ type: 'projectPickerFilter', filter: state.projectPicker.filter + input });
        return;
      }
      // Backspace → remove last char from filter
      if (key.backspace) {
        if (state.projectPicker.filter.length > 0) {
          dispatch({
            type: 'projectPickerFilter',
            filter: state.projectPicker.filter.slice(0, -1),
          });
        }
        return;
      }
      return;
    }

    // Sessions panel (F10) — arrow-key navigation + Enter to resume/switch.
    if (state.sessionsPanelOpen) {
      if (key.escape) {
        if (state.sessionResumeConfirm) {
          // First Esc clears the confirmation
          dispatch({ type: 'sessionResumeConfirmClear' });
        } else {
          dispatch({ type: 'toggleSessionsPanel' });
        }
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'sessionsPanelMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'sessionsPanelMove', delta: 1 });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'sessionsPanelMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;

        // Two-step resume: first Enter selects, second confirms
        if (state.sessionResumeConfirm) {
          // Second Enter — proceed with resume
          const pending = state.sessionResumeConfirm;
          dispatch({ type: 'sessionResumeConfirmClear' });
          dispatch({ type: 'sessionsPanelBusy', on: true });
          onResumeSession?.(pending.sessionId).then((result) => {
            if (!result) {
              dispatch({ type: 'sessionsPanelBusy', on: false });
              return;
            }
            dispatch({ type: 'replaceHistory', entries: result.entries, nextId: result.nextId });
            dispatch({ type: 'toggleSessionsPanel' });
            dispatch({
              type: 'addEntry',
              entry: {
                kind: 'info',
                text: `Resumed session ${result.sessionId} — ${result.entries.length} entries replayed.`,
              },
            });
          }).catch(() => {
            dispatch({ type: 'sessionsPanelBusy', on: false });
          });
          return;
        }

        const sessions = state.sessionsPanel.sessions;
        const sel = state.sessionsPanel.selected;
        if (sel < 0 || sel >= sessions.length) return;
        const session = sessions[sel];
        if (!session) return;

        // Determine if same project (in-process resume) or different project
        // (clean exit + respawn in the target root, like the F1 switch).
        const isCurrentProject = session.projectRoot === projectRoot;
        if (isCurrentProject) {
          // The F10 list shows LIVE sessions — guard before offering resume.
          if (session.pid === process.pid) {
            dispatch({
              type: 'addEntry',
              entry: { kind: 'info', text: 'That is this session — nothing to resume.' },
            });
            dispatch({ type: 'toggleSessionsPanel' });
            return;
          }
          if (session.pid != null) {
            dispatch({
              type: 'addEntry',
              entry: {
                kind: 'warn',
                text: `Session is open in another running wstack (pid ${session.pid}) — a live session cannot be resumed here. Use /resume for previous sessions.`,
              },
            });
            dispatch({ type: 'toggleSessionsPanel' });
            return;
          }
          // First Enter — show confirmation
          dispatch({
            type: 'sessionResumeConfirmSet',
            sessionId: session.sessionId,
            sessionName: session.projectName,
          });
        } else {
          // Different project — record the pending switch, then exit cleanly
          // with the project-switch code so the host respawns wstack in the
          // target project (resuming the chosen session).
          onSwitchToSession?.(session.sessionId, session.projectRoot ?? '', session.projectName);
          dispatch({ type: 'toggleSessionsPanel' });
          requestExit?.(42);
        }
        return;
      }
      return;
    }

    if (state.slashPicker.open) {
      if (key.escape) {
        dispatch({ type: 'slashPickerClose' });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'slashPickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'slashPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'slashPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        inputGateRef.current = true;
        const line = selectedSlashCommandLine(state.slashPicker);
        if (line) {
          void submit(line);
        } else {
          acceptSlashPickerSelection();
        }
        inputGateRef.current = false;
        return;
      }
      // Tab → autocomplete with selected command
      if (key.tab && state.slashPicker.matches.length > 0) {
        const sel = state.slashPicker.matches[state.slashPicker.selected];
        if (sel) {
          setDraft(`/${sel.name} `, sel.name.length + 2);
          dispatch({ type: 'slashPickerClose' });
        }
        return;
      }
      // Any other key falls through to normal text handling.
    }

    // F-key panel picker — keyboard navigation
    if (state.fKeyPicker.open) {
      if (key.escape) {
        dispatch({ type: 'fKeyPickerClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'fKeyPickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'fKeyPickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        const selected = state.fKeyPicker.selected;
        const entry = F_KEY_ENTRIES[selected];
        if (!entry) return;
        dispatch({ type: 'fKeyPickerClose' });
        if (entry.action === 'projectPickerOpen') {
          openProjectPicker();
          return;
        }
        const action = actionForFKeyPanel(entry, statuslineHiddenForPicker());
        if (action) dispatch(action);
        return;
      }
      return;
    }

    // Picker takes precedence over normal input handling when open.
    if (state.picker.open) {
      if (key.escape) {
        dispatch({ type: 'pickerClose' });
        return;
      }
      if (key.mouse?.kind === 'wheel') {
        dispatch({ type: 'pickerMove', delta: key.mouse.wheel > 0 ? -1 : 1 });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'pickerMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'pickerMove', delta: 1 });
        return;
      }
      if (isEnter) {
        // Debounce \r\n double-event from terminals that emit Enter as two stdin reads.
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        inputGateRef.current = true;
        try {
          await acceptPickerSelection();
        } finally {
          inputGateRef.current = false;
        }
        return;
      }
      // Any other key falls through to normal text handling, which will
      // either extend the @-query (e.g. typing more chars) or break it
      // (e.g. typing a space) — handled below.
    }

    // Esc when the agent is busy = "drop what you're doing, I want to
    // steer". Aborts the current iteration, terminates any running
    // subagents (otherwise they keep burning tokens on now-stale work),
    // and stashes a context snapshot so the STEERING preamble can tell
    // the model exactly what it was mid-doing. Does NOT consume the
    // Ctrl+C exit ladder (interrupts counter untouched). When no run
    // is active, Esc falls through to normal text handling.
    //
    // When `confirmExit` is enabled, Esc first shows a confirmation
    // dialog ("Are you sure?") so the user doesn't accidentally
    // interrupt a long-running task. The dialog is dismissed with
    // y/Enter to confirm or n/Esc to cancel.
    if (key.escape && state.status !== 'idle' && state.confirmQueue.length === 0) {
      // Snapshot context BEFORE we mutate anything. The submit handler
      // replays this into the model prompt so the model isn't guessing.
      const runningTools = Array.from(state.runningTools.values()).map((t) => t.name);
      const subagents = Object.values(state.fleet)
        .filter((e) => e.status === 'running')
        .map((e) => ({
          label: e.name,
          status: e.status,
          tool: e.currentTool?.name,
        }));
      const subagentsTerminated = subagents.length;
      const partialAssistantText = streamingTextRef.current.slice(-1500);
      const snapshot = {
        runningTools,
        subagents,
        subagentsTerminated,
        partialAssistantText,
      };

      // ── confirmExit gate: show confirmation dialog ──────────────────
      if (confirmExitRef.current) {
        dispatch({ type: 'escConfirmOpen', snapshot });
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text:
              `⏸ Interrupt? [y]es — stop and steer  ·  [n]o / Esc — keep running` +
              (subagentsTerminated > 0
                ? `  (${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'})`
                : ''),
          },
        });
        return;
      }

      // ── Immediate interrupt (confirmExit is off) ────────────────────
      activeCtrlRef.current?.abort();
      dispatch({ type: 'status', status: 'aborting' });
      dispatch({ type: 'steerStart', snapshot });

      // Kill the fleet too. Without this the subagents keep running
      // on the old direction, finish minutes later, and pollute the
      // chat with task.completed events the model doesn't care about
      // anymore. Cap at 1.5s so a wedged bridge can't hang the steer.
      if (director && subagentsTerminated > 0) {
        const cap = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          t.unref?.();
        });
        void Promise.race([director.terminateAll().catch(() => undefined), cap]);
      }

      // Drop anything queued — steering means the user is redirecting,
      // not adding to the backlog. Without this the queued items would
      // run *before* the steering message, which contradicts the UX.
      const droppedCount = state.queue.length;
      if (droppedCount > 0) dispatch({ type: 'queueClear' });
      const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
      const fleetTag =
        subagentsTerminated > 0
          ? ` · stopped ${subagentsTerminated} subagent${subagentsTerminated === 1 ? '' : 's'}`
          : '';
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'warn',
          text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
        },
      });
      return;
    }

    // Monitor overlays. Ctrl+F/G/T are the primary chords; F2/F3/F4 are
    // terminal-safe aliases because some terminals intercept the chord before
    // it reaches the app (notably Windows Terminal eats Ctrl+F for "Find").
    // F11/F12 are exposed as optional direct panel shortcuts; terminals that
    // reserve them can still use /f or the slash-command alternatives.
    // All toggles are allowed even while aborting, so the user can check
    // subagent state mid-steer.
    const toggleFleetOverlay = () => {
      if (state.monitorOpen) {
        dispatch({ type: 'toggleMonitor' });
        return;
      }
      // Opening: close all other overlays/panels first.
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'toggleMonitor' });
    };
    const toggleAgentsOverlay = () => {
      if (state.agentsMonitorOpen) {
        dispatch({ type: 'toggleAgentsMonitor' });
        return;
      }
      // Opening: close all other overlays/panels first.
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'toggleAgentsMonitor' });
    };
    const toggleWorktreeOverlay = () => {
      if (state.worktreeMonitorOpen) {
        dispatch({ type: 'worktreeMonitorToggle' });
        return;
      }
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'worktreeMonitorToggle' });
    };
    const toggleTodosOverlay = () => {
      if (state.todosMonitorOpen) {
        dispatch({ type: 'toggleTodosMonitor' });
        return;
      }
      if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
      if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
      if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
      if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
      if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
      if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
      if (state.helpOpen) dispatch({ type: 'toggleHelp' });
      dispatch({ type: 'toggleTodosMonitor' });
    };
    // F1 → project switcher panel. Opening closes any other overlay or panel.
    if (key.fn === 1) {
      if (state.projectPicker.open) {
        dispatch({ type: 'projectPickerClose' });
      } else {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.processListOpen) dispatch({ type: 'toggleProcessList' });
        if (state.goalPanelOpen) dispatch({ type: 'toggleGoalPanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        // Load project items from the manifest
        openProjectPicker();
      }
      return;
    }
    // Ctrl+F / F2 → fleet orchestration monitor.
    if ((key.ctrl && input === 'f') || key.fn === 2) {
      toggleFleetOverlay();
      return;
    }
    // Ctrl+G / F3 → agents live monitor.
    if ((key.ctrl && input === 'g') || key.fn === 3) {
      toggleAgentsOverlay();
      return;
    }
    // Ctrl+T / F4 → worktree monitor. (Word-delete that used to live on Ctrl+T
    // is covered by Ctrl+Backspace.)
    if ((key.ctrl && input === 't') || key.fn === 4) {
      toggleWorktreeOverlay();
      return;
    }
    // Ctrl+B → live multi-agent SDD board overlay (no-op until the first
    // sdd.board.snapshot arrives from a running /sdd execute).
    if (key.ctrl && input === 'b') {
      dispatch({ type: 'toggleSddBoardMonitor' });
      return;
    }
    // While the SDD board overlay is open, ←/→ drive the per-phase drill-down
    // (→ focuses a single topological column, ← steps back / exits to the
    // all-phases view) and plain `c` / `z` drive run lifecycle (both refuse
    // while the run is still live — stop it first with Ctrl+C).
    if (state.sddBoard?.monitorOpen && !key.ctrl && !key.meta) {
      if (key.rightArrow) {
        dispatch({ type: 'sddBoardFocusNext' });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: 'sddBoardFocusPrev' });
        return;
      }
      if (input === 'c') {
        const run = getSddRun?.();
        if (run) {
          void run.cleanupWorktrees().then((n) => {
            dispatch({
              type: 'addEntry',
              entry: {
                kind: n > 0 ? 'info' : 'warn',
                text: n > 0 ? `Cleaned ${n} SDD worktree${n === 1 ? '' : 's'}.` : 'No SDD worktrees to clean (stop the run first if it is live).',
              },
            });
          });
        }
        return;
      }
      if (input === 'z') {
        const run = getSddRun?.();
        if (run) {
          void run.rollback().then((r) => {
            dispatch({
              type: 'addEntry',
              entry: {
                kind: r.ok ? 'info' : 'warn',
                text: r.ok
                  ? r.reverted > 0
                    ? `Rolled back ${r.reverted} run commit${r.reverted === 1 ? '' : 's'} (revert commits added).`
                    : 'Nothing to roll back.'
                  : `Rollback failed: ${r.reason ?? 'unknown error'}`,
              },
            });
          });
        }
        return;
      }
    }
    // F5 → plan panel overlay. Opening closes any other overlay or panel.
    if (key.fn === 5) {
      if (state.planPanelOpen) {
        dispatch({ type: 'togglePlanPanel' });
      } else {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'togglePlanPanel' });
      }
      return;
    }
    // F6 → full-screen todos monitor overlay.
    if (key.fn === 6) {
      toggleTodosOverlay();
      return;
    }
    // F7 → queue panel. Opening closes any other overlay or panel.
    if (key.fn === 7) {
      if (state.queuePanelOpen) {
        dispatch({ type: 'toggleQueuePanel' });
      } else {
        // Close all other overlays/panels first.
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleQueuePanel' });
      }
      return;
    }
    // F8 → process list overlay. Opening closes any other overlay or panel.
    if (key.fn === 8) {
      if (state.processListOpen) {
        dispatch({ type: 'toggleProcessList' });
      } else {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleProcessList' });
      }
      return;
    }
    // F9 → goal panel. Opening closes any other overlay or panel.
    if (key.fn === 9) {
      if (state.goalPanelOpen) {
        dispatch({ type: 'toggleGoalPanel' });
      } else {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.processListOpen) dispatch({ type: 'toggleProcessList' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleGoalPanel' });
      }
      return;
    }
    // F10 → live sessions panel. Opening closes any other overlay or panel.
    // Also allow ESC to close the sessions panel directly from here (defence in depth:
    // if the dedicated sessions-panel ESC handler at line 3623 is bypassed for any
    // reason, this check still closes the panel).
    if (key.fn === 10 || (key.escape && state.sessionsPanelOpen)) {
      if (state.sessionsPanelOpen) {
        dispatch({ type: 'toggleSessionsPanel' });
      } else {
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.settingsPicker.open) dispatch({ type: 'settingsClose' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.processListOpen) dispatch({ type: 'toggleProcessList' });
        if (state.goalPanelOpen) dispatch({ type: 'toggleGoalPanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        dispatch({ type: 'toggleSessionsPanel' });
        // Load sessions from the registry
        loadLiveSessions();
      }
      return;
    }
    // F11 → AutonomousCoordinator monitor. Opens the project-level coordination panel
    // showing live goals, tasks, knowledge, and consensus across all sessions.
    if (key.fn === 11 || (input === '\x1b' && state.coordinator.monitorOpen)) {
      dispatch({ type: 'toggleCoordinatorMonitor' });
      return;
    }
    // F12 → status line picker. Mirrors /statusline for terminals where slash
    // commands are inconvenient during a busy session.
    if (key.fn === 12) {
      openStatuslinePicker();
      return;
    }
    // Settings editor (also openable via `/settings`). Opening closes any other
    // overlay or panel. Arrow keys navigate between fields (↑↓) or cycle values
    // (←→). Enter also cycles the current field's value. Escape closes.
    if (state.settingsPicker.open) {
      if (key.escape) {
        dispatch({ type: 'settingsClose' });
        return;
      }
      if (key.upArrow) {
        dispatch({ type: 'settingsFieldMove', delta: -1 });
        return;
      }
      if (key.downArrow) {
        dispatch({ type: 'settingsFieldMove', delta: 1 });
        return;
      }
      if (key.leftArrow) {
        dispatch({ type: 'settingsValueChange', delta: -1 });
        return;
      }
      if (key.rightArrow) {
        dispatch({ type: 'settingsValueChange', delta: 1 });
        return;
      }
      if (isEnter) {
        const now = Date.now();
        if (now - lastEnterAtRef.current < 50) return;
        lastEnterAtRef.current = now;
        dispatch({ type: 'settingsValueChange', delta: 1 });
        return;
      }
      // Fall through — allow Ctrl+S to also close the settings picker.
    }
    // Ctrl+S toggles the settings editor (also openable via `/settings`).
    if (key.ctrl && input === 's') {
      if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
      } else if (getSettings && saveSettings) {
        // Close all other overlays/panels first.
        if (state.agentsMonitorOpen) dispatch({ type: 'toggleAgentsMonitor' });
        if (state.monitorOpen) dispatch({ type: 'toggleMonitor' });
        if (state.worktreeMonitorOpen) dispatch({ type: 'worktreeMonitorToggle' });
        if (state.todosMonitorOpen) dispatch({ type: 'toggleTodosMonitor' });
        if (state.autoPhase?.monitorOpen) dispatch({ type: 'autoPhaseMonitorToggle' });
        if (state.queuePanelOpen) dispatch({ type: 'toggleQueuePanel' });
        if (state.helpOpen) dispatch({ type: 'toggleHelp' });
        const cfg = getSettings();
        dispatch({
          type: 'settingsOpen',
          mode: cfg.mode,
          delayMs: cfg.delayMs,
          titleAnimation: cfg.titleAnimation ?? true,
          yolo: cfg.yolo ?? false,
          streamFleet: cfg.streamFleet ?? true,
          chime: cfg.chime ?? false,
          confirmExit: cfg.confirmExit ?? true,
          nextPrediction: cfg.nextPrediction ?? false,
          featureMcp: cfg.featureMcp ?? true,
          featurePlugins: cfg.featurePlugins ?? true,
          featureMemory: cfg.featureMemory ?? true,
          featureSkills: cfg.featureSkills ?? true,
          featureModelsRegistry: cfg.featureModelsRegistry ?? true,
          tokenSavingTier: cfg.featureTokenSaving ?? 'off',
          allowOutsideProjectRoot: cfg.allowOutsideProjectRoot ?? true,
          contextAutoCompact: cfg.contextAutoCompact ?? true,
          contextStrategy: cfg.contextStrategy ?? 'hybrid',
          contextMode: cfg.contextMode ?? 'balanced',
          maxConcurrent: cfg.maxConcurrent ?? 10,
          logLevel: cfg.logLevel ?? 'info',
          auditLevel: cfg.auditLevel ?? 'standard',
          indexOnStart: cfg.indexOnStart ?? true,
          multiDiffSummaryThreshold: cfg.multiDiffSummaryThreshold ?? 5,
          lastSettingsField: cfg.lastSettingsField ?? 0,
          maxIterations: cfg.maxIterations ?? 500,
          autoProceedMaxIterations: cfg.autoProceedMaxIterations ?? 50,
          enhanceDelayMs: cfg.enhanceDelayMs ?? 60_000,
          enhanceEnabled: cfg.enhanceEnabled ?? true,
          enhanceLanguage: cfg.enhanceLanguage ?? 'original',
          debugStream: cfg.debugStream ?? false,
          statuslineMode: cfg.statuslineMode ?? 'detailed',
          reasoningMode: cfg.reasoningMode ?? 'auto',
          reasoningEffort: cfg.reasoningEffort ?? 'high',
          reasoningPreserve: cfg.reasoningPreserve ?? false,
          thinkingWord: cfg.thinkingWord ?? 'thinking',
          cacheTtl: cfg.cacheTtl ?? 'default',
          configScope: cfg.configScope ?? 'global',
        });
      }
      return;
    }
    // Esc closes whichever overlay/panel is open.
    if (key.escape) {
      if (state.agentsMonitorOpen) {
        dispatch({ type: 'toggleAgentsMonitor' });
        return;
      }
      if (state.monitorOpen) {
        dispatch({ type: 'toggleMonitor' });
        return;
      }
      // worktreeMonitor and the autoPhase PhaseMonitor are intentionally NOT
      // handled here: each owns its own Esc close via its own useInput. Because
      // the Input stays mounted alongside them, dispatching the toggle here too
      // would fire it twice in one keypress and the panel would re-open.
      if (state.todosMonitorOpen) {
        dispatch({ type: 'toggleTodosMonitor' });
        return;
      }
      if (state.settingsPicker.open) {
        dispatch({ type: 'settingsClose' });
        return;
      }
      if (state.projectPicker.open) {
        dispatch({ type: 'projectPickerClose' });
        return;
      }
      if (state.queuePanelOpen) {
        dispatch({ type: 'toggleQueuePanel' });
        return;
      }
      if (state.processListOpen) {
        dispatch({ type: 'toggleProcessList' });
        return;
      }
      if (state.goalPanelOpen) {
        dispatch({ type: 'toggleGoalPanel' });
        return;
      }
      if (state.helpOpen) {
        dispatch({ type: 'toggleHelp' });
        return;
      }
      if (state.sessionsPanelOpen) {
        dispatch({ type: 'toggleSessionsPanel' });
        return;
      }
      if (state.coordinator.monitorOpen) {
        dispatch({ type: 'toggleCoordinatorMonitor' });
        return;
      }
    }
    // ── ProcessList owns the keyboard ──────────────────────────────
    // The ProcessList panel captures every keystroke through its own
    // useInput (↑↓/PgUp/PgDn/Home/End/g/G navigation, Enter/Del/a/A/r
    // actions). We return early here so NONE of those keys ever reach
    // the chat input buffer — no typing, no backspace, no cursor
    // movement, nothing. Only the F8 toggle and Esc close (handled
    // above) bypass this guard so the panel can be dismissed.
    if (state.processListOpen) {
      return;
    }

    // overlayOpen tracks whether any monitor or panel overlay is active.
    // Defined here (before the ?-handler and Enter submit) so both can
    // check it. Also used below in the multi-line input navigation and
    // scroll sections to prevent arrow-key conflicts with overlay internals.
    const overlayOpen =
      state.monitorOpen ||
      state.agentsMonitorOpen ||
      state.worktreeMonitorOpen ||
      state.todosMonitorOpen ||
      state.queuePanelOpen ||
      state.processListOpen ||
      state.goalPanelOpen ||
      state.sessionsPanelOpen ||
      state.coordinator.monitorOpen ||
      state.helpOpen ||
      (state.autoPhase?.monitorOpen ?? false) ||
      state.rewindOverlay !== null;

    // `?` on an empty prompt opens the keys-&-commands help overlay (lazygit
    // style). With any draft text it types normally, so a literal `?` mid-
    // message is never swallowed. Guarded via overlayOpen — when any panel
    // or picker is active the key is ignored so overlay-internal `?` usage
    // (none currently) is never stolen.
    if (
      input === '?' &&
      !key.ctrl &&
      !key.meta &&
      draftRef.current.buffer === '' &&
      !overlayOpen
    ) {
      dispatch({ type: 'toggleHelp' });
      return;
    }
    // No panel below uses Enter for itself (ProcessList has its own
    // dedicated guard above; every other panel either has no useInput
    // or only captures ↑↓/Esc/letter shortcuts). Enter always reaches
    // the submit path so the live input stays usable behind overlays.
    if (isEnter) {
      // Shift+Enter inserts a literal newline instead of submitting.
      if (key.shift) {
        const { buffer, cursor } = draftRef.current;
        const next = buffer.slice(0, cursor) + '\n' + buffer.slice(cursor);
        setDraft(next, cursor + 1);
        return;
      }

      // Re-entrancy protection for terminals that emit `\r\n` as two
      // separate stdin events: ignore Enter pressed within 50ms of the
      // last one. The 50ms window catches the double-event reliably
      // (the second `\n` arrives within microseconds of the `\r`) while
      // staying well below human double-tap speed.
      //
      // We intentionally do NOT await submit() here — it kicks off
      // agent.run() which can stay pending for minutes when a delegate
      // call is in flight. Awaiting would block this handler frame for
      // the full duration, which means every subsequent keystroke would
      // miss its dispatch (including the slash key — the user reported
      // the input feeling dead during delegated work). submit() handles
      // its own re-entrancy via state.status: when the agent is busy,
      // the message is queued instead of re-running concurrently.
      const now = Date.now();
      if (now - lastEnterAtRef.current < 50) return;
      lastEnterAtRef.current = now;
      void submit();
      return;
    }

    const { buffer, cursor } = draftRef.current;

    // Tab while the next-steps auto-submit countdown is running: "grab" the
    // pending suggestion (the auto="true" step) into the input instead of
    // letting it fire on its own. Pressing any key already stops the
    // countdown; Tab additionally pre-fills the row with the suggestion text
    // and parks the cursor at the very end, so the user can review/edit it and
    // submit with Enter. Slash/other pickers are handled above and have
    // already returned, so this only triggers on the bare idle prompt.
    if (key.tab && nextStepsAutoSubmitTimerRef.current != null) {
      const pending =
        nextStepsAutoSubmitSuggestionRef.current ?? nextStepsAutoSubmitLabel ?? '';
      clearInterval(nextStepsAutoSubmitTimerRef.current);
      nextStepsAutoSubmitTimerRef.current = undefined;
      setNextStepsAutoSubmitCountdown(null);
      setNextStepsAutoSubmitLabel(null);
      nextStepsAutoSubmitSuggestionRef.current = null;
      const text = pending.trim();
      if (text) setDraft(text, text.length);
      return;
    }

    if (key.backspace) {
      if (key.ctrl) {
        if (cursor === 0) return;
        const chip = tokenSpanAt(buffer, cursor);
        const deleteStart = chip && cursor > chip.start && cursor < chip.end
          ? chip.start
          : previousInputWordStart(buffer, cursor);
        const deleteEnd = chip && cursor > chip.start && cursor < chip.end ? chip.end : cursor;
        const next = buffer.slice(0, deleteStart) + buffer.slice(deleteEnd);
        // Cancel next-steps auto-submit countdown when buffer changes.
        if (nextStepsAutoSubmitTimerRef.current != null) {
          clearInterval(nextStepsAutoSubmitTimerRef.current);
          nextStepsAutoSubmitTimerRef.current = undefined;
          setNextStepsAutoSubmitCountdown(null);
          setNextStepsAutoSubmitLabel(null);
          nextStepsAutoSubmitSuggestionRef.current = null;
        }
        setDraft(next, deleteStart);
        return;
      }

      // Token-aware backspace: if the text immediately before the cursor ends
      // with a whole attachment chip (`[pasted …]` / `[file:…]` / `[image …]`),
      // delete the entire token in one keystroke — anywhere in the line, not
      // just at the end.
      const tokenDel = deleteTokenBackward(buffer, cursor);
      if (tokenDel) {
        setDraft(tokenDel.buffer, tokenDel.cursor);
        return;
      }

      if (cursor === 0) return;
      const next = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      // Cancel next-steps auto-submit countdown when buffer changes.
      if (nextStepsAutoSubmitTimerRef.current != null) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        nextStepsAutoSubmitSuggestionRef.current = null;
      }
      setDraft(next, cursor - 1);
      return;
    }

    if (key.delete) {
      if (key.ctrl) {
        if (cursor >= buffer.length) return;
        const chip = tokenSpanAt(buffer, cursor);
        const deleteStart = chip && cursor > chip.start && cursor < chip.end ? chip.start : cursor;
        const deleteEnd = chip && cursor > chip.start && cursor < chip.end
          ? chip.end
          : nextInputWordStart(buffer, cursor);
        const next = buffer.slice(0, deleteStart) + buffer.slice(deleteEnd);
        // Cancel next-steps auto-submit countdown when buffer changes.
        if (nextStepsAutoSubmitTimerRef.current != null) {
          clearInterval(nextStepsAutoSubmitTimerRef.current);
          nextStepsAutoSubmitTimerRef.current = undefined;
          setNextStepsAutoSubmitCountdown(null);
          setNextStepsAutoSubmitLabel(null);
          nextStepsAutoSubmitSuggestionRef.current = null;
        }
        setDraft(next, deleteStart);
        return;
      }

      if (cursor >= buffer.length) return;
      // Token-aware forward delete: drop a whole chip if one starts at cursor.
      const span = tokenLengthForward(buffer, cursor) || 1;
      const next = buffer.slice(0, cursor) + buffer.slice(cursor + span);
      // Cancel next-steps auto-submit countdown when buffer changes.
      if (nextStepsAutoSubmitTimerRef.current != null) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        nextStepsAutoSubmitSuggestionRef.current = null;
      }
      setDraft(next, cursor);
      return;
    }

    if (key.leftArrow) {
      if (key.ctrl) {
        setDraft(buffer, previousInputWordStart(buffer, cursor));
        return;
      }
      if (cursor > 0) setDraft(buffer, cursor - 1);
      return;
    }
    if (key.rightArrow) {
      if (key.ctrl) {
        setDraft(buffer, nextInputWordStart(buffer, cursor));
        return;
      }
      if (cursor < buffer.length) setDraft(buffer, cursor + 1);
      return;
    }
    if (key.home) {
      setDraft(buffer, 0);
      return;
    }
    if (key.end) {
      setDraft(buffer, buffer.length);
      return;
    }

    // ── Multi-line input navigation ──────────────────────────────────────
    // Up/Down arrows move between lines when the buffer contains newlines.
    // PageUp/PageDown jump by a screenful (half the terminal height).
    // Skipped when any overlay is open — the overlay owns the arrow keys
    // (e.g. AgentsMonitor's own useInput handles ↑↓ for list navigation).
    // (overlayOpen is defined above, before the ?-handler.)
    if (!overlayOpen && (key.upArrow || key.downArrow || key.pageUp || key.pageDown)) {
      const width = stdout?.columns ?? 80;
      const rows = layoutInputRows(INPUT_PROMPT, buffer, cursor, width);
      if (rows.length <= 1) {
        // Single-line — fall through to left/right arrow character movement.
        // Up/Down on a single line is a no-op (handled below via left/right).
      } else {
        // Multi-line: find current row (0-based, relative to INPUT_PROMPT).
        let row = 0, col = 0, offset = 0;
        outer: for (let r = 0; r < rows.length; r++) {
          const cells = rows[r]!;
          for (let c = 0; c < cells.length; c++) {
            if (offset === cursor) { row = r; col = c; break outer; }
            offset++;
          }
          if (cells.length < width) offset++; // newline
        }

        if (key.upArrow) {
          if (row > 0) {
            const prevRowLen = rows[row - 1]!.filter((cell) => !cell.prompt && !cell.chip).length;
            const targetCol = Math.min(col, prevRowLen);
            const target = inputIndexAtRowCol(INPUT_PROMPT, buffer, width, row - 1, targetCol);
            setDraft(buffer, target);
            return;
          }
          return; // already at top — no-op
        }
        if (key.downArrow) {
          if (row < rows.length - 1) {
            const nextRowLen = rows[row + 1]!.filter((cell) => !cell.prompt && !cell.chip).length;
            const targetCol = Math.min(col, nextRowLen);
            const target = inputIndexAtRowCol(INPUT_PROMPT, buffer, width, row + 1, targetCol);
            setDraft(buffer, target);
            return;
          }
          return; // already at bottom — no-op
        }
        if (key.pageUp || key.pageDown) {
          const pageSize = Math.max(1, Math.floor((stdout?.rows ?? 24) / 2));
          const delta = key.pageUp ? -pageSize : pageSize;
          const targetRow = Math.max(0, Math.min(rows.length - 1, row + delta));
          if (targetRow !== row) {
            const targetRowLen = rows[targetRow]!.filter((cell) => !cell.prompt && !cell.chip).length;
            const targetCol = Math.min(col, targetRowLen);
            const target = inputIndexAtRowCol(INPUT_PROMPT, buffer, width, targetRow, targetCol);
            setDraft(buffer, target);
          }
          return;
        }
      }
    }

    // History scrolling is delegated to the terminal's native scrollback
    // (mouse wheel, Shift+PgUp in Windows Terminal, etc.) — Ink's <Static>
    // emits each finalized entry once and never repaints over it.
    // Skip when ANY overlay below the statusline is open — these overlays
    // use arrow keys for their own navigation (↑↓ selection, scrolling).
    // Pickers (settings/model/autonomy) are already intercepted earlier
    // and never reach this point, so they don't need listing here.
    // (overlayOpen is defined above in the multi-line input navigation section.)

    // In-app chat scroll (mouse mode). SGR tracking captures the terminal's
    // native wheel, so the managed ScrollableHistory viewport must be scrolled
    // by us. Plain wheel = 3 rows; Shift+wheel and PgUp/PgDn = a page. Skipped
    // while a below-the-statusline overlay owns the arrows/scroll, and a no-op
    // outside mouse mode (where <Static> rides native scrollback instead).
    if (mouseMode && !overlayOpen) {
      if (key.mouse?.kind === 'wheel') {
        if (key.mouse.shift) dispatch({ type: 'scrollPage', dir: key.mouse.wheel > 0 ? 'up' : 'down' });
        else dispatch({ type: 'scrollBy', delta: key.mouse.wheel > 0 ? 3 : -3 });
        return;
      }
      // Scrollbar click / drag. A left press (or left-button drag) on the
      // right-edge track jumps the viewport to that position; each drag-move
      // re-jumps, giving scrub-to-scroll for free. The track lives in the top
      // `viewportRows` band, so the bottom region is never affected.
      if (
        (key.mouse?.kind === 'press' || key.mouse?.kind === 'move') &&
        key.mouse.button === 'left'
      ) {
        const region = hitRegion(
          { termRows, termCols: stdout?.columns ?? 80, viewportRows: state.viewportRows },
          key.mouse.x,
          key.mouse.y,
        );
        if (region?.kind === 'scrollbar') {
          dispatch({
            type: 'scrollTo',
            offset: scrollOffsetForTrackRow(state.viewportRows, state.totalLines, region.cell),
          });
          return;
        }
      }
      // Clickable status-bar chips. The bar is bottom-anchored above the panels
      // in belowStatusBarRef; measure both to resolve each line's absolute row,
      // then test the chip column spans (which mirror the rendered layout). A
      // press only — drags never open a picker. Column spans are 0-based from
      // the box's left edge (incl. paddingX), so screen col = span.start + 1.
      if (key.mouse?.kind === 'press' && key.mouse.button === 'left' && statusBarWrapRef.current) {
        const sbHeight = measureElement(statusBarWrapRef.current).height;
        const belowHeight = belowStatusBarRef.current
          ? measureElement(belowStatusBarRef.current).height
          : 0;
        const cols = stdout?.columns ?? 80;
        const mx = key.mouse.x;
        const my = key.mouse.y;
        const rowFor = (line: number) =>
          statusBarLineRow({ termRows, statusBarHeight: sbHeight, belowHeight, headerRows: 1, line });
        const inSpan = (span: { start: number; len: number }) =>
          mx >= span.start + 1 && mx <= span.start + span.len;
        // Line 1 — model chip → model picker. Full-width layout only: compact
        // mode (cols < COMPACT_THRESHOLD) lays line 1 out differently.
        if (cols >= COMPACT_THRESHOLD && my === rowFor(0)) {
          const span = statusBarModelSpan({
            version: appVersion,
            state: state.status,
            fleetRunning: fleetCounts?.running ?? 0,
            // Must match the rendered state label width — while streaming the bar
            // shows the configured thinking word, so the span shifts with it.
            // Omitting this made the model chip un-clickable mid-stream.
            thinkingWord: displayThinkingWordRef.current,
            model: `${liveProvider}/${liveModel}`,
          });
          if (inSpan(span)) {
            await openModelPicker();
            return;
          }
        }
        // Line 2 — autonomy chip → autonomy picker (span null when off).
        const autoSpan = statusBarAutonomySpan({ yolo: yoloLive, autonomy: autonomyLive });
        if (autoSpan && my === rowFor(1) && inSpan(autoSpan)) {
          dispatch({ type: 'autonomyPickerOpen', options: AUTONOMY_OPTIONS });
          return;
        }
        // Line 3 — todos chip → todos overlay (only when todos are shown).
        const todosShown =
          !!todos && (todos.pending > 0 || todos.inProgress > 0 || todos.completed > 0);
        if (todosShown && my === rowFor(2) && inSpan(statusBarTodosSpan())) {
          dispatch({ type: 'toggleTodosMonitor' });
          return;
        }
        // Statusline chips — click to open statusline picker focused on that chip.
        // Field indices are derived from STATUSLINE_ITEMS so they can't drift
        // when the picker's item order changes (line 3: todos/plan/tasks;
        // line 4: fleet).
        const hiddenSet = new Set(statuslineHiddenForPicker());
        if (my === rowFor(2)) {
          const mxLocal = mx - SB_PADX - 1;
          if (!hiddenSet.has('todos') && mxLocal >= 0 && mxLocal < 20) {
            openStatuslinePicker(STATUSLINE_ITEMS.indexOf('todos'));
            return;
          }
          if (!hiddenSet.has('plan')) {
            const planStart = 21;
            if (mxLocal >= planStart && mxLocal < planStart + 22) {
              openStatuslinePicker(STATUSLINE_ITEMS.indexOf('plan'));
              return;
            }
          }
          if (!hiddenSet.has('tasks')) {
            const tasksStart = 44;
            if (mxLocal >= tasksStart && mxLocal < tasksStart + 26) {
              openStatuslinePicker(STATUSLINE_ITEMS.indexOf('tasks'));
              return;
            }
          }
        }
        if (my === rowFor(3) && !hiddenSet.has('fleet')) {
          const mxLocal = mx - SB_PADX - 1;
          const fleetStart = 0;
          if (mxLocal >= fleetStart && mxLocal < fleetStart + 22) {
            openStatuslinePicker(STATUSLINE_ITEMS.indexOf('fleet'));
            return;
          }
        }
      }
      if (key.pageUp) {
        dispatch({ type: 'scrollPage', dir: 'up' });
        return;
      }
      if (key.pageDown) {
        dispatch({ type: 'scrollPage', dir: 'down' });
        return;
      }
    }

    if (key.upArrow) {
      if (!overlayOpen && state.inputHistory.length > 0) {
        dispatch({ type: 'historyUp' });
      }
      return;
    }
    if (key.downArrow) {
      if (!overlayOpen && state.historyIndex > 0) {
        dispatch({ type: 'historyDown' });
      }
      return;
    }
    // Ctrl+P → toggle PhaseMonitor overlay when AutoPhase is active.
    if (key.ctrl && input === 'p') {
      if (state.autoPhase) dispatch({ type: 'autoPhaseMonitorToggle' });
      else {
        // No active AutoPhase — treat as a command alias for /autophase status
        slashRegistry.dispatch('/autophase', agent.ctx).then((res) => {
          if (res?.message)
            dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
        });
      }
      return;
    }
    if (key.ctrl && input === 'a') {
      setDraft(buffer, 0);
      return;
    }
    if (key.ctrl && input === 'e') {
      setDraft(buffer, buffer.length);
      return;
    }
    if (key.ctrl && input === 'u') {
      // Cancel next-steps auto-submit countdown when buffer changes.
      if (nextStepsAutoSubmitTimerRef.current != null) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        nextStepsAutoSubmitSuggestionRef.current = null;
      }
      setDraft('', 0);
      return;
    }
    // Ctrl+D → delete character at cursor (forward delete).
    // Ctrl+D also doubles as "EOF" in some shells — here it's just convenient
    // forward-delete when the user isn't at the terminal's physical Delete key.
    if (key.ctrl && input === 'd') {
      if (cursor >= buffer.length) return;
      // Token-aware forward delete: drop a whole chip if one starts at cursor.
      const span = tokenLengthForward(buffer, cursor) || 1;
      const next = buffer.slice(0, cursor) + buffer.slice(cursor + span);
      // Cancel next-steps auto-submit countdown when buffer changes.
      if (nextStepsAutoSubmitTimerRef.current != null) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        nextStepsAutoSubmitSuggestionRef.current = null;
      }
      setDraft(next, cursor);
      return;
    }

    // Ctrl+K → kill: delete from cursor to end of line.
    if (key.ctrl && input === 'k') {
      if (cursor >= buffer.length) return;
      const next = buffer.slice(0, cursor);
      // Cancel next-steps auto-submit countdown when buffer changes.
      if (nextStepsAutoSubmitTimerRef.current != null) {
        clearInterval(nextStepsAutoSubmitTimerRef.current);
        nextStepsAutoSubmitTimerRef.current = undefined;
        setNextStepsAutoSubmitCountdown(null);
        setNextStepsAutoSubmitLabel(null);
        nextStepsAutoSubmitSuggestionRef.current = null;
      }
      setDraft(next, cursor);
      return;
    }

    // Ctrl+V → paste text from the system clipboard. Raw mode delivers Ctrl+V as
    // a control byte (no native paste) and we don't enable bracketed-paste mode,
    // so we read the clipboard ourselves. Must run before the `key.ctrl` bail
    // below, which would otherwise swallow it.
    if (key.ctrl && input === 'v') {
      await pasteClipboardText();
      return;
    }

    // Alt+V → read image from clipboard and attach as [image #N].
    if (key.meta && input === 'v') {
      await pasteClipboardImage();
      return;
    }

    if (!input || key.ctrl || key.meta) return;

    // Never insert a raw escape sequence as text. An unrecognized F-key or CSI
    // sequence that Ink forwards as `input` would otherwise leak bytes into the
    // row (the F2/F3/F4 overlays are handled above via key.fn from raw stdin).
    if (input.charCodeAt(0) === 0x1b) return;

    // Non-bracketed large paste: some terminals (notably older Windows
    // consoles) don't emit \x1b[200~ markers, so a paste arrives as one big
    // text chunk. Bracketed pastes are already handled by the accumulation
    // guard near the top of handleKey; route big unmarked chunks through the
    // same finalizer so they collapse to a pill consistently.
    if (input.length > PASTE_THRESHOLD_CHARS) {
      await commitPaste(input);
      return;
    }

    // Any multi-line chunk is a paste (Enter was already handled above), even
    // a short non-bracketed one. Route it through the same finalizer so it
    // collapses to an inline `[pasted #N, L lines]` chip instead of leaking
    // newlines (or being flattened to spaces) into the row.
    if (input.includes('\n')) {
      await commitPaste(input);
      return;
    }

    // Cancel next-steps auto-submit countdown when user types anything.
    if (nextStepsAutoSubmitTimerRef.current != null) {
      clearInterval(nextStepsAutoSubmitTimerRef.current);
      nextStepsAutoSubmitTimerRef.current = undefined;
      setNextStepsAutoSubmitCountdown(null);
      setNextStepsAutoSubmitLabel(null);
      nextStepsAutoSubmitSuggestionRef.current = null;
    }

    const next = buffer.slice(0, cursor) + input + buffer.slice(cursor);
    setDraft(next, cursor + input.length);
  };

  /**
   * Drive a single iteration: run the agent against `blocks`, render the
   * result into history, then if any messages were typed while we were
   * busy, pull the head of the queue and recurse. Recursion terminates
   * when the queue is empty (status stays idle).
   */
  const runBlocks = async (blocks: ContentBlock[]): Promise<void> => {
    const ctrl = new AbortController();
    activeCtrlRef.current = ctrl;
    // Each run starts a fresh interrupt cycle: 1st Ctrl+C aborts, 2nd exits.
    // submit() already resets, but queue-drain / runText / autonomy paths
    // re-enter runBlocks without going through submit — without this reset a
    // stale counter from a prior abort would make the next run's first
    // Ctrl+C force-exit instead of aborting.
    dispatch({ type: 'resetInterrupts' });
    dispatch({ type: 'status', status: 'running' });

    try {
      const startedAt = Date.now();
      const before = tokenCounter?.total();
      const costBefore = tokenCounter?.estimateCost().total ?? 0;
      const routed = blocks.some((block) => block.type === 'image')
        ? await routeImagesForModel(blocks, {
            supportsVision: supportsVision
              ? await supportsVision()
              : agent.ctx.provider.capabilities.vision,
            adapters: visionAdapters,
            ctx: agent.ctx,
            signal: ctrl.signal,
            providerId: agent.ctx.provider.id,
            model: agent.ctx.model,
          })
        : { blocks, route: 'none' as const, convertedImages: 0 };
      if (routed.route === 'adapter') {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `Image input analyzed via ${routed.adapterName ?? 'vision adapter'} (${routed.convertedImages} image${routed.convertedImages === 1 ? '' : 's'}).`,
          },
        });
      }
      const result = await agent.run(routed.blocks, { signal: ctrl.signal });

      // Per-iteration assistant text was already committed by the
      // `provider.response` listener as each LLM call finished. Safety net:
      // if anything is still lingering in the synchronous ref (e.g. an
      // aborted run that never received a final provider.response), commit
      // it now so partial output is preserved rather than silently dropped.
      const lingering = streamingTextRef.current;
      if (lingering.trim()) {
        dispatch({ type: 'addEntry', entry: { kind: 'assistant', text: lingering } });
      }
      streamingTextRef.current = '';
      pendingDeltaRef.current = '';
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });

      if (result.status === 'aborted') {
        const reason = result.abortReason
          ? `Aborted (${result.abortReason}).`
          : 'Aborted.';
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: reason } });
      } else if (result.status === 'failed') {
        const err = result.error;
        const text = err
          ? `Failed [${err.severity}${err.recoverable ? ', recoverable' : ''}]: ${err.describe()}`
          : 'Failed.';
        dispatch({
          type: 'addEntry',
          entry: { kind: 'error', text },
        });
      } else if (result.status === 'max_iterations') {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'warn', text: `Hit max iterations (${result.iterations}).` },
        });
      }

      // ── SDD Auto-Detection ──────────────────────────────────────────
      // Process AI output for spec, implementation plan, and task detection.
      if (result.status === 'done' && result.finalText && onSDDOutput) {
        try {
          const sddMessages = await onSDDOutput(result.finalText);
          for (const msg of sddMessages) {
            dispatch({ type: 'addEntry', entry: { kind: 'info', text: msg } });
          }
        } catch {
          // Non-fatal — SDD detection is best-effort
        }
      }

      // ── Next-Step Suggestions (/next) ──────────────────────────────
      // Parse 💡 Next steps from the assistant's final output and store
      // them in the shared suggestion store so `/next 1`, `/next 1 2 3`
      // can discover and execute them without requiring /suggest first.
      if (result.status === 'done' && result.finalText && onSuggestionsParsed) {
        try {
          onSuggestionsParsed(result.finalText);
        } catch {
          // Best-effort — never let suggestion parsing break the turn.
        }
      }

      if (tokenCounter && before) {
        const after = tokenCounter.total();
        const costAfter = tokenCounter.estimateCost().total;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'turn-summary',
            text: `[in: ${fmtTok(after.input - before.input)}  out: ${fmtTok(after.output - before.output)}  iters: ${result.iterations}  cost: ${(costAfter - costBefore).toFixed(4)}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s]`,
          },
        });
      }

      // ── Next-task prediction (/next) ─────────────────────────────────
      // Opt-in. The CLI gates on the toggle + autonomy-off and returns []
      // when disabled, so calling unconditionally here is safe. Best-effort:
      // any failure is swallowed so prediction can never break the turn.
      if (result.status === 'done' && predictNext) {
        try {
          const userRequest = blocks
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join(' ')
            .trim();
          const predictions = await predictNext({
            userRequest,
            assistantSummary: result.finalText ?? '',
          });
          if (predictions.length > 0) {
            const text = ['↳ likely next:', ...predictions.map((p, i) => `  ${i + 1}. ${p}`)].join(
              '\n',
            );
            dispatch({ type: 'addEntry', entry: { kind: 'turn-summary', text } });
          }
        } catch {
          // Best-effort — never let prediction break the turn.
        }
      }
    } catch (err) {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'error', text: toErrorMessage(err) },
      });
    } finally {
      activeCtrlRef.current = null;
      dispatch({ type: 'status', status: 'idle' });
      // Completion chime: terminal bell when agent finishes.
      if (chimeRef.current) {
        try { process.stdout.write('\x07'); } catch { /* stdout closed */ }
      }
    }

    // Drain the queue. If the run was aborted, the SIGINT handler has
    // already cleared the queue, so the head will be undefined.
    const head = stateRef.current.queue[0];
    if (head) {
      dispatch({ type: 'dequeueFirst' });
      // Echo the dequeued message as a USER entry so the user can see
      // which queued message is now being processed — the original
      // queued entry may have scrolled off screen.
      dispatch({
        type: 'addEntry',
        entry: { kind: 'user', text: head.displayText },
      });
      await runBlocks(head.blocks);
    }
  };
  const runBlocksRef = useRef(runBlocks);
  runBlocksRef.current = runBlocks;

  /**
   * Eternal-mode driver. Loops `engine.runOneIteration()` until autonomy
   * flips away from 'eternal' or the engine reports stopped state. Each
   * iteration appends an info entry summarizing what happened so the TUI
   * timeline shows the engine's activity. Runs as a single sequential
   * consumer of `agent.run` — no race with user submissions because user
   * input is gated by `state.status` (a running iteration keeps status
   * at 'running' until the agent.run inside the engine returns).
   */
  const runEternalLoop = async (): Promise<void> => {
    const engine = getEternalEngine?.();
    if (!engine) return;
    // Avoid double-driving if the loop is already running. Status will
    // bounce idle↔running per iteration; the autonomy flag is the source
    // of truth for "should we keep going".
    if (eternalLoopRunningRef.current) return;
    eternalLoopRunningRef.current = true;
    try {
      while (true) {
        // Re-check the live state every iteration — /autonomy stop, SIGINT,
        // or /goal clear could have flipped it during the prior iteration.
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          // Per-iteration entries land via the subscribeEternalIteration
          // useEffect below — we don't need to log here. Only surface
          // *errors* the engine catches but doesn't journal.
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[eternal] ${toErrorMessage(err)}`,
            },
          });
        }
        dispatch({ type: 'status', status: 'idle' });
        // Yield so a slash command submitted between iterations (e.g.
        // /autonomy stop) actually lands before we kick the next one.
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      eternalLoopRunningRef.current = false;
      // Sync the displayed autonomy state with reality. The loop only exits
      // when getAutonomy() !== 'eternal' or engine.currentState === 'stopped',
      // both of which mean the mode is effectively off/idle. Refreshing here
      // stops the status bar from oscillating between "● thinking…" and
      // "● idle" forever after the goal is done.
      if (getAutonomy) {
        const finalMode = getAutonomy();
        if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
      }
    }
  };
  const eternalLoopRunningRef = useRef(false);
  const runEternalLoopRef = useRef(runEternalLoop);
  runEternalLoopRef.current = runEternalLoop;

  /** Parallel-eternal driver — fan-out loop for the ParallelEternalEngine. */
  const runParallelLoop = async (): Promise<void> => {
    const engine = getParallelEngine?.();
    if (!engine) return;
    if (parallelLoopRunningRef.current) return;
    parallelLoopRunningRef.current = true;
    try {
      while (true) {
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal-parallel') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[parallel] ${toErrorMessage(err)}`,
            },
          });
        }
        dispatch({ type: 'status', status: 'idle' });
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      parallelLoopRunningRef.current = false;
      if (getAutonomy) {
        const finalMode = getAutonomy();
        if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
      }
    }
  };
  const parallelLoopRunningRef = useRef(false);
  const runParallelLoopRef = useRef(runParallelLoop);
  runParallelLoopRef.current = runParallelLoop;

  // Subscribe to live per-iteration events from the eternal engine. The
  // engine's loop drive (runEternalLoop above) emits "iteration completed"
  // info entries, but those are coarse — this subscription surfaces the
  // *actual* journal entry per iteration with source, status, and cost.
  // Without it the TUI timeline only shows one-line summaries; with it the
  // user sees `#42 ✓ [todo] refactor parser ($0.0034)`.
  useEffect(() => {
    if (!subscribeEternalIteration) return;
    const unsub = subscribeEternalIteration((entry) => {
      const mark =
        entry.status === 'success'
          ? '✓'
          : entry.status === 'failure'
            ? '✗'
            : entry.status === 'aborted'
              ? '⊘'
              : '·';
      const cost = typeof entry.costUsd === 'number' ? ` ($${entry.costUsd.toFixed(4)})` : '';
      const note = entry.note ? ` — ${entry.note.slice(0, 80)}` : '';
      const text = `#${entry.iteration} ${mark} [${entry.source}] ${entry.task}${cost}${note}`;
      dispatch({ type: 'addEntry', entry: { kind: 'info', text } });
    });
    return unsub;
  }, [subscribeEternalIteration]);

  // Subscribe to live stage-transition events from the eternal engine.
  // Drives `state.eternalStage` used by the status bar to show the
  // engine's current location (decide → execute → reflect → sleep/paused).
  useEffect(() => {
    if (!subscribeEternalStage) return;
    const unsub = subscribeEternalStage((stage) => {
      dispatch({ type: 'eternalStage', stage });
    });
    return unsub;
  }, [subscribeEternalStage]);

  const submit = async (overrideRaw?: string) => {
    const raw = overrideRaw ?? draftRef.current.buffer;
    const trimmed = raw.trim();
    // Attachment chips live inline in the buffer now, so a paste/file-only
    // message is already non-empty here — a single `!trimmed` guard suffices.
    if (!trimmed) {
      // If the user pressed Esc to steer and now hits Enter with an empty
      // buffer, consume the steering state — otherwise the *next* non-empty
      // message picks up a stale STEERING preamble and injects it into a
      // completely unrelated new message. Consuming here gives the user a
      // way to silently cancel steering by pressing Enter on a blank line.
      if (state.steeringPending) {
        dispatch({ type: 'steerConsume' });
      }
      return;
    }

    dispatch({ type: 'resetInterrupts' });
    // Manual input re-arms the next-steps auto-submit loop: the consecutive
    // cap counts AUTOMATIC turns between user inputs only.
    autoSubmitStreakRef.current = 0;
    autoSubmitCapWarnedRef.current = false;
    // Submitting anything snaps the managed viewport back to the newest output
    // (no-op when already pinned or outside mouse mode).
    dispatch({ type: 'scrollToBottom' });
    const pushSubmittedHistory = () => {
      if (trimmed) dispatch({ type: 'historyPush', text: trimmed });
    };
    if (trimmed === '/image' || trimmed === '/paste-image') {
      pushSubmittedHistory();
      clearDraft();
      await pasteClipboardImage();
      return;
    }

    // Slash commands always dispatch immediately, even mid-iteration —
    // they don't conflict with a running agent.
    if (trimmed.startsWith('/')) {
      // Resolve inline chip tokens (pasted content, files, images) to their
      // actual stored content so slash commands like /fix can see the full
      // error text / build output instead of just placeholder tokens.
      let resolvedForDispatch = trimmed;
      const pasteParts: string[] = [];
      for (const m of trimmed.matchAll(new RegExp(INLINE_TOKEN_SRC, 'g'))) {
        const token = m[0];
        const content = tokenPreviewsRef.current.get(token);
        if (content) {
          resolvedForDispatch = resolvedForDispatch.replace(
            token,
            `\n<pasted>\n${content}\n</pasted>`,
          );
        }
        pasteParts.push(token);
        if (content) pasteParts.push(`  ${content.split('\n').slice(0, 6).join('\n  ')}`);
      }
      const pasteContent = pasteParts.length > 0 ? pasteParts.join('\n') : undefined;

      dispatch({ type: 'addEntry', entry: { kind: 'user', text: trimmed, pasteContent } });
      pushSubmittedHistory();
      clearDraft();
      try {
        const res = await slashRegistry.dispatch(resolvedForDispatch, agent.ctx);
        if (res?.message) {
          dispatch({ type: 'addEntry', entry: { kind: 'info', text: res.message } });
        }
        // autoPhaseInit: when /autophase start succeeds, the graph title is
        // embedded in metadata so the TUI can show the PhasePanel immediately
        // even before the first orchestrator event fires.
        if (res?.metadata?.autoPhaseInit) {
          const m = res.metadata.autoPhaseInit as { title: string };
          dispatch({ type: 'autoPhaseInit', title: m.title });
        }
        // /mouse toggles full mouse mode. The command is stateless (it doesn't
        // know the live value), so it emits an intent and the App resolves it
        // against its own `mouseMode` state, persists, and prints the result.
        const mouseToggle = res?.metadata?.mouseToggle as
          | 'on'
          | 'off'
          | 'toggle'
          | 'query'
          | undefined;
        if (mouseToggle) {
          const nextVal =
            mouseToggle === 'on'
              ? true
              : mouseToggle === 'off'
                ? false
                : mouseToggle === 'toggle'
                  ? !mouseMode
                  : mouseMode;
          if (mouseToggle !== 'query' && nextVal !== mouseMode) {
            setMouseMode(nextVal);
            const cur = getSettings?.();
            if (cur && saveSettings) {
              Promise.resolve(saveSettings({ ...cur, mouseMode: nextVal })).catch(() => {});
            }
          }
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'info',
              text: nextVal
                ? 'Mouse mode: ON — wheel scrolls the chat in-app, clickable UI active. (Native scrollback off; Shift+wheel = page.)'
                : 'Mouse mode: OFF — terminal native scrollback restored.',
            },
          });
        }
        // Slash commands like /model and /use mutate agent.ctx directly.
        // Re-sync the visible status bar so the user sees the switch
        // landed; otherwise the bar keeps the startup-time values and
        // /model "feels" broken even when subsequent requests use the
        // new model.
        const ctxModel = agent.ctx.model;
        if (ctxModel && ctxModel !== liveModel) setLiveModel(ctxModel);
        const ctxProviderId = (agent.ctx.provider as { id?: string | undefined } | undefined)?.id;
        if (ctxProviderId && ctxProviderId !== liveProvider) setLiveProvider(ctxProviderId);
        const ctxMaxContext = agent.ctx.provider.capabilities.maxContext;
        if (ctxMaxContext > 0 && ctxMaxContext !== activeMaxContext) {
          setActiveMaxContext(ctxMaxContext);
        }
        if (getYolo) {
          const currentYolo = getYolo();
          if (currentYolo !== yoloLive) setYoloLive(currentYolo);
        }
        if (getAutonomy) {
          const currentAutonomy = getAutonomy();
          if (currentAutonomy !== autonomyLive) setAutonomyLive(currentAutonomy);
          // When /autonomy eternal lands, kick off the engine-driven loop.
          // Fire-and-forget — the loop runs until autonomy flips away from
          // 'eternal' or the engine's currentState goes !== 'running'.
          // Without this, the slash command would set the flag but the
          // TUI would just sit at the prompt waiting for user input.
          if (currentAutonomy === 'eternal' && getEternalEngine) {
            void runEternalLoopRef.current();
          }
          if (currentAutonomy === 'eternal-parallel' && getParallelEngine) {
            void runParallelLoopRef.current();
          }
        }
        if (getModeLabel) {
          const currentMode = getModeLabel();
          if (currentMode !== liveModeLabel) setLiveModeLabel(currentMode);
        }
        if (res?.exit) {
          exit();
          onExit(0);
        }
        // `runText` lets a slash command queue a follow-up user-role
        // message (used by `/steer <text>` to send the STEERING
        // preamble + new direction as if the user had typed it).
        // Run AFTER the message is rendered so the user sees the
        // slash result before the model's response streams.
        if (res?.runText) {
          const b = builderRef.current;
          if (b) {
            b.appendText(res.runText);
            const blocks = await b.submit();
            // Wait briefly for any in-flight abort to settle into
            // 'idle' before kicking the next iteration — otherwise
            // runBlocks would early-return on the busy guard.
            const start = Date.now();
            while (stateRef.current.status !== 'idle' && Date.now() - start < 1500) {
              await new Promise((r) => setTimeout(r, 25));
            }
            // Submit directly without placing the text into the input field.
            // The draft was already cleared above (clearDraft before dispatch),
            // and runBlocks will handle the execution. The finally block
            // ensures the input stays cleared even if runBlocks throws.
            try {
              await runBlocks(blocks);
            } finally {
              clearDraft();
            }
          }
        }
        // Only fire onClearHistory for `/clear` — without this gate every
        // slash command (`/model`, `/use`, `/help`, …) would wipe the
        // conversation. Match the command name segment, not just the
        // prefix, so `/clearfoo` doesn't trigger.
        const cmd = trimmed.slice(1).split(/\s+/, 1)[0];
        if (cmd === 'clear') {
          // Physically wipe the terminal (screen + scrollback) FIRST so the
          // old conversation isn't left reachable above the fresh banner;
          // the clearHistory remount below then reprints the banner onto a
          // clean screen.
          clearTerminal?.();
          onClearHistory?.(dispatch);
          // Reset cumulative token/cost counters so the status bar
          // reflects a fresh session, not pre-clear stats.
          tokenCounter?.reset();
        }
      } catch (err) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'error', text: toErrorMessage(err) },
        });
      }
      return;
    }

    const builder = builderRef.current;
    if (!builder) return;
    // Steering inject: if the user pressed Esc on the prior iteration,
    // prepend a STEERING preamble so the model sees this isn't a
    // follow-up — it's an interrupt redirecting the work. The preamble
    // carries (a) context the model would otherwise have to guess
    // (what tools were running, what subagents were live) and (b)
    // explicit authority — "drop the prior plan, respawn subagents
    // if useful, ask for clarification if needed". Plain user-role
    // text so accountability stays with the human who triggered it.
    const steering = state.steeringPending;

    // ── Prompt refinement ("did you mean this?") ───────────────────────
    // Before the main agent sees the message, run it through a separate
    // one-shot LLM call (its own system prompt, no history) that rewrites it
    // into a clearer instruction, then briefly preview it. The user can let
    // it auto-send (countdown), accept now (Enter), keep the original (Esc),
    // or edit (e). Skipped for steering interrupts and inputs the heuristic
    // judges not worth refining. When chips (file/image/paste tokens) are
    // present, they are stripped before refinement and re-attached afterwards
    // so file references survive the rewrite. Best-effort — any failure falls
    // straight through to the original text.
    let effectiveText = trimmed;
    // Extract inline chips so the enhancer sees clean text, then re-attach
    // them after refinement so file/image references survive.
    const chips: string[] = [];
    let cleanText = trimmed;
    const chipRe = new RegExp(INLINE_TOKEN_SRC, 'g');
    let chipMatch: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((chipMatch = chipRe.exec(trimmed)) !== null) {
      chips.push(chipMatch[0]);
    }
    if (chips.length > 0) {
      // Strip chips from the text for the enhancer — keeps file paths out of
      // the text the model might mangle, but preserves them for re-attachment.
      cleanText = trimmed.replace(chipRe, '').replace(/\s{2,}/g, ' ').trim();
      // If the message is nothing but chips (e.g. pasting a file with no
      // comment), don't bother refining — there's no prose to improve.
      if (!cleanText) {
        cleanText = trimmed; // fall through to send-as-is
        chips.length = 0;    // already in the text, nothing to re-attach
      }
    }
    if (
      enhanceEnabledRef.current &&
      state.status === 'idle' &&
      !steering &&
      shouldEnhance(cleanText)
    ) {
      dispatch({ type: 'enhanceBusy', on: true });
      // Let the user bail out of a slow refine (reasoning models can take many
      // seconds) by pressing Esc while "refining…" shows — handleKey aborts
      // this controller, the call rejects → null → we send the original.
      const ac = new AbortController();
      enhanceAbortRef.current = ac;
      let result: { refined: string; english: string } | null = null;
      let enhanceErr: string | null = null;
      // Refinement is a shallow rewrite — ask the model to spend minimal
      // reasoning (gated to what the model accepts). undefined → no reasoning
      // field is sent, exactly as before.
      const enhanceReasoning = getEnhancerReasoning?.();
      try {
        result = await enhanceUserPrompt({
          provider: agent.ctx.provider,
          model: agent.ctx.model,
          text: cleanText,
          signal: ac.signal,
          onError: (reason) => {
            enhanceErr = reason;
          },
          // Feed recent conversation so follow-ups ("do the same", "that file")
          // resolve against context instead of being refined blind.
          history: recentTextTurns(agent.ctx.messages),
          ...(enhanceReasoning ? { reasoning: enhanceReasoning } : {}),
        }) as { refined: string; english: string } | null;
      } finally {
        enhanceAbortRef.current = null;
        dispatch({ type: 'enhanceBusy', on: false });
      }
      // Surface WHY a refine fell through (provider rejected it, timed out, no
      // text) — otherwise "refining…" vanishing with no panel is confusing.
      // Skipped when the user cancelled it themselves.
      if (result === null && !ac.signal.aborted) {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: enhanceErr
              ? `✨ refinement unavailable (${enhanceErr}) — sent your message as-is`
              : '✨ refinement unavailable — sent your message as-is',
          },
        });
      }
      if (result && !normalizedEqual(result.refined, cleanText)) {
        // Re-attach chips that were stripped before refinement so file/image
        // references survive the rewrite. Chips are appended at the end.
        const chipSuffix = chips.length > 0 ? ` ${chips.join(' ')}` : '';
        const refinedWithChips = result.refined + chipSuffix;
        const englishWithChips = result.english + chipSuffix;
        const decision = await new Promise<'refined' | 'english' | 'original' | 'edit'>((resolve) => {
          dispatch({
            type: 'enhanceOpen',
            info: {
              original: trimmed,
              refined: refinedWithChips,
              english: englishWithChips,
              resolve,
            },
          });
        });
        dispatch({ type: 'enhanceClose' });
        if (decision === 'edit') {
          // Load the refined text back into the input so the user can tweak
          // it and re-submit. Nothing is sent this round.
          setDraft(refinedWithChips, refinedWithChips.length);
          return;
        }
        if (decision === 'english') {
          effectiveText = englishWithChips;
        } else {
          effectiveText = decision === 'refined' ? refinedWithChips : trimmed;
        }
      }
    }

    // ── SDD Context Injection ──────────────────────────────────────────
    // When an SDD session is active, prepend the session context so the
    // model knows it's in a spec-building conversation.
    const sddContext = await getSDDContext?.();
    if (sddContext && trimmed) {
      builder.appendText(`[SDD SESSION ACTIVE]\n${sddContext}\n\n---\nUser message:\n`);
    }

    if (trimmed) {
      const toAppend = steering
        ? buildSteeringPreamble(state.steerSnapshot, effectiveText)
        : effectiveText;
      builder.appendText(toAppend);
    }
    if (steering) dispatch({ type: 'steerConsume' });
    // The user sees their original text + a visual ↯ marker when
    // steering, not the full preamble — keeps the chat readable while
    // the model still gets the explicit instruction.
    const displayText = steering ? `↯ ${effectiveText}` : effectiveText;
    // Build the history preview by scanning the message for inline chip tokens
    // and pulling each one's stored preview. Each chip becomes a label line
    // followed by an indented snippet of its collapsed content.
    const pasteParts: string[] = [];
    for (const m of trimmed.matchAll(new RegExp(INLINE_TOKEN_SRC, 'g'))) {
      const token = m[0];
      const content = tokenPreviewsRef.current.get(token);
      pasteParts.push(token);
      if (content) pasteParts.push(`  ${content.split('\n').slice(0, 6).join('\n  ')}`);
    }
    const pasteContent = pasteParts.length > 0 ? pasteParts.join('\n') : undefined;
    pushSubmittedHistory();
    clearDraft();
    const blocks = await builder.submit();

    if (state.status !== 'idle' && !steering) {
      // Agent is busy — queue this message for the drainer to pick up.
      // Abort any next-steps auto-submit countdown since user is providing input.
      // Only cancel autonomy if a countdown was actually running — otherwise
      // this would override the user's explicit 'auto' selection in the
      // autonomy picker (which also fires this handler via Enter).
      //
      // ── Steering override (#87) ────────────────────────────────────
      // When the user has just confirmed an Esc interrupt (or run `/steer`),
      // `steeringPending` is true and `state.status` is 'aborting' — the
      // active controller is mid-settle. Without this override the message
      // is queued behind the interrupted work and the user's "new
      // direction" is never acted on. With the override, we fall through
      // to the normal `runBlocks(blocks)` path below; `buildSteeringPreamble`
      // (line ~5964) prepends the STEERING preamble using `steerSnapshot`,
      // and `dispatch({ type: 'steerConsume' })` clears `steeringPending`
      // so subsequent submits go through the normal queue branch again.
      if (autonomyLive === 'auto' && nextStepsAutoSubmitTimerRef.current != null) {
        switchAutonomy?.('off');
      }
      // A steering redirect is NOT a backlog item (#87). The Esc-interrupt
      // already cleared the queue, so this becomes queue[0] and the drainer
      // runs it the instant the aborting iteration settles — echoing it then as
      // a clean `↯`-marked user entry (see the drain after runBlocks' finally).
      // Adding a greyed "queued" entry here would both mislead (it reads as
      // backlog, not the next thing to run) and double up with that drain echo.
      // So when steering, enqueue silently and let the drainer surface it.
      if (!steering) {
        dispatch({
          type: 'addEntry',
          entry: { kind: 'user', text: displayText, queued: true, pasteContent },
        });
      }
      dispatch({ type: 'enqueue', item: { displayText, blocks } });
      return;
    }

    dispatch({ type: 'addEntry', entry: { kind: 'user', text: displayText, pasteContent } });

    // ── Abort auto-proceed countdown ────────────────────────────────────
    // User submitted input — abort any pending next-steps auto-submit
    // countdown and switch to manual mode so the next step waits for
    // explicit trigger. Only cancel if a countdown was actually running —
    // otherwise this would override the user's explicit 'auto' selection
    // in the autonomy picker (which also fires this handler via Enter).
    if (autonomyLive === 'auto' && nextStepsAutoSubmitTimerRef.current != null) {
      switchAutonomy?.('off');
    }

    await runBlocks(blocks);
  };

  // ─── --goal / --ask boot inject ─────────────────────────────────────
  // The CLI may pass `--goal "..."` or `--ask "..."` to pre-populate the
  // very first turn. `initialGoal` wraps the text in the GOAL preamble so
  // the model lands in autonomous goal mode; `initialAsk` submits the text
  // verbatim (handy for scripted shell aliases). Both fire one-shot via a
  // mount-time ref guard so a re-render can't double-submit. We wait a tick
  // for the input builder to settle, then push directly into runBlocks —
  // bypassing the slash registry / submit() path keeps the boot path
  // self-contained even if user-installed slash commands haven't mounted
  // their effects yet.
  const bootInjectedRef = useRef(false);
  useEffect(() => {
    if (bootInjectedRef.current) return;
    bootInjectedRef.current = true;
    const goal = initialGoal?.trim();
    const ask = initialAsk?.trim();
    if (!goal && !ask) return;
    void (async () => {
      // Give the banner a frame to render first so the user sees the
      // greeting before the first turn streams over the top of it.
      await new Promise((r) => setTimeout(r, 50));
      const b = builderRef.current;
      if (!b) return;
      if (goal) {
        const shortGoal = goal.length > 80 ? `${goal.slice(0, 80)}…` : goal;
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `🎯 Goal locked: ${shortGoal}\n   Agent will work until verifiably complete. Esc / /steer to redirect, Ctrl+C to stop.`,
          },
        });
        b.appendText(buildGoalPreamble(goal));
      } else if (ask) {
        dispatch({ type: 'addEntry', entry: { kind: 'user', text: ask } });
        b.appendText(ask);
      }
      const blocks = await b.submit();
      await runBlocksRef.current(blocks);
    })();
  }, [initialAsk, initialGoal]);

  // Expose the latest handleKey for the keyboard event pipeline.
  handleKeyRef.current = handleKey;

  // Stable callback wrapping handleKey via ref — prevents Input from
  // re-rendering on every nowTick tick (which bleeds the prompt line into
  // native scrollback in inline mode). handleKey itself captures many
  // mutable state values in its closure and must be recreated each render,
  // but the Input only needs a stable function reference that delegates
  // to the latest closure via the ref.
  const stableOnKey = useCallback((input: string, key: KeyEvent) => {
    handleKeyRef.current?.(input, key);
  }, []);

  const inputHint = useMemo(() => {
    if (state.status !== 'idle') return '';
    if (state.buffer.startsWith('/')) return 'slash command — Enter to dispatch';
    if (state.picker.open) return '';
    return '';
  }, [state.buffer, state.status, state.picker.open]);

  // True while a prompt-refinement call is in flight or its preview panel is
  // open. Used to blank the live input row (so the un-cleared draft can't bleed
  // into scrollback) and to drive the per-tick live-region erase below.
  const enhanceActive = state.enhanceBusy || state.enhance != null;

  // Pre-compute how many visual rows the current input buffer occupies.
  // Used as the placeholder height when the Input is hidden (enhance panel,
  // monitor overlays) so the bottom region never changes height — preventing
  // Ink's log-update from bleeding the live region into native scrollback.
  const inputCellRows = layoutInputRows(
    INPUT_PROMPT,
    state.buffer,
    state.cursor,
    stdout?.columns ?? 80,
  );
  const inputHeight = Math.max(1, inputCellRows.length);

  // The chat input stays LIVE underneath the read-only monitor panels (fleet,
  // agents, worktree, todos, queue, goal) so the user can keep typing and
  // submitting while watching them. Only three states hide the input:
  //   • enhance — the EnhancePanel owns the input area
  //   • help    — modal `?` overlay (handleKey swallows all but Esc/?/q)
  //   • process list — its single-key kill actions (Enter/Del/a/A/r) own the
  //     keyboard and would collide with typing, so it stays modal.
  // (Each live panel that needs navigation reads ↑↓ through its own useInput;
  // letter shortcuts that would clash with typing have been removed — see
  // AgentsMonitor.)
  const hideInput = enhanceActive || state.helpOpen || state.processListOpen;

  // F2–F9 panels should all occupy the same first row below the statusline.
  // Keep persistent background panels (fleet summary, phase/worktree strips)
  // out of this slot while a function-key panel is open; otherwise F5/F7/F8/F9
  // start one panel lower than F2/F3/F4/F6.
  const lowerFunctionPanelOpen =
    state.monitorOpen ||
    state.agentsMonitorOpen ||
    (state.autoPhase?.monitorOpen ?? false) ||
    state.worktreeMonitorOpen ||
    state.planPanelOpen ||
    state.todosMonitorOpen ||
    state.queuePanelOpen ||
    state.processListOpen ||
    state.goalPanelOpen;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" flexGrow={1} flexShrink={0}>
        {mouseMode ? (
          <ScrollableHistory
            entries={state.entries}
            streamingText={state.streamingText}
            toolStream={state.toolStream}
            scrollOffset={state.scrollOffset}
            viewportRows={state.viewportRows}
            totalLines={state.totalLines}
            onMeasure={(totalLines) => dispatch({ type: 'setMeasuredLines', totalLines })}
            setSuggestions={setSuggestions}
            autonomyMode={autonomyLive}
            multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
          />
        ) : (
          <History
            entries={state.entries}
            generation={state.historyGen}
            streamingText={state.streamingText}
            toolStream={state.toolStream}
            setSuggestions={setSuggestions}
            autonomyMode={autonomyLive}
            multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
          />
        )}
        <Box flexDirection="column" flexShrink={0} ref={bottomRegionRef}>
          {/* NOTE: the LiveActivityStrip is deliberately NOT rendered in inline
              mode. Like the live tool-stream box (see history/index.tsx), it sits
              at the bottom edge of a full terminal, so every fleet tool.progress
              re-render scrolls the screen by a line and strands the strip's top
              row permanently in native scrollback — a busy subagent (100+ rapid
              tool calls) re-stamps the "● <name> … last: …" line dozens of times,
              differing only by the elapsed timer. The strip's constant-height
              guard only defends against height-change leaks, not bottom-edge
              scroll; Ink can't avoid this without owning the screen. Fleet
              activity stays visible via the status bar and the F3 agents monitor.
              The component + its tests are kept for a future managed (alt-screen)
              ScrollableHistory path, where in-place redraw is leak-safe. */}
          {/* While enhance is active or a monitor overlay is open, the Input is
              rendered HIDDEN: its visible rows collapse to a constant-height
              placeholder (so Ink's log-update never bleeds the live region into
              static scrollback, and no characters pollute the history area), but
              its keyboard listeners stay mounted. Keeping them mounted is what
              keeps the central `handleKey` router — and the F-key/Esc toggles
              that close the monitor overlays — alive. Unmounting the Input here
              previously left the F3 agents monitor (and the other panels)
              un-closable: F-key parsing and Esc handling both live in Input. */}
          <Input
            prompt={INPUT_PROMPT}
            value={state.buffer}
            cursor={state.cursor}
            hidden={hideInput}
            placeholderHeight={inputHeight}
            disabled={
              (state.status === 'aborting' && !state.steeringPending) ||
              state.confirmQueue.length > 0
            }
            hint={inputHint}
            onKey={stableOnKey}
          />
          {state.picker.open ? (
            <FilePicker
              query={state.picker.query}
              matches={state.picker.matches}
              selected={state.picker.selected}
            />
          ) : null}
          {state.slashPicker.open ? (
            <SlashMenu
              query={state.slashPicker.query}
              matches={state.slashPicker.matches}
              selected={state.slashPicker.selected}
            />
          ) : null}
          {state.modelPicker.open ? (
            <ModelPicker
              step={state.modelPicker.step}
              providerOptions={state.modelPicker.providerOptions}
              modelOptions={state.modelPicker.modelOptions}
              filteredOptions={state.modelPicker.filteredOptions}
              selected={state.modelPicker.selected}
              pickedProviderId={state.modelPicker.pickedProviderId}
              searchQuery={state.modelPicker.searchQuery}
              hint={state.modelPicker.hint}
            />
          ) : null}
          {state.autonomyPicker.open ? (
            <AutonomyPicker
              options={state.autonomyPicker.options}
              selected={state.autonomyPicker.selected}
              hint={state.autonomyPicker.hint}
            />
          ) : null}
          {state.designPicker.open ? (
            <DesignPicker
              kits={state.designPicker.kits}
              selected={state.designPicker.selected}
              stack={state.designPicker.stack}
            />
          ) : null}
          {state.resumePicker.open ? (
            <ResumePicker
              sessions={state.resumePicker.sessions}
              selected={state.resumePicker.selected}
              busy={state.resumePicker.busy}
              error={state.resumePicker.error}
              hint={state.resumePicker.hint}
            />
          ) : null}
          {state.settingsPicker.open ? (
            <SettingsPicker
              field={state.settingsPicker.field}
              mode={state.settingsPicker.mode}
              delayMs={state.settingsPicker.delayMs}
              titleAnimation={state.settingsPicker.titleAnimation}
              yolo={state.settingsPicker.yolo}
              streamFleet={state.settingsPicker.streamFleet}
              chime={state.settingsPicker.chime}
              confirmExit={state.settingsPicker.confirmExit}
              nextPrediction={state.settingsPicker.nextPrediction}
              featureMcp={state.settingsPicker.featureMcp}
              featurePlugins={state.settingsPicker.featurePlugins}
              featureMemory={state.settingsPicker.featureMemory}
              featureSkills={state.settingsPicker.featureSkills}
              featureModelsRegistry={state.settingsPicker.featureModelsRegistry}
              tokenSavingTier={state.settingsPicker.tokenSavingTier}
              allowOutsideProjectRoot={state.settingsPicker.allowOutsideProjectRoot}
              contextAutoCompact={state.settingsPicker.contextAutoCompact}
              contextStrategy={state.settingsPicker.contextStrategy}
              contextMode={state.settingsPicker.contextMode}
              maxConcurrent={state.settingsPicker.maxConcurrent}
              logLevel={state.settingsPicker.logLevel}
              auditLevel={state.settingsPicker.auditLevel}
              indexOnStart={state.settingsPicker.indexOnStart}
              multiDiffSummaryThreshold={state.settingsPicker.multiDiffSummaryThreshold}
              thinkingWord={state.settingsPicker.thinkingWord}
              thinkingWordEditing={state.settingsPicker.thinkingWordEditing}
              thinkingWordDraft={state.settingsPicker.thinkingWordDraft}
              maxIterations={state.settingsPicker.maxIterations}
              autoProceedMaxIterations={state.settingsPicker.autoProceedMaxIterations}
              enhanceDelayMs={state.settingsPicker.enhanceDelayMs}
              enhanceEnabled={state.settingsPicker.enhanceEnabled}
              enhanceLanguage={state.settingsPicker.enhanceLanguage}
              debugStream={state.settingsPicker.debugStream}
              statuslineMode={state.settingsPicker.statuslineMode}
              reasoningMode={state.settingsPicker.reasoningMode}
              reasoningEffort={state.settingsPicker.reasoningEffort}
              reasoningPreserve={state.settingsPicker.reasoningPreserve}
              cacheTtl={state.settingsPicker.cacheTtl}
              configScope={state.settingsPicker.configScope}
              filter={state.settingsPicker.filter}
              hint={state.settingsPicker.hint}
            />
          ) : null}
          {state.statuslinePicker.open ? (
            <StatuslinePicker
              field={state.statuslinePicker.field}
              hiddenItems={state.statuslinePicker.hiddenItems}
              visibleChips={state.statuslinePicker.visibleChips}
              hint={state.statuslinePicker.hint}
            />
          ) : null}
          {state.projectPicker.open ? (
            <ProjectPicker
              items={state.projectPicker.items}
              selected={state.projectPicker.selected}
              filter={state.projectPicker.filter}
              hint={state.projectPicker.hint}
            />
          ) : null}
          {state.fKeyPicker.open ? (
            <FKeyPicker selected={state.fKeyPicker.selected} />
          ) : null}
          {state.sessionsPanelOpen ? (
            <SessionsPanel
              sessions={state.sessionsPanel.sessions}
              busy={state.sessionsPanel.busy}
              selected={state.sessionsPanel.selected}
              resumeConfirm={state.sessionResumeConfirm ? { sessionName: state.sessionResumeConfirm.sessionName } : undefined}
              currentSessionId={agent.ctx.session?.id}
            />
          ) : null}
          {state.coordinator.monitorOpen ? (
            <CoordinatorPanel
              coordinator={state.coordinator}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'toggleCoordinatorMonitor' })}
            />
          ) : null}
          {state.rewindOverlay
            ? (() => {
                const overlay = state.rewindOverlay;
                return (
                  <CheckpointTimeline
                    checkpoints={overlay.checkpoints}
                    selected={overlay.selected}
                    onSelect={(i) =>
                      dispatch({ type: 'rewindOverlayMove', delta: i - overlay.selected })
                    }
                    onConfirm={(i) => {
                      const checkpoint = overlay.checkpoints[i];
                      if (checkpoint) handleRewindTo(checkpoint.promptIndex);
                    }}
                    onClose={() => dispatch({ type: 'rewindOverlayClose' })}
                  />
                );
              })()
            : null}
          {state.brainPrompt ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              <BrainDecisionPrompt
                {...state.brainPrompt}
                onAnswer={(answer) => {
                  events.emit('brain.human_answered', { ...answer, at: Date.now() });
                  dispatch({ type: 'brainPromptClear' });
                }}
              />
            </Box>
          ) : null}
          {state.confirmQueue.length > 0 &&
            (() => {
              const head = expectDefined(state.confirmQueue[0]);
              let resolved = false;
              const onDecision = (decision: ConfirmDecision) => {
                if (resolved) return;
                resolved = true;
                head.resolve(decision);
                dispatch({ type: 'confirmClose' });
              };
              return (
                <ConfirmPrompt
                  toolName={head.toolName}
                  input={head.input}
                  suggestedPattern={head.suggestedPattern}
                  onDecision={onDecision}
                />
              );
            })()}
          {state.escConfirm ? (
            <Box flexDirection="column" marginY={1} flexShrink={0}>
              <EscConfirmPrompt
                runningTools={state.escConfirm.snapshot.runningTools}
                subagentCount={state.escConfirm.snapshot.subagentsTerminated}
                onConfirm={() => {
                  const escConfirm = state.escConfirm;
                  if (!escConfirm) return;
                  const { snapshot } = escConfirm;
                  activeCtrlRef.current?.abort('user interrupt (Esc)');
                  dispatch({ type: 'status', status: 'aborting' });
                  dispatch({ type: 'steerStart', snapshot });
                  if (director && snapshot.subagentsTerminated > 0) {
                    const cap = new Promise<void>((resolve) => {
                      const t = setTimeout(resolve, 1500);
                      t.unref?.();
                    });
                    void Promise.race([director.terminateAll().catch(() => undefined), cap]);
                  }
                  const droppedCount = state.queue.length;
                  if (droppedCount > 0) dispatch({ type: 'queueClear' });
                  const droppedTag = droppedCount > 0 ? ` · dropped ${droppedCount} queued` : '';
                  const fleetTag =
                    snapshot.subagentsTerminated > 0
                      ? ` · stopped ${snapshot.subagentsTerminated} subagent${snapshot.subagentsTerminated === 1 ? '' : 's'}`
                      : '';
                  dispatch({
                    type: 'addEntry',
                    entry: {
                      kind: 'warn',
                      text: `↯ Interrupted${droppedTag}${fleetTag}. Type your new direction.`,
                    },
                  });
                  dispatch({ type: 'escConfirmClose' });
                }}
                onCancel={() => {
                  dispatch({ type: 'escConfirmClose' });
                }}
              />
            </Box>
          ) : null}
          {state.enhanceBusy && !state.enhance ? (
            <Box paddingX={1}>
              <Text dimColor>
                ✨ refining{' '}
                <Text color="cyan">
                  {state.buffer.length > 100
                    ? `${state.buffer.slice(0, 97)}…`
                    : state.buffer}
                </Text>
                <Text color="cyan"> {'.'.repeat(enhanceDots) || '\u00A0'}</Text>
              </Text>
            </Box>
          ) : null}
          {state.enhance
            ? (() => {
                const info = state.enhance;
                let resolved = false;
                const onDecision = (decision: 'refined' | 'english' | 'original' | 'edit') => {
                  if (resolved) return;
                  resolved = true;
                  setEnhanceCountdown(null);
                  info.resolve(decision);
                };
                return (
                  <EnhancePanel
                    original={info.original}
                    refined={info.refined}
                    english={info.english}
                    delayMs={enhanceDelayMs}
                    onDecision={onDecision}
                    onTick={(r) => setEnhanceCountdown(r > 0 ? r : null)}
                  />
                );
              })()
            : null}
          <Box ref={statusBarWrapRef} flexDirection="column" flexShrink={0}>
          <StatusBar
            model={`${liveProvider}/${liveModel}`}
            version={appVersion}
            state={state.status}
            thinkingWord={displayThinkingWord}
            tokenCounter={tokenCounter}
            hint={renderRunningTools(state.runningTools) || state.hint}
            queueCount={state.queue.length}
            yolo={yoloLive}
            autonomy={autonomyLive}
            startedAt={startedAtRef.current}
            todos={todos}
            plan={planCounts ?? undefined}
            tasks={taskCounts ?? undefined}
            fleet={fleetCounts}
            git={gitInfo}
            context={contextWindow}
            contextStrategy={getSettings ? getSettings().contextStrategy : undefined}
            brain={state.brain}
            projectName={projectName}
            workingDir={workingDirChip}
            subagentCount={Object.keys(state.fleet).length}
            processCount={getProcessRegistry().activeCount}
            hiddenItems={hiddenItems}
            mode={liveStatuslineMode}
            visibleChips={state.statuslinePicker.visibleChips}
            events={events}
            eternalStage={state.eternalStage}
            goalSummary={state.goalSummary}
            indexState={indexState}
            breakerCountdown={breakerCountdown}
            modeLabel={liveModeLabel || undefined}
            debugStreamStats={state.debugStreamStats}
            enhanceCountdown={enhanceCountdown}
            nextStepsAutoSubmitCountdown={nextStepsAutoSubmitCountdown}
            nextStepsAutoSubmitLabel={nextStepsAutoSubmitLabel}
            autoProceedCountdown={state.countdown?.remainingSeconds ?? null}
            sessionCount={sessionCount}
            mailbox={mailboxStatus}
            tokenSavingMode={getSettings ? getSettings().featureTokenSaving !== 'off' : tokenSavingMode}
            toolCount={toolCount}
          />
          </Box>
          {/* Mailbox panel — toggled via /mailbox slash command */}
          <MailboxPanel
            messages={mailboxMessages}
            agents={mailboxAgents}
            unreadCount={mailboxStatus.unread}
            open={mailboxPanelOpen}
          />
          {/* Everything below the status bar is wrapped so its height can be
              measured (via belowStatusBarRef) — the status-bar mouse hit-test
              subtracts it from termRows to find the bar's absolute rows. */}
          <Box ref={belowStatusBarRef} flexDirection="column" flexShrink={0}>
          {/* Keys-&-commands help overlay (`?` on an empty prompt). Modal: while
          open, handleKey swallows everything but Esc/?/q, so it never coexists
          with a monitor. */}
          {state.helpOpen ? <HelpOverlay /> : null}
          {/* Agents monitor overlay (Ctrl+G) and fleet monitor overlay (Ctrl+F)
          take up the lower region — hide FleetPanel while any overlay is open. */}
          {state.agentsMonitorOpen ? (
            <AgentsMonitor
              entries={entriesWithLeader}
              totalCost={state.fleetCost}
              leaderCost={tokenCounter?.estimateCost().total ?? 0}
              totalTokens={state.fleetTokens}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'toggleAgentsMonitor' })}
            />
          ) : state.autoPhase?.monitorOpen ? (
            <PhaseMonitor
              phases={state.autoPhase.phases}
              runningPhaseIds={state.autoPhase.runningPhaseIds}
              elapsedMs={state.autoPhase.elapsedMs}
              nowTick={nowTick}
            />
          ) : state.sddBoard?.monitorOpen ? (
            <SddBoardOverlay
              snapshot={state.sddBoard.snapshot}
              focusColumn={state.sddBoard.focusColumn ?? null}
            />
          ) : state.worktreeMonitorOpen ? (
            <WorktreeMonitor
              worktrees={state.worktrees}
              baseBranch={state.worktreeBase}
              nowTick={nowTick}
              onClose={() => dispatch({ type: 'worktreeMonitorToggle' })}
            />
          ) : state.todosMonitorOpen ? (
            <TodosMonitor todos={agent.ctx.todos} />
          ) : state.monitorOpen ? (
            <FleetMonitor
              entries={state.fleet}
              totalCost={state.fleetCost}
              totalTokens={state.fleetTokens}
              maxConcurrent={state.fleetConcurrency}
              nowTick={nowTick}
              collabSession={state.collabSession}
            />
          ) : state.planPanelOpen ? (
            <PlanPanel
              projectRoot={agent.ctx.projectRoot}
              sessionId={agent.ctx.session?.id ?? null}
              onClose={() => dispatch({ type: 'togglePlanPanel' })}
            />
          ) : state.queuePanelOpen ? (
            <QueuePanel items={state.queue} />
          ) : state.processListOpen ? (
            <ProcessListMonitor />
          ) : state.goalPanelOpen ? (
            <GoalPanel
              goal={state.goalSummary}
              onCoordinatorStart={onCoordinatorStart ?? undefined}
              onCoordinatorStop={onCoordinatorStop ?? undefined}
              coordinatorRunning={coordinatorRunning}
            />
          ) : director ? (
            <FleetPanel
              entries={entriesWithLeader}
              totalCost={state.fleetCost}
              roster={fleetRoster}
              collabSession={state.collabSession}
            />
          ) : null}
          {state.autoPhase && !lowerFunctionPanelOpen ? (
            <PhasePanel
              phases={state.autoPhase.phases}
              runningPhaseIds={state.autoPhase.runningPhaseIds}
              nowTick={nowTick}
            />
          ) : null}
          {Object.keys(state.worktrees).length > 0 &&
          !lowerFunctionPanelOpen ? (
            <WorktreePanel worktrees={state.worktrees} nowTick={nowTick} />
          ) : null}
          {/* Key hint bar — shows keyboard shortcuts and a discovery hint for the next panel. */}
          {(() => {
            const anyMonitorOpen =
              state.agentsMonitorOpen ||
              (state.autoPhase?.monitorOpen ?? false) ||
              state.worktreeMonitorOpen ||
              state.todosMonitorOpen ||
              state.monitorOpen ||
              state.processListOpen ||
              state.queuePanelOpen ||
              state.goalPanelOpen;
            // Compute the next panel hint based on the currently open monitor.
            // Panels cycle in this order: agents(F3) → todos(F6) → goal(F9) → agents
            let nextPanelHint: KeyHintContext['nextPanelHint'];
            if (state.agentsMonitorOpen) {
              nextPanelHint = { key: 'F6', label: 'todos' };
            } else if (
              state.autoPhase?.monitorOpen ||
              state.worktreeMonitorOpen ||
              state.todosMonitorOpen
            ) {
              nextPanelHint = { key: 'F9', label: 'goal' };
            } else if (state.queuePanelOpen || state.processListOpen || state.goalPanelOpen) {
              nextPanelHint = { key: 'F3', label: 'agents' };
            } else if (anyMonitorOpen) {
              nextPanelHint = { key: 'F3', label: 'agents' };
            }
            const ctx: KeyHintContext = {
              monitor: anyMonitorOpen,
              managed: state.scrollOffset > 0,
              picker: state.settingsPicker.open || state.modelPicker.open || state.autonomyPicker.open || state.designPicker.open,
              nextPanelHint,
            };
            return <KeyHintBar context={ctx} />;
          })()}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

/**
 * Render an at-a-glance "running: …" hint for the status bar. Shows the
 * oldest in-flight tool by name; if more than one, appends "(+N)".
 */
export function renderRunningTools(
  running: ReadonlyMap<string, { name: string; startedAt: number }>,
): string {
  if (running.size === 0) return '';
  let oldest: { name: string; startedAt: number } | null = null;
  for (const info of running.values()) {
    if (!oldest || info.startedAt < oldest.startedAt) oldest = info;
  }
  if (!oldest) return '';
  const elapsedSec = ((Date.now() - oldest.startedAt) / 1000).toFixed(1);
  const more = running.size > 1 ? ` (+${running.size - 1})` : '';
  return `running: ${oldest.name} ${elapsedSec}s${more}`;
}

/**
 * Find an active `@<query>` token at the cursor. The token starts at the
 * last `@` not preceded by a non-whitespace char, and runs up to the cursor
 * (no whitespace allowed inside). Returns null if no active token.
 */
export function detectAtToken(
  buffer: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  let i = cursor - 1;
  while (i >= 0) {
    const ch = buffer.charCodeAt(i);
    if (ch === 64 /* @ */) {
      // Must be at the start of buffer or preceded by whitespace.
      if (i === 0 || /\s/.test(buffer[i - 1] ?? '')) {
        return { start: i, end: cursor, query: buffer.slice(i + 1, cursor) };
      }
      return null;
    }
    if (ch === 32 /* space */ || ch === 9 /* tab */ || ch === 10 /* nl */) return null;
    i--;
  }
  return null;
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
