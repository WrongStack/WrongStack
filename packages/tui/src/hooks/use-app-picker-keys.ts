import type { PromptUsageStore } from '@wrongstack/core/storage';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Dispatch, MutableRefObject } from 'react';
import { useEffect, useRef } from 'react';
import type { Action } from '../app-action-type.js';
import type { AppProps } from '../app-props.js';
import type { State } from '../app-state.js';
import { F_KEY_ENTRIES } from '../components/f-key-picker.js';
import { filterPromptPicker } from '../components/prompt-picker.js';
import { THINKING_WORD_FIELD, WRONGPROXY_URL_FIELD } from '../components/settings-picker-model.js';
import type { StatuslineItem } from '../components/statusline-picker.js';
import { actionForFKeyPanel } from '../f-key-panels.js';
import {
  RESUME_SPINNER_MS,
  RESUME_STREAM_FRAME_MS,
  resumeChunkSize,
  resumeStageLabel,
} from '../resume-load.js';
import { selectedSlashCommandLine } from '../slash-command-search.js';
import type { useAuthPanel } from './use-auth-panel.js';
import type { useBrainPanel } from './use-brain-panel.js';
import type { ModelPickRequestController } from './use-model-pick.js';
import type { usePanelControllers } from './use-panel-controllers.js';
import { usePickerKeys } from './use-picker-keys.js';
import type { useStatusbarViewModel } from './use-statusbar-view-model.js';
import type { useTuiEnvironmentState } from './use-tui-environment-state.js';

interface UseAppPickerKeysOptions {
  host: AppProps;
  state: State;
  dispatch: Dispatch<Action>;
  environment: ReturnType<typeof useTuiEnvironmentState>;
  statusbar: ReturnType<typeof useStatusbarViewModel>;
  panelControllers: ReturnType<typeof usePanelControllers>;
  authPanelController: ReturnType<typeof useAuthPanel>;
  brainController: ReturnType<typeof useBrainPanel>;
  lastEnterAtRef: MutableRefObject<number>;
  inputGateRef: MutableRefObject<boolean>;
  submitRef: MutableRefObject<(text?: string) => void>;
  promptUsageRef: MutableRefObject<PromptUsageStore | null>;
  setDraft: (buffer: string, cursor: number) => void;
  acceptSlashPickerSelection: () => void;
  changeBrainRisk: (delta: number) => void;
  handleModelPicked: ModelPickRequestController['handleModelPicked'];
  handleShadowStart: () => Promise<void>;
  handleShadowStop: () => Promise<void>;
  statuslineHiddenForPicker: () => StatuslineItem[];
  onPickerEnter: () => Promise<void>;
  onThemePickerEnter?: () => void;
  setPromptFavorite: (slug: string, favorite: boolean) => Promise<void>;
}

export function useAppPickerKeys({
  host,
  state,
  dispatch,
  environment,
  statusbar,
  panelControllers,
  authPanelController,
  brainController,
  lastEnterAtRef,
  inputGateRef,
  submitRef,
  promptUsageRef,
  setDraft,
  acceptSlashPickerSelection,
  changeBrainRisk,
  handleModelPicked,
  handleShadowStart,
  handleShadowStop,
  statuslineHiddenForPicker,
  onPickerEnter,
  onThemePickerEnter,
  setPromptFavorite,
}: UseAppPickerKeysOptions) {
  const {
    agent,
    onProjectSelect,
    onResumeSession,
    setSuggestions,
    onSwitchToSession,
    requestExit,
    switchAutonomy,
    switchProviderAndModel,
  } = host;
  const {
    activeMaxContext,
    liveModel,
    liveProvider,
    setActiveMaxContext,
    setLiveModel,
    setLiveProvider,
  } = environment;
  const { currentContextTokens } = statusbar;
  const {
    openProjectPicker,
    restartSelectedMcpServer,
    toggleSelectedMcpServer,
    toggleSelectedPlugin,
    toggleSelectedTool,
  } = panelControllers;
  const brainCtl = brainController;
  const projectRoot = agent.ctx.projectRoot;
  // Sync in-flight lock for /resume (see onResumePickerEnter): a ref, not the
  // `busy` state, because the 50ms paint yield re-opens a window where a
  // second Enter still holds the pre-busy state snapshot.
  const resumeInFlightRef = useRef(false);
  // Same lock for the F10 sessions-panel confirm flow (see
  // onSessionsPanelEnter): that branch has no busy-state guard at all — a
  // stale `sessionResumeConfirm` snapshot re-runs onResumeSession on every
  // Enter until React re-renders, so the ref is the only double-fire guard.
  const sessionsResumeInFlightRef = useRef(false);
  // Flips false at unmount: both resume chains (paint yield + host promise)
  // can settle long after this component is gone, and dispatching into an
  // unmounted reducer only risks stale-panel state. The chain bodies check
  // this before dispatching; the in-flight locks still release
  // unconditionally in their .finally.
  const mountedRef = useRef(true);
  useEffect(() => {
    // Re-arm on the StrictMode simulated remount as well.
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Supersedes an in-flight resume: every async continuation below re-checks
  // its captured token, so a second /resume (or a failure) abandons the first
  // one's chunk pump instead of interleaving two transcripts.
  const resumeRunRef = useRef(0);

  /**
   * Run one resume, from the wipe to the last streamed entry.
   *
   * Shared by the `/resume` picker and the F10 sessions panel so the two cannot
   * drift into showing different things for the same operation.
   *
   * The shape of it is the whole feature: clear the screen the way `/clear`
   * does, show a live block while the journal is read (seconds, with nothing
   * else on screen), then stream the transcript in so it scrolls into place the
   * way it did when it was live — and stop there, waiting.
   */
  const runResume = async (
    sessionId: string,
    label: string,
    hooks: { onSettled?: (() => void) | undefined } = {},
  ): Promise<void> => {
    resumeRunRef.current += 1;
    const run = resumeRunRef.current;
    const alive = () => mountedRef.current && resumeRunRef.current === run;

    dispatch({ type: 'resumeLoadStart', sessionId, label });
    dispatch({ type: 'hint', text: `Resuming "${label}"…` });
    // The spinner is the only thing that moves while a big journal parses; the
    // loader's own progress ticks are throttled to ~4/sec and a warm cache
    // reports a single completed tick, so neither can carry the animation.
    const spinner = setInterval(() => {
      if (!alive()) return;
      dispatch({ type: 'resumeLoadTick' });
    }, RESUME_SPINNER_MS);
    const stop = () => clearInterval(spinner);

    // Paint BEFORE the host work starts: the parse blocks this event loop in
    // bursts, so without a scheduler turn Ink never commits the frame above and
    // Enter looks like a silent no-op.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    if (!alive()) {
      stop();
      hooks.onSettled?.();
      return;
    }

    try {
      const result = await onResumeSession?.(
        sessionId,
        (progress) => {
          if (!alive()) return;
          dispatch({
            type: 'resumeLoadTick',
            loadedBytes: progress.loadedBytes,
            totalBytes: progress.totalBytes,
          });
        },
        // Real stages from the host, not invented ones: the block says what is
        // actually happening, and an unknown stage still shows rather than
        // being silently dropped.
        (stage) => {
          if (!alive()) return;
          dispatch({ type: 'resumeLoadTick', note: resumeStageLabel(stage) });
        },
      );
      stop();
      if (!alive()) return;
      if (!result) {
        // The host resolved without a session instead of rejecting. There is no
        // reason to show, so say exactly that rather than implying one was.
        dispatch({ type: 'resumeLoadAbort' });
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'error',
            text: `Failed to resume session ${sessionId} — the host returned no session and no reason.`,
          },
        });
        return;
      }

      const entries = result.entries;
      const total = entries.length;
      const size = resumeChunkSize(total);
      // An empty transcript still needs the terminating chunk: it is what
      // clears the loading block and applies the context snapshot.
      for (let index = 0; index < total || index === 0; index += size) {
        if (!alive()) return;
        const slice = entries.slice(index, index + size);
        const done = index + size >= total;
        dispatch({
          type: 'resumeStreamChunk',
          entries: slice,
          total,
          ...(done ? { done: true, contextSnapshot: result.contextSnapshot } : {}),
        });
        if (done) break;
        // The block is gone from the transcript now, so the batch counter goes
        // where it stays visible while the conversation scrolls past it.
        dispatch({
          type: 'hint',
          text: `Replaying "${label}" — ${Math.min(index + size, total)} / ${total} entries…`,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, RESUME_STREAM_FRAME_MS));
      }
      if (!alive()) return;

      // One more frame before touching the suggestion store: each replayed
      // assistant entry runs its own `<nextsteps>` parser on mount, so the
      // store is churning until the last batch has COMMITTED. Writing the
      // authoritative value first would just be overwritten by whichever entry
      // mounted last — which is not necessarily the final turn.
      await new Promise<void>((resolve) => setTimeout(resolve, RESUME_STREAM_FRAME_MS));
      if (!alive()) return;
      // Offered, not executed. `autoProceedHold` is still set, so nothing can
      // fire these; the user picks one with /next or types something else.
      // Setting `[]` matters as much as setting a list: it clears suggestions
      // left over from the session being left behind.
      setSuggestions?.(result.nextSteps ?? []);

      for (const line of result.warnings ?? []) {
        dispatch({ type: 'addEntry', entry: { kind: 'warn', text: `Resume: ${line}` } });
      }
      // `attached === false` means the transcript is on screen but the session
      // was never claimed for writing. Saying "Resumed" there would be a lie
      // the user only discovers when their next prompt lands elsewhere.
      dispatch(
        result.attached === false
          ? {
              type: 'addEntry',
              entry: {
                kind: 'warn',
                text:
                  `Showing ${result.sessionId} read-only — ${total} entries replayed. ` +
                  `The session was NOT attached, so anything you send continues the current session instead.`,
              },
            }
          : {
              type: 'addEntry',
              entry: {
                kind: 'info',
                text:
                  `Resumed session ${result.sessionId} — ${total} entries replayed. ` +
                  `Waiting for you; auto-proceed stays paused until you send something.`,
              },
            },
      );
      // The session ended on a next-steps block: show what it proposed and
      // stop there. Listing them is the whole difference between "it resumed
      // and then carried on by itself" and "it resumed and asked".
      const steps = result.nextSteps ?? [];
      if (steps.length > 0) {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: [
              `Next steps this session proposed — nothing runs until you choose:`,
              ...steps.map((step, index) => `  ${index + 1}. ${step}`),
              `  /next <n> to run one, or just type something else.`,
            ].join('\n'),
          },
        });
      }
    } catch (err) {
      stop();
      if (!alive()) return;
      dispatch({ type: 'resumeLoadAbort' });
      // The reason, in the chat, on a screen the user can scroll. This is the
      // whole point of closing the picker first.
      dispatch({
        type: 'addEntry',
        entry: {
          kind: 'error',
          text: `Failed to resume session ${sessionId}: ${toErrorMessage(err)}`,
        },
      });
    } finally {
      stop();
      hooks.onSettled?.();
      if (mountedRef.current) dispatch({ type: 'hint', text: '' });
    }
  };

  return usePickerKeys({
    state,
    dispatch,
    lastEnterAtRef,
    inputGateRef,
    switchProviderAndModel,
    setLiveProvider,
    setLiveModel,
    setActiveMaxContext,
    getAgentCtxMaxContext: () => agent.ctx.provider.capabilities.maxContext,
    activeMaxContext,
    currentContextTokens,
    currentProvider: liveProvider,
    currentModel: liveModel,
    switchAutonomy,
    submit: (text) => submitRef.current(text),
    onPromptPickerEnter: () => {
      const filtered = filterPromptPicker(
        state.promptPicker.all,
        state.promptPicker.categories,
        state.promptPicker.catIndex,
        state.promptPicker.recentSlugs,
      );
      const entry = filtered[state.promptPicker.selected];
      dispatch({ type: 'promptPickerClose' });
      if (entry) {
        dispatch({ type: 'setBuffer', buffer: entry.content, cursor: entry.content.length });
        void promptUsageRef.current?.record(entry.slug).catch(() => {});
      }
    },
    onPromptPickerFavorite: () => {
      const filtered = filterPromptPicker(
        state.promptPicker.all,
        state.promptPicker.categories,
        state.promptPicker.catIndex,
        state.promptPicker.recentSlugs,
      );
      const entry = filtered[state.promptPicker.selected];
      if (entry) void setPromptFavorite(entry.slug, !entry.favorite);
    },
    onPromptPickerEdit: () => {
      const filtered = filterPromptPicker(
        state.promptPicker.all,
        state.promptPicker.categories,
        state.promptPicker.catIndex,
        state.promptPicker.recentSlugs,
      );
      const entry = filtered[state.promptPicker.selected];
      if (!entry) return;
      dispatch({ type: 'promptPickerClose' });
      const command = `/prompts edit "${entry.title.replaceAll('"', '\\"')}" `;
      setDraft(command, command.length);
    },
    onResumePickerEnter: async () => {
      const session = state.resumePicker.sessions[state.resumePicker.selected];
      if (!session || session.isCurrent) return;
      if (state.resumePicker.busy) return;
      // Guard BEFORE anything else: `onResumeSession?.(id)` evaluates to
      // undefined when the host doesn't wire the prop, and awaiting the flow
      // would leave the picker stuck with no visible error.
      if (!onResumeSession) {
        dispatch({
          type: 'resumePickerError',
          text: 'Session resume is not available in this host.',
        });
        return;
      }
      if (resumeInFlightRef.current) return;
      resumeInFlightRef.current = true;
      const label = session.name?.trim() || session.title || session.id;
      // Enter is a COMMIT, so the panel goes away immediately and the work
      // reports into the chat. Keeping the picker open through a resume made
      // the whole thing invisible: the transcript load blocks this event loop
      // for seconds, the panel painted a frozen list over the chat, and a
      // failure printed inside a panel the user had already mentally closed.
      dispatch({ type: 'resumePickerClose' });
      await runResume(session.id, label, {
        onSettled: () => {
          resumeInFlightRef.current = false;
        },
      });
    },
    onSessionsPanelEnter: async () => {
      if (state.sessionResumeConfirm) {
        const pending = state.sessionResumeConfirm;
        dispatch({ type: 'sessionResumeConfirmClear' });
        // Same guard as onResumePickerEnter: an unwired prop must not strand
        // sessionsPanelBusy.
        if (!onResumeSession) {
          dispatch({
            type: 'addEntry',
            entry: { kind: 'warn', text: 'Session resume is not available in this host.' },
          });
          return;
        }
        // Sync in-flight lock: this branch reads the render-time confirm
        // snapshot, which stays stale until React re-renders — every Enter in
        // that window would re-run the resume. The ref rejects them all.
        if (sessionsResumeInFlightRef.current) return;
        sessionsResumeInFlightRef.current = true;
        // Close the panel before the wipe, for the same reason the picker does:
        // the loading block belongs on the chat screen, not underneath a panel
        // the user has already mentally dismissed.
        dispatch({ type: 'toggleSessionsPanel' });
        dispatch({ type: 'sessionsPanelBusy', on: false });
        await runResume(pending.sessionId, pending.sessionName || pending.sessionId, {
          onSettled: () => {
            sessionsResumeInFlightRef.current = false;
          },
        });
        return;
      }
      const sessions = state.sessionsPanel.sessions;
      const sel = state.sessionsPanel.selected;
      if (sel < 0 || sel >= sessions.length) return;
      const session = sessions[sel];
      if (!session) return;
      const isCurrentProject = session.projectRoot === projectRoot;
      if (isCurrentProject) {
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
        dispatch({
          type: 'sessionResumeConfirmSet',
          sessionId: session.sessionId,
          sessionName: session.projectName,
        });
      } else {
        onSwitchToSession?.(session.sessionId, session.projectRoot ?? '', session.projectName);
        dispatch({ type: 'toggleSessionsPanel' });
        requestExit?.(42);
      }
    },
    onProjectPickerEnter: async () => {
      const items = state.projectPicker.items;
      const selected = state.projectPicker.selected;
      if (selected < 0 || selected >= items.length) return;
      const item = items[selected];
      if (!item || item.key === '__divider__' || item.key === 'quit') {
        dispatch({ type: 'projectPickerClose' });
        return;
      }
      if (item.kind === 'project') {
        await onProjectSelect?.(item.key, item.kind);
        dispatch({ type: 'projectPickerClose' });
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: `Switched project: ${item.label.trim()}.` },
        });
        return;
      }
      dispatch({ type: 'projectPickerClose' });
      if (item.key === 'new-session') {
        await onProjectSelect?.(item.key, item.kind);
        dispatch({
          type: 'addEntry',
          entry: { kind: 'info', text: 'Started a fresh session in this project.' },
        });
      } else if (item.key === 'prev-sessions') {
        submitRef.current('/resume');
      }
    },
    onSlashPickerEnter: () => {
      const line = selectedSlashCommandLine(state.slashPicker);
      if (line) {
        submitRef.current(line);
      } else {
        acceptSlashPickerSelection();
      }
    },
    onSlashPickerTab: () => {
      if (state.slashPicker.matches.length > 0) {
        const sel = state.slashPicker.matches[state.slashPicker.selected];
        if (sel) {
          setDraft(`/${sel.name} `, sel.name.length + 2);
          dispatch({ type: 'slashPickerClose' });
        }
      }
    },
    onSettingsPickerEnter: () => {
      const sp = state.settingsPicker;
      if (sp.filter !== '') {
        dispatch({ type: 'settingsFilterSet', filter: '' });
        return;
      }
      if (sp.field === THINKING_WORD_FIELD) {
        dispatch({ type: 'settingsThinkingEditStart' });
      } else if (sp.field === WRONGPROXY_URL_FIELD) {
        // Field 60 (WrongProxy URL): Enter opens the inline text edit,
        // mirroring the thinking-word flow. The reducer quartet at
        // `reducers/settings-values.ts:733-801` handles Start/Change/Commit/
        // Cancel; the schema-validating Commit handler keeps the current
        // URL on invalid input and surfaces a hint.
        dispatch({ type: 'settingsWrongProxyUrlEditStart' });
      } else {
        dispatch({ type: 'settingsValueChange', delta: 1 });
      }
    },
    onPluginPickerToggle: toggleSelectedPlugin,
    onMcpPickerToggle: toggleSelectedMcpServer,
    onMcpPickerRestart: restartSelectedMcpServer,
    onToolsPickerToggle: toggleSelectedTool,
    onHelpPanelEnter: () => {
      const entry = state.helpPanel.entries[state.helpPanel.selected];
      if (!entry) return;
      dispatch({ type: 'helpClose' });
      submitRef.current(`/${entry.name}`);
    },
    onBrainRiskChange: changeBrainRisk,
    onBrainAdjust: brainCtl.handleBrainAdjust,
    onBrainEnter: brainCtl.handleBrainEnter,
    onBrainDelete: brainCtl.handleBrainDelete,
    onBrainVoterMod: brainCtl.handleBrainVoterMod,
    onModelPicked: handleModelPicked,
    onShadowStart: handleShadowStart,
    onShadowStop: handleShadowStop,
    onAuthEnter: authPanelController.onAuthEnter,
    onAuthBack: authPanelController.onAuthBack,
    onAuthShortcut: authPanelController.onAuthShortcut,
    onAuthPromptSubmit: authPanelController.onAuthPromptSubmit,
    onAuthPromptCancel: authPanelController.onAuthPromptCancel,
    onAuthConfirm: authPanelController.onAuthConfirm,
    onAuthFlowCancel: authPanelController.onAuthFlowCancel,
    onAuthCtrlC: authPanelController.onAuthCtrlC,
    onFKeyPickerEnter: () => {
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
    },
    onPickerEnter,
    onThemePickerEnter,
  });
}
