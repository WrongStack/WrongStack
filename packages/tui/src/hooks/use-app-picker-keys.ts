import type { PromptUsageStore } from '@wrongstack/core/storage';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Dispatch, MutableRefObject } from 'react';
import type { AppProps } from '../app-props.js';
import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';
import type { useAuthPanel } from './use-auth-panel.js';
import type { useBrainPanel } from './use-brain-panel.js';
import type { ModelPickRequestController } from './use-model-pick.js';
import type { usePanelControllers } from './use-panel-controllers.js';
import { usePickerKeys } from './use-picker-keys.js';
import type { useStatusbarViewModel } from './use-statusbar-view-model.js';
import type { useTuiEnvironmentState } from './use-tui-environment-state.js';
import { filterPromptPicker } from '../components/prompt-picker.js';
import { F_KEY_ENTRIES } from '../components/f-key-picker.js';
import { THINKING_WORD_FIELD } from '../components/settings-picker.js';
import { actionForFKeyPanel } from '../f-key-panels.js';
import { selectedSlashCommandLine } from '../slash-command-search.js';
import type { StatuslineItem } from '../components/statusline-picker.js';

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
}: UseAppPickerKeysOptions) {
  const {
    agent,
    onProjectSelect,
    onResumeSession,
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
    onResumePickerEnter: async () => {
      const session = state.resumePicker.sessions[state.resumePicker.selected];
      if (!session || session.isCurrent) return;
      if (state.resumePicker.busy) return;
      dispatch({ type: 'resumePickerBusy', on: true });
      onResumeSession?.(session.id)
        .then((result) => {
          if (!result) {
            dispatch({
              type: 'resumePickerError',
              text: `Failed to resume session ${session.id}.`,
            });
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
        })
        .catch((err) => {
          dispatch({
            type: 'resumePickerError',
            text: toErrorMessage(err),
          });
        });
    },
    onSessionsPanelEnter: async () => {
      if (state.sessionResumeConfirm) {
        const pending = state.sessionResumeConfirm;
        dispatch({ type: 'sessionResumeConfirmClear' });
        dispatch({ type: 'sessionsPanelBusy', on: true });
        onResumeSession?.(pending.sessionId)
          .then((result) => {
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
          })
          .catch(() => {
            dispatch({ type: 'sessionsPanelBusy', on: false });
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
  });


}
