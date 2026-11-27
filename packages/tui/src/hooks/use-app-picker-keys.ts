import { insertSkillMention } from '@wrongstack/core/skill-mentions';
import { DefaultSessionRewinder, type PromptUsageStore } from '@wrongstack/core/storage';
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
import { resumeBlockedReason } from '../resume-load.js';
import { selectedSlashCommandLine } from '../slash-command-search.js';
import { createResumeRunner } from './app-resume-runner.js';
import { forkAtCheckpoint } from './fork-at-checkpoint.js';
import type { useAuthPanel } from './use-auth-panel.js';
import type { useBrainPanel } from './use-brain-panel.js';
import type { ModelPickRequestController } from './use-model-pick.js';
import type { usePanelControllers } from './use-panel-controllers.js';
import { usePickerKeys } from './use-picker-keys.js';
import type { useStatusbarViewModel } from './use-statusbar-view-model.js';
import type { useTuiEnvironmentState } from './use-tui-environment-state.js';

interface UseAppPickerKeysOptions {
  sessionGenerationRef?: MutableRefObject<number> | undefined;
  /** Move the input queue to a resumed session (see `useQueueManager`). */
  switchQueueSession?: ((sessionId: string) => void) | undefined;
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
  /** `/subagent-models` panel controller; absent when the host wires no plan. */
  subagentModelsController?:
    | import('./use-subagent-models-panel.js').SubagentModelsPanelController
    | undefined;
  statuslineHiddenForPicker: () => StatuslineItem[];
  onPickerEnter: () => Promise<void>;
  onThemePickerEnter?: () => void;
  onThemePickerUndo?: () => void;
  setPromptFavorite: (slug: string, favorite: boolean) => Promise<void>;
}

export function useAppPickerKeys({
  sessionGenerationRef,
  switchQueueSession,
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
  subagentModelsController,
  statuslineHiddenForPicker,
  onPickerEnter,
  onThemePickerEnter,
  onThemePickerUndo,
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
    loadLiveSessions,
    restartSelectedMcpServer,
    saveMcpEditor,
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
  const projectSwitchInFlightRef = useRef(false);
  // Same lock for the F10 sessions-panel confirm flow (see
  // onSessionsPanelEnter): that branch has no busy-state guard at all — a
  // stale `sessionResumeConfirm` snapshot re-runs onResumeSession on every
  // Enter until React re-renders, so the ref is the only double-fire guard.
  const sessionsResumeInFlightRef = resumeInFlightRef;
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

  const runResume = createResumeRunner({
    state,
    dispatch,
    sessionGenerationRef,
    resumeRunRef,
    mountedRef,
    onResumeSession,
    switchQueueSession,
    agent,
    setSuggestions,
  });

  // `f` in the checkpoint timeline (`checkpointFork`): branch the session at
  // that checkpoint and switch to the branch through the same resume flow.
  const forkRequest = state.forkRequest;
  useEffect(() => {
    if (!forkRequest) return;
    dispatch({ type: 'forkRequestDone' });
    const forkSession = host.forkSession;
    const sessionId = agent.ctx.session.id;
    if (!forkSession || !sessionId) return;
    // Checked before forking: the resume refuses during a run, and a fork
    // made first would be left behind unused.
    if (state.status && state.status !== 'idle') {
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Stop the active run before forking.' },
      });
      return;
    }
    if (resumeInFlightRef.current) return;
    resumeInFlightRef.current = true;
    const rewinder = new DefaultSessionRewinder(
      host.sessionsDir ?? '',
      agent.ctx.projectRoot ?? agent.ctx.cwd,
    );
    void forkAtCheckpoint(
      {
        forkSession,
        promptAt: (id, index) => rewinder.promptAt(id, index),
        resume: (id, label) => runResume(id, label),
        currentSessionId: () => agent.ctx.session.id,
        dispatch,
      },
      { sessionId, promptIndex: forkRequest.promptIndex, draft: state.buffer },
    ).finally(() => {
      resumeInFlightRef.current = false;
    });
  }, [forkRequest]);

  return usePickerKeys({
    onSkillMentionPick: (name) => {
      const mention = state.skillPicker.mention;
      if (!mention) return;
      const next = insertSkillMention(state.buffer, mention, name);
      setDraft(next.text, next.cursor);
    },
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
    // The picker's effort strip writes through the SAME saveSettings the
    // settings panel uses (field 24), so both surfaces land on
    // `modelRuntime.reasoning.effort` and the live ConfigStore in one step.
    // `getSettings()` supplies the untouched rest of the shape — the host
    // contract takes a full Settings object, not a patch.
    saveReasoningEffort: host.saveSettings
      ? (effort) => {
          const current = host.getSettings?.();
          if (!current) return 'Settings are not available in this host.';
          return host.saveSettings?.({ ...current, reasoningEffort: effort }) ?? null;
        }
      : undefined,
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
        const content = entry.variants?.[state.promptPicker.level ?? 'detailed'] ?? entry.content;
        dispatch({ type: 'setBuffer', buffer: content, cursor: content.length });
        // Usage stats only rank the picker; a failed write must not interrupt insertion.
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
      if (!session) return;
      if (state.resumePicker.busy) return;
      // Refused HERE, before `runResume` dispatches `resumeLoadStart`.
      //
      // The host reservation refuses a live session too, but only after the
      // screen has been wiped and a multi-hundred-MB journal read — and its
      // failure path used to render the other session's transcript read-only,
      // replacing the user's live screen with a stale copy of a conversation
      // that is still moving somewhere else. Neither is what "resume" should
      // do to a session someone is using.
      const blocked = resumeBlockedReason(session);
      if (blocked !== undefined) {
        // `isCurrent` stays silent: the row is already dimmed and labelled,
        // and Enter on it has always been a no-op rather than an error.
        if (!session.isCurrent) dispatch({ type: 'resumePickerError', text: blocked });
        return;
      }
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
      if (resumeInFlightRef.current || projectSwitchInFlightRef.current) return;
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
        if (sessionsResumeInFlightRef.current || projectSwitchInFlightRef.current) return;
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
      if (projectSwitchInFlightRef.current || resumeInFlightRef.current) return;
      const items = state.projectPicker.items;
      const selected = state.projectPicker.selected;
      if (selected < 0 || selected >= items.length) return;
      const item = items[selected];
      if (!item || item.key === '__divider__' || item.key === 'quit') {
        dispatch({ type: 'projectPickerClose' });
        return;
      }
      if (item.kind === 'project' || item.key === 'new-session') {
        if (!onProjectSelect) {
          dispatch({
            type: 'projectPickerHint',
            text: 'Project switching is unavailable in this host.',
          });
          return;
        }
        projectSwitchInFlightRef.current = true;
        dispatch({ type: 'projectPickerHint', text: 'Switching project…' });
        try {
          const error = await onProjectSelect(item.key, item.kind);
          if (!mountedRef.current) return;
          if (error) {
            dispatch({ type: 'projectPickerHint', text: `Project switch failed: ${error}` });
            return;
          }
          dispatch({ type: 'projectPickerClose' });
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'info',
              text:
                item.kind === 'project'
                  ? `Switched project: ${item.label.trim()}.`
                  : 'Started a fresh session in this project.',
            },
          });
        } catch (error) {
          if (mountedRef.current)
            dispatch({
              type: 'projectPickerHint',
              text: `Project switch failed: ${toErrorMessage(error)}`,
            });
        } finally {
          projectSwitchInFlightRef.current = false;
        }
        return;
      }
      dispatch({ type: 'projectPickerClose' });
      if (item.key === 'prev-sessions') {
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
    onMcpPickerSave: saveMcpEditor,
    onToolsPickerToggle: toggleSelectedTool,
    onHelpPanelEnter: () => {
      // Intentionally a no-op: help panel is purely informational
    },
    onBrainRiskChange: changeBrainRisk,
    onBrainAdjust: brainCtl.handleBrainAdjust,
    onBrainEnter: brainCtl.handleBrainEnter,
    onBrainDelete: brainCtl.handleBrainDelete,
    onBrainVoterMod: brainCtl.handleBrainVoterMod,
    onModelPicked: handleModelPicked,
    onShadowStart: handleShadowStart,
    onShadowStop: handleShadowStop,
    onSubagentLaneEdit: subagentModelsController?.onSubagentLaneEdit,
    onSubagentLaneClear: subagentModelsController?.onSubagentLaneClear,
    onSubagentPlanToggle: subagentModelsController?.onSubagentPlanToggle,
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
      // Mirror routeFKeyPanels: entries with host-side work must run it on the
      // picker path too, or the panel opens without loading its data (F10
      // previously showed stale/empty sessions until the 5s auto-refresh).
      if (entry.hostAction === 'openProjectPicker') {
        openProjectPicker();
        return;
      }
      if (entry.hostAction === 'loadLiveSessions') {
        dispatch({ type: 'toggleSessionsPanel' });
        if (!state.sessionsPanelOpen) loadLiveSessions();
        return;
      }
      const action = actionForFKeyPanel(entry, statuslineHiddenForPicker());
      if (action) dispatch(action);
    },
    onPickerEnter,
    onThemePickerEnter,
    onThemePickerUndo,
  });
}
