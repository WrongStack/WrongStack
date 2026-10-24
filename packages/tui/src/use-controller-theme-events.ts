import type { ThemePresetId } from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { useCallback } from 'react';
import type { AppProps } from './app-props.js';
import type { resolveControllerProps } from './controller-props.js';
import { useClientTelemetry } from './hooks/use-client-telemetry.js';
import { useProviderEventBridge } from './hooks/use-provider-event-bridge.js';
import { useTuiSlashCommands } from './hooks/use-tui-slash-commands.js';
import { setActiveTheme } from './theme.js';

interface UseControllerThemeEventsInput {
  dispatch: React.ActionDispatch<[action: import('./app-action-type.js').Action]>;
  controllerProps: ReturnType<typeof resolveControllerProps>;
  props: AppProps;
  openModelPicker: () => Promise<void>;
  openFKeyPicker: () => void;
  projectRoot: string;
  openSettings: () => void;
  state: import('./app-state.js').State;
  openStatuslinePicker: (field?: number | undefined) => void;
  setHiddenItems: (v: import('@wrongstack/core/statusline').StatuslineItem[]) => void;
  hiddenItemsRef: React.RefObject<import('@wrongstack/core/statusline').StatuslineItem[]>;
  setMailboxPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  openPromptPicker: () => Promise<void>;
  streamingTextRef: React.RefObject<string>;
  streamSegmentsRef: React.RefObject<{ kind: 'assistant' | 'thinking'; text: string }[]>;
  pendingDeltaRef: React.RefObject<string>;
  flushTimerRef: React.RefObject<NodeJS.Timeout | null>;
  sessionGenerationRef: React.RefObject<number>;
  activeRunGenerationRef: React.RefObject<number>;
  assistantCommittedThisRunRef: React.RefObject<boolean>;
  setMemoryContextMonitor: React.Dispatch<
    React.SetStateAction<import('./memory-context-monitor.js').MemoryContextMonitorState>
  >;
}

export function useControllerThemeEvents({
  dispatch,
  controllerProps,
  props,
  openModelPicker,
  openFKeyPicker,
  projectRoot,
  openSettings,
  state,
  openStatuslinePicker,
  setHiddenItems,
  hiddenItemsRef,
  setMailboxPanelOpen,
  openPromptPicker,
  streamingTextRef,
  streamSegmentsRef,
  pendingDeltaRef,
  flushTimerRef,
  sessionGenerationRef,
  activeRunGenerationRef,
  assistantCommittedThisRunRef,
  setMemoryContextMonitor,
}: UseControllerThemeEventsInput) {
  /**
   * Applies `/theme <preset>` immediately: swap the live palette, write the
   * choice to the ConfigStore, and persist it to disk. Extracted here so the
   * slash command does not need its own copy of the persist-and-report
   * sequence — the picker (`useThemePickerHandler`) has the same three steps
   * and both report persistence failure the same way.
   */
  const applyThemePreset = useCallback(
    (preset: ThemePresetId) => {
      setActiveTheme(preset);
      const warnPersist = (err: unknown) =>
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Theme applied in-memory but could not persist to disk: ${toErrorMessage(err)}`,
          },
        });
      try {
        controllerProps.configStore?.update({ themePreset: preset });
      } catch (err) {
        // A synchronous store failure is reported too — swallowing it left the
        // user believing a theme was saved when the write never happened.
        warnPersist(err);
        return;
      }
      // `saveThemePreset` is optional, so the promise has to be produced
      // inside the try: `void undefined.catch(...)` would throw a TypeError
      // whenever the host wired no persistence.
      try {
        void props.saveThemePreset?.(preset).catch(warnPersist);
      } catch (err) {
        warnPersist(err);
      }
    },
    [controllerProps.configStore, dispatch, props.saveThemePreset],
  );

  useTuiSlashCommands({
    slashRegistry: controllerProps.slashRegistry,
    skillLoader: props.skillLoader,
    getResourceMenu: props.getResourceMenu,
    getPickableProviders: controllerProps.getPickableProviders,
    switchProviderAndModel: controllerProps.switchProviderAndModel,
    openModelPicker,
    openFKeyPicker,
    projectRoot,
    agent: controllerProps.agent,
    dispatch,
    getSettings: controllerProps.getSettings,
    saveSettings: controllerProps.saveSettings,
    openSettings,
    state,
    openStatuslinePicker,
    setHiddenItems,
    hiddenItemsRef,
    setMailboxPanelOpen,
    switchAutonomy: controllerProps.switchAutonomy,
    listSessions: controllerProps.listSessions,
    openPromptPicker,
    configStore: controllerProps.configStore,
    applyThemePreset,
  });

  useProviderEventBridge({
    events: controllerProps.events,
    agent: controllerProps.agent,
    dispatch,
    streamingTextRef,
    streamSegmentsRef,
    pendingDeltaRef,
    flushTimerRef,
    sessionGenerationRef,
    activeRunGenerationRef,
    assistantCommittedThisRunRef,
    setMemoryContextMonitor,
  });

  useClientTelemetry({
    events: controllerProps.events,
    clientId: controllerProps.clientId,
    tokenCounter: controllerProps.tokenCounter,
    getAutonomy: controllerProps.getAutonomy,
    agent: controllerProps.agent,
    registerDebugStreamCallback: controllerProps.registerDebugStreamCallback,
    restoreDebugStreamCallback: controllerProps.restoreDebugStreamCallback,
    dispatch,
  });
}
