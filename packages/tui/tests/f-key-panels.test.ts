import { describe, expect, it } from 'vitest';
import {
  F_KEY_PANEL_ENTRIES,
  actionForFKeyPanel,
  type FKeyPanelAction,
} from '../src/f-key-panels.js';
import { helpSections } from '../src/components/help-overlay.js';

const entry = (key: number) => {
  const found = F_KEY_PANEL_ENTRIES.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Missing F${key} entry`);
  return found;
};

describe('F_KEY_PANEL_ENTRIES structural integrity', () => {
  it('defines 13 entries (F1–F12 + picker-only connections panel)', () => {
    expect(F_KEY_PANEL_ENTRIES.length).toBe(13);
  });

  it('has 12 sequential F-keys 1–12 plus a picker-only entry (key 0)', () => {
    const fKeys = F_KEY_PANEL_ENTRIES.filter((e) => e.key > 0).map((e) => e.key);
    expect(fKeys).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const pickerOnly = F_KEY_PANEL_ENTRIES.filter((e) => e.key === 0);
    expect(pickerOnly).toHaveLength(1);
  });

  it('every entry has a non-empty label, helpKeys, and helpDescription', () => {
    for (const entry of F_KEY_PANEL_ENTRIES) {
      expect(entry.label).toBeTruthy();
      expect(entry.helpKeys).toBeTruthy();
      expect(entry.helpDescription).toBeTruthy();
    }
  });

  it('every entry has a valid action', () => {
    const validActions: FKeyPanelAction[] = [
      'projectPickerOpen',
      'toggleMonitor',
      'toggleAgentsMonitor',
      'toggleWorktreeMonitor',
      'togglePlanPanel',
      'toggleTodosMonitor',
      'toggleQueuePanel',
      'toggleProcessList',
      'toggleKanbanPanel',
      'toggleGoalPanel',
      'toggleSessionsPanel',
      'toggleCoordinatorMonitor',
      'toggleConnectionsPanel',
      'statuslineOpen',
    ];
    for (const entry of F_KEY_PANEL_ENTRIES) {
      expect(validActions).toContain(entry.action);
    }
  });

  it('every entry appears in the HelpOverlay Monitors section', () => {
    const monitorKeys =
      helpSections()
        .find((s) => s.title === 'Monitors')
        ?.entries.map((e) => e.keys) ?? [];
    for (const entry of F_KEY_PANEL_ENTRIES) {
      expect(monitorKeys.some((k) => k.includes(entry.helpKeys))).toBe(true);
    }
  });
});

describe('actionForFKeyPanel', () => {
  it('returns null for F1 because project items must be loaded by the host first', () => {
    expect(actionForFKeyPanel(entry(1))).toBeNull();
  });

  it('returns payload-free reducer actions for ordinary panel toggles', () => {
    expect(actionForFKeyPanel(entry(5))).toEqual({ type: 'togglePlanPanel' });
    expect(actionForFKeyPanel(entry(11))).toEqual({ type: 'toggleCoordinatorMonitor' });
  });

  it('returns payload-free toggleKanbanPanel for F12 (no statusline items)', () => {
    expect(actionForFKeyPanel(entry(12), ['todos', 'cost'])).toEqual({
      type: 'toggleKanbanPanel',
    });
  });
});
