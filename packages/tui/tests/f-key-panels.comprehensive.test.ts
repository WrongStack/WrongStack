import { describe, expect, it } from 'vitest';
import {
  F_KEY_PANEL_ENTRIES,
  actionForFKeyPanel,
  fKeyEntryFor,
  type FKeyPanelAction,
  type FKeyPanelEntry,
} from '../src/f-key-panels.js';

const entry = (key: number): FKeyPanelEntry => {
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
});

describe('fKeyEntryFor', () => {
  it('returns the matching entry for a plain function key 1–12', () => {
    expect(fKeyEntryFor(1, false, '')?.key).toBe(1);
    expect(fKeyEntryFor(1, undefined, '')?.key).toBe(1);
    expect(fKeyEntryFor(12, false, '')?.key).toBe(12);
    expect(fKeyEntryFor(7, false, '')?.label).toBe('Queue panel');
  });

  it('returns null for fn outside 1–12 range', () => {
    expect(fKeyEntryFor(0, false, '')).toBeNull();
    expect(fKeyEntryFor(13, false, '')).toBeNull();
    expect(fKeyEntryFor(-1, false, '')).toBeNull();
  });

  it('returns null when fn is undefined and no ctrl match', () => {
    expect(fKeyEntryFor(undefined, false, '')).toBeNull();
    expect(fKeyEntryFor(undefined, undefined, '')).toBeNull();
  });

  it('matches Ctrl+letter via ctrlAlias', () => {
    // Ctrl+f → F2 (which has ctrlAlias: 'f')
    const match = fKeyEntryFor(undefined, true, 'f');
    expect(match).not.toBeNull();
    expect(match!.key).toBe(2);
  });

  it('returns null for ctrl alias that does not match any entry', () => {
    expect(fKeyEntryFor(undefined, true, 'z')).toBeNull();
  });

  it('returns null when ctrl is false even with a matching input', () => {
    expect(fKeyEntryFor(undefined, false, 'f')).toBeNull();
  });

  it('returns null when input is empty even with ctrl=true', () => {
    expect(fKeyEntryFor(undefined, true, '')).toBeNull();
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

  it('returns statuslineOpen action with hiddenItems when action is statuslineOpen', () => {
    // F-key registry does not currently have statuslineOpen, but the function handles it
    const statuslineEntry: FKeyPanelEntry = {
      key: 99,
      label: 'Statusline',
      action: 'statuslineOpen',
      helpKeys: 'Ctrl+S',
      helpDescription: 'statusline picker',
    };
    expect(actionForFKeyPanel(statuslineEntry, ['todos', 'cost'])).toEqual({
      type: 'statuslineOpen',
      hiddenItems: ['todos', 'cost'],
    });
  });

  it('returns toggleSessionsPanel for F10 since it is a payload-free toggle', () => {
    // F10's action is 'toggleSessionsPanel' which IS in PAYLOAD_FREE_ACTIONS
    // hostAction is a separate concern resolved by the caller
    expect(actionForFKeyPanel(entry(10))).toEqual({ type: 'toggleSessionsPanel' });
  });

  it('returns null for projectPickerOpen (F1) since host must load items first', () => {
    expect(actionForFKeyPanel(entry(1))).toBeNull();
  });
});
