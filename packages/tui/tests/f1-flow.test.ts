/**
 * F1 project picker flow tests — reducer integration.
 *
 * Verifies the full flow: open → filter → navigate → select → close.
 * Pure reducer tests, no DOM/Ink rendering.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { ProjectPickerItem } from '../src/components/project-picker.js';
import type { State } from '../src/app-state.js';

// ── Helpers ────────────────────────────────────────────────────────────

function initialState(over: Partial<State> = {}): State {
  return {
    entries: [],
    buffer: '',
    cursor: 0,
    streamingText: '',
    toolStream: null,
    status: 'idle',
    interrupts: 0,
    steeringPending: false,
    steerSnapshot: null,
    hint: '',
    brain: { state: 'idle' },
    brainPrompt: null,
    nextId: 1,
    picker: { open: false, query: '', matches: [], selected: 0 },
    slashPicker: { open: false, query: '', matches: [], selected: 0 },
    runningTools: new Map(),
    queue: [],
    nextQueueId: 1,
    inputHistory: [],
    historyIndex: 0,
    modelPicker: {
      open: false,
      step: 'provider',
      providerOptions: [],
      modelOptions: [],
      filteredOptions: [],
      selected: 0,
      searchQuery: '',
    },
    autonomyPicker: { open: false, options: [], selected: 0 },
    resumePicker: {
      open: false,
      sessions: [],
      selected: 0,
      busy: false,
      hint: undefined,
      error: undefined,
    },
    settingsPicker: {
      open: false,
      field: 0,
      mode: 'off',
      delayMs: 0,
      titleAnimation: true,
      yolo: false,
      fleetChat: 'off',
      chime: false,
      confirmExit: true,
      nextPrediction: false,
      featureMcp: true,
      featurePlugins: true,
      featureMemory: true,
      featureSkills: true,
      featureModelsRegistry: true,
      contextAutoCompact: true,
      contextStrategy: 'hybrid',
      logLevel: 'info',
      auditLevel: 'standard',
      indexOnStart: true,
      maxIterations: 500,
      autoProceedMaxIterations: 50,
      enhanceDelayMs: 60_000,
      enhanceEnabled: true,
      enhanceLanguage: 'original',
      debugStream: false,
      statuslineMode: 'detailed',
      configScope: 'global',
    },
    projectPicker: {
      open: false,
      allItems: [],
      items: [],
      selected: 0,
      filter: '',
      hint: undefined,
    },
    confirmQueue: [],
    enhance: null,
    enhanceEnabled: true,
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
    fleetChat: 'off',
    monitorOpen: false,
    agentsMonitorOpen: false,
    helpOpen: false,
    todosMonitorOpen: false,
    queuePanelOpen: false,
    processListOpen: false,
    goalPanelOpen: false,
    sessionsPanelOpen: false,
    sessionsPanel: { sessions: [], busy: false, selected: -1 },
    sessionResumeConfirm: null,
    collabSession: null,
    checkpoints: [],
    rewindOverlay: null,
    eternalStage: null,
    goalSummary: null,
    goalRun: null,
    worktrees: {},
    worktreeMonitorOpen: false,
    viewportRows: 0,
    historyScrolled: false,
    debugStreamStats: null,
    ...over,
  } as unknown as State;
}

function projectItem(key: string, over: Partial<ProjectPickerItem> = {}): ProjectPickerItem {
  return { key, label: over.label ?? key, kind: 'project', ...over };
}

function actionItem(key: string, label: string): ProjectPickerItem {
  return { key, label, kind: 'action' };
}

function divider(): ProjectPickerItem {
  return { key: '__divider__', label: '───', kind: 'action' };
}

// ── Tests ──────────────────────────────────────────────────────────────

const mockItems: ProjectPickerItem[] = [
  projectItem('proj-0', { label: '● Project Alpha', subtitle: '/home/alpha' }),
  projectItem('proj-1', { label: '  Project Beta', subtitle: '/home/beta' }),
  projectItem('proj-2', { label: '  Project Gamma', subtitle: '/home/gamma' }),
  divider(),
  actionItem('new-session', '+ Start new session'),
  actionItem('prev-sessions', '⏱ Previous sessions'),
  actionItem('quit', 'q Quit'),
];

describe('F1 reducer flow (open → filter → navigate → select)', () => {
  it('opens with correct initial state', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });

    expect(state.projectPicker.open).toBe(true);
    expect(state.projectPicker.allItems).toEqual(mockItems);
    expect(state.projectPicker.items).toEqual(mockItems);
    expect(state.projectPicker.filter).toBe('');
    expect(state.projectPicker.selected).toBe(0);
    expect(state.projectPicker.hint).toBeUndefined();
  });

  it('filters by label substring', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });
    state = reducer(state, { type: 'projectPickerFilter', filter: 'beta' });

    expect(state.projectPicker.filter).toBe('beta');
    expect(state.projectPicker.allItems).toEqual(mockItems);
    const filtered = state.projectPicker.items.filter((i) => i.kind === 'project');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.key).toBe('proj-1');
    const actions = state.projectPicker.items.filter((i) => i.kind === 'action');
    expect(actions.length).toBe(4);
  });

  it('filters by subtitle', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });
    state = reducer(state, { type: 'projectPickerFilter', filter: 'gamma' });

    const filtered = state.projectPicker.items.filter((i) => i.kind === 'project');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.key).toBe('proj-2');
  });

  it('navigates with arrow keys, skipping dividers', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });

    expect(state.projectPicker.selected).toBe(0);
    state = reducer(state, { type: 'projectPickerMove', delta: 1 });
    expect(state.projectPicker.selected).toBe(1);
    state = reducer(state, { type: 'projectPickerMove', delta: 1 });
    expect(state.projectPicker.selected).toBe(2);
    state = reducer(state, { type: 'projectPickerMove', delta: 1 });
    expect(state.projectPicker.selected).toBe(4); // skipped divider at 3

    state = reducer(state, { type: 'projectPickerMove', delta: -1 });
    expect(state.projectPicker.selected).toBe(2);
  });

  it('wraps around at boundaries', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });

    state = reducer(state, { type: 'projectPickerMove', delta: -1 });
    expect(state.projectPicker.selected).toBe(6); // quit

    state = reducer(state, { type: 'projectPickerMove', delta: 1 });
    expect(state.projectPicker.selected).toBe(0);
  });

  it('filter resets selection to first selectable', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });
    state = reducer(state, { type: 'projectPickerMove', delta: 1 });
    state = reducer(state, { type: 'projectPickerMove', delta: 1 });
    expect(state.projectPicker.selected).toBe(2);

    state = reducer(state, { type: 'projectPickerFilter', filter: 'alpha' });
    expect(state.projectPicker.selected).toBe(0);
  });

  it('full flow: opens → filters → navigates → closes', () => {
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items: mockItems });
    expect(state.projectPicker.open).toBe(true);

    state = reducer(state, { type: 'projectPickerFilter', filter: 'beta' });
    expect(state.projectPicker.filter).toBe('beta');

    state = reducer(state, { type: 'projectPickerClose' });
    expect(state.projectPicker.open).toBe(false);
    expect(state.projectPicker.allItems).toEqual([]);
    expect(state.projectPicker.filter).toBe('');
  });
});

describe('F1 scroll with 50 projects', () => {
  function makeItems(count: number): ProjectPickerItem[] {
    const projects = Array.from({ length: count }, (_, i) =>
      projectItem(`proj-${i}`, {
        label: `  Project ${String(i).padStart(2, '0')}`,
        subtitle: `/home/user/projects/project-${String(i).padStart(2, '0')}`,
      }),
    );
    return [...projects, divider(), actionItem('quit', 'q Quit')];
  }

  it('navigation wraps correctly through 50 items', () => {
    const items = makeItems(50);
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items });

    for (let i = 0; i < 52; i++) {
      state = reducer(state, { type: 'projectPickerMove', delta: 1 });
      const sel = state.projectPicker.items[state.projectPicker.selected];
      expect(sel?.key).not.toBe('__divider__');
    }
  });

  it('filter quickly finds a project by name', () => {
    const items = makeItems(50);
    let state = initialState();
    state = reducer(state, { type: 'projectPickerOpen', items });
    state = reducer(state, { type: 'projectPickerFilter', filter: '25' });

    const filtered = state.projectPicker.items.filter((i) => i.kind === 'project');
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.label).toContain('25');
  });
});

describe('F1 project switch behavior', () => {
  it('does not use requestExit(42) for project selections', () => {
    const pickerControllerPath = fileURLToPath(
      new URL('../src/hooks/use-app-picker-keys.ts', import.meta.url),
    );
    const source = readFileSync(pickerControllerPath, 'utf8');
    const projectSelectionBlock = source.slice(
      source.indexOf("if (item.kind === 'project')"),
      source.indexOf("if (item.key === 'new-session')"),
    );

    expect(projectSelectionBlock).toContain('onProjectSelect?.(item.key, item.kind)');
    expect(projectSelectionBlock).not.toContain('requestExit?.(42)');
  });
});
