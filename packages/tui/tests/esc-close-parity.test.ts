import { describe, expect, it } from 'vitest';
import { ESC_CLOSE_PANELS } from '../src/esc-close-panels.js';
import { createInitialState } from '../src/app-initial-state.js';

/**
 * Architecture test: every panel reset by closePanels() must either be in
 * ESC_CLOSE_PANELS (so Esc closes it) or be documented as excluded (because
 * it owns its own Esc handler via child useInput). This prevents drift when
 * a new panel is added to closePanels but forgotten in the Esc table.
 */

function baseState() {
  return createInitialState({
    banner: false,
    restoredEntries: [],
    enhanceEnabled: true,
    model: 'gpt-4o',
    cwd: '/tmp',
  });
}

// Panels that closePanels() resets but are intentionally NOT in ESC_CLOSE_PANELS.
// Each owns its own Esc handler via a child useInput hook.
const DOCUMENTED_EXCLUSIONS = new Set([
  'worktreeMonitorOpen', // isWorktreeMonitorCloseKey in WorktreeMonitor.tsx
  'goalRun.monitorOpen', // Own useInput in PhaseMonitor.tsx
  'kanbanPanelOpen', // key.escape || 'q' → onClose in KanbanPanel.tsx
  'goalKanbanPanelOpen', // key.escape || 'q' → onClose in GoalKanbanPanel.tsx
]);

// Panels managed by usePickerKeys — they have their own dedicated key dispatch
// and don't need an entry in the Esc table (some are safety-net entries there).
const PICKER_MANAGED = new Set([
  'settingsPicker.open',
  'pluginPicker.open',
  'mcpPicker.open',
  'toolsPicker.open',
  'brainPanel.open',
  'helpPanel.open',
  'shadowPanel.open',
  'authPanel.open',
  'fKeyPicker.open',
  'statuslinePicker.open', // Esc handled by usePickerKeys (statuslineClose)
]);

// Simple toggle panels in closePanels — each must be in ESC_CLOSE_PANELS.
const TOGGLE_PANELS: Array<{ field: string; setState: (s: ReturnType<typeof baseState>) => void }> =
  [
    {
      field: 'monitorOpen',
      setState: (s) => {
        s.monitorOpen = true;
      },
    },
    {
      field: 'agentsMonitorOpen',
      setState: (s) => {
        s.agentsMonitorOpen = true;
      },
    },
    {
      field: 'helpOpen',
      setState: (s) => {
        s.helpOpen = true;
      },
    },
    {
      field: 'todosMonitorOpen',
      setState: (s) => {
        s.todosMonitorOpen = true;
      },
    },
    {
      field: 'queuePanelOpen',
      setState: (s) => {
        s.queuePanelOpen = true;
      },
    },
    {
      field: 'processListOpen',
      setState: (s) => {
        s.processListOpen = true;
      },
    },
    {
      field: 'cronMonitorOpen',
      setState: (s) => {
        s.cronMonitorOpen = true;
      },
    },
    {
      field: 'auditPanelOpen',
      setState: (s) => {
        s.auditPanelOpen = true;
      },
    },
    {
      field: 'planPanelOpen',
      setState: (s) => {
        s.planPanelOpen = true;
      },
    },
    {
      field: 'kanbanPanelOpen',
      setState: (s) => {
        s.kanbanPanelOpen = true;
      },
    },
    {
      field: 'goalPanelOpen',
      setState: (s) => {
        s.goalPanelOpen = true;
      },
    },
    {
      field: 'goalKanbanPanelOpen',
      setState: (s) => {
        s.goalKanbanPanelOpen = true;
      },
    },
    {
      field: 'contextPanelOpen',
      setState: (s) => {
        s.contextPanelOpen = true;
      },
    },
    {
      field: 'sessionsPanelOpen',
      setState: (s) => {
        s.sessionsPanelOpen = true;
      },
    },
    {
      field: 'worktreeMonitorOpen',
      setState: (s) => {
        s.worktreeMonitorOpen = true;
      },
    },
    {
      field: 'coordinator.monitorOpen',
      setState: (s) => {
        s.coordinator = { ...s.coordinator, monitorOpen: true };
      },
    },
    {
      field: 'goalRun.monitorOpen',
      setState: (s) => {
        if (s.goalRun) s.goalRun = { ...s.goalRun, monitorOpen: true };
      },
    },
    {
      field: 'sddBoard.monitorOpen',
      setState: (s) => {
        s.sddBoard = { monitorOpen: true } as never;
      },
    },
    {
      field: 'settingsPicker.open',
      setState: (s) => {
        s.settingsPicker = { ...s.settingsPicker, open: true };
      },
    },
    {
      field: 'statuslinePicker.open',
      setState: (s) => {
        s.statuslinePicker = { ...s.statuslinePicker, open: true };
      },
    },
    {
      field: 'projectPicker.open',
      setState: (s) => {
        s.projectPicker = { ...s.projectPicker, open: true };
      },
    },
  ];

describe('Esc-close / closePanels parity', () => {
  it('every toggle panel is in ESC_CLOSE_PANELS or is a documented exclusion', () => {
    for (const { field, setState } of TOGGLE_PANELS) {
      const state = baseState();
      setState(state);

      const matchedByEsc = ESC_CLOSE_PANELS.some((e) => e.isOpen(state));
      const isExcluded = DOCUMENTED_EXCLUSIONS.has(field);
      const isPickerManaged = PICKER_MANAGED.has(field);

      if (!matchedByEsc && !isExcluded && !isPickerManaged) {
        throw new Error(
          `Panel "${field}" is reset by closePanels() but is NOT in ESC_CLOSE_PANELS ` +
            `and is NOT documented as excluded or picker-managed. ` +
            `Add it to the table, or document the exclusion.`,
        );
      }
    }
  });

  it('documented exclusions are actually absent from ESC_CLOSE_PANELS', () => {
    for (const { field, setState } of TOGGLE_PANELS) {
      if (!DOCUMENTED_EXCLUSIONS.has(field)) continue;
      const state = baseState();
      setState(state);
      const matched = ESC_CLOSE_PANELS.some((e) => e.isOpen(state));
      expect(matched).toBe(false);
    }
  });
});
