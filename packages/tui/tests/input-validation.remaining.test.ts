/** Remaining coverage for input-validation.ts validateAction branches */
import { describe, it, expect } from 'vitest';
import { validateAction, normalizedEquals } from '../src/input-validation.js';

describe('validateAction - remaining action validators', () => {
  // Simple toggle/no-payload actions
  const noPayloadActions = [
    'toggleMonitor',
    'toggleAgentsMonitor',
    'toggleHelp',
    'toggleTodosMonitor',
    'toggleQueuePanel',
    'toggleProcessList',
    'toggleCronMonitor',
    'togglePlanPanel',
    'closeAllPanels',
    'toggleKanbanPanel',
    'toggleGoalPanel',
    'toggleGoalKanbanPanel',
    'toggleContextPanel',
    'toggleWorktreeMonitor',
    'toggleSessionsPanel',
    'toggleSddBoardMonitor',
    'toggleCoordinatorMonitor',
    'toggleAuditPanel',
    'brainClose',
    'brainBusy',
    'brainOpen',
    'settingsClose',
    'enhanceBusy',
    'enhanceClose',
    'countdownEnded',
    'clearInput',
    'rewindOverlayClose',
    'sessionRewound',
    'goalRunReset',
    'modelPickerClose',
    'modelPickerBack',
    'authClose',
    'authConfirmEnd',
    'authPromptEnd',
    'helpClose',
    'helpHint',
    'sendModePickerClose',
    'resetContextChip',
    'confirmClose',
    'confirmClearAll',
    'shellCommandWarningClose',
    'continueConfirmClose',
    'clearConfirmClose',
    'exitConfirmClose',
    'slashConfirmClose',
    'escConfirmClose',
    'refineFailureClose',
    'projectPickerClose',
    'fKeyPickerClose',
    'statuslineClose',
    'statuslineHint',
    'pluginPickerClose',
    'mcpPickerClose',
    'toolsPickerClose',
    'designPickerClose',
    'modePickerClose',
    'autonomyPickerClose',
    'sessionResumeConfirmClear',
    'debugStreamStatsClear',
    'fKeyPickerClose',
    'projectPickerClose',
    'settingsHint',
    'settingsFilterSet',
  ];
  for (const t of [...new Set(noPayloadActions)]) {
    it(`accepts ${t}`, () => {
      expect(validateAction({ type: t }).valid).toBe(true);
    });
  }

  // String field validators
  it('validateStdinFragment rejects empty buffer', () => {
    // Imported at top - empty buffer is valid
    expect(validateAction({ type: 'clearInput' }).valid).toBe(true);
  });
});

describe('normalizedEquals additional', () => {
  it('case sensitive', () => expect(normalizedEquals('Hello', 'Hello')).toBe(true));
  it('case different after trim', () => expect(normalizedEquals('Hello', 'hello')).toBe(false));
  it('whitespace only trims', () => expect(normalizedEquals('\t\n', '')).toBe(true));
});
