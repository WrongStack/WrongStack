import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { BrainPanelSettings } from '../src/components/brain-panel-model.js';
import { initial } from './reducer.test.js';

function brainSettings(riskLevel: BrainPanelSettings['riskLevel']): BrainPanelSettings {
  return {
    mode: 'interactive',
    riskLevel,
    strategy: 'fallback',
    pool: ['provider/model'],
    poolResolved: ['provider/model'],
    usingSessionModel: false,
    councilEnabled: false,
    councilMinRisk: 'medium',
    councilDistinctness: 'none',
    voters: [],
    councilSeats: [],
    ledgerEnabled: false,
    terminalPolicy: 'conservative',
    heuristics: {
      lowRiskAutoAnswer: true,
      blockedResolved: true,
      deadlockSkip: true,
      retryExhausted: true,
      continuePing: true,
    },
    llmMaxTokens: 200,
    llmRejectUncertain: true,
    llmMinConfidence: 0,
    llmDenyIsTerminal: 'never',
    cacheEnabled: false,
    cacheTtlMs: 300_000,
    cacheMaxEntries: 200,
    cacheHits: 0,
    cacheMisses: 0,
    cacheSize: 0,
    traceEnabled: false,
    traceContent: 'full',
    ruleCount: 0,
    ruleErrors: [],
  };
}

describe('reducer — final correct branches', () => {
  // ── Scroll (position lives in ScrollableHistory; reducer keeps flags) ──
  it('setHistoryScrolled stores the scrolled flag', () => {
    const r = reducer(initial(), { type: 'setHistoryScrolled', scrolled: true });
    expect(r.historyScrolled).toBe(true);
    expect(reducer(r, { type: 'setHistoryScrolled', scrolled: false }).historyScrolled).toBe(false);
  });
  it('setViewportRows stores the measured rows', () => {
    const s = initial({ viewportRows: 24 } as never);
    expect(reducer(s, { type: 'setViewportRows', rows: 30 }).viewportRows).toBe(30);
  });

  // ── Goal Kanban ──────────────────────────────────────────────────
  it('toggleGoalKanbanPanel flips', () => {
    expect(reducer(initial(), { type: 'toggleGoalKanbanPanel' }).goalKanbanPanelOpen).toBe(true);
  });

  // ── SDD Board monitor (needs sddBoard non-null) ──────────────────
  it('toggleSddBoardMonitor flips when sddBoard is set', () => {
    const s = initial({
      sddBoard: {
        snapshot: { columns: [], tasks: [], edges: [], phases: [], decisions: [] },
        monitorOpen: false,
      },
    } as never);
    expect(reducer(s, { type: 'toggleSddBoardMonitor' }).sddBoard?.monitorOpen).toBe(true);
  });

  // ── Model picker search (needs step === 'model') ─────────────────
  it('modelPickerSearch filters when step=model', () => {
    const s = initial({
      modelPicker: {
        open: true,
        step: 'model' as const,
        providerOptions: [],
        modelOptions: ['claude-3', 'gpt-4'],
        filteredOptions: ['claude-3', 'gpt-4'],
        selected: 0,
        searchQuery: '',
      },
    } as never);
    const r = reducer(s, { type: 'modelPickerSearch', query: 'claude' });
    expect(r.modelPicker.filteredOptions).toEqual(['claude-3']);
    expect(r.modelPicker.searchQuery).toBe('claude');
  });

  // ── ShadowUpdate patches shadow (key is 'shadow', not 'running') ─
  it('shadowUpdate patches shadow key', () => {
    const s = initial({
      shadowPanel: {
        open: true,
        running: false,
        model: '',
        intervalMs: 5000,
        activeId: null,
        hint: undefined,
      },
    } as never);
    const r = reducer(s, {
      type: 'shadowUpdate',
      shadow: { running: true, activeId: null, model: '', intervalMs: 30000 } as never,
    });
    expect(r.shadowPanel.shadow).toEqual({
      running: true,
      activeId: null,
      model: '',
      intervalMs: 30000,
    } as never);
  });
  it('shadowHint sets hint', () => {
    const s = initial({
      shadowPanel: {
        open: true,
        running: false,
        model: '',
        intervalMs: 5000,
        activeId: null,
        hint: undefined,
      },
    } as never);
    expect(reducer(s, { type: 'shadowHint', text: 'active' }).shadowPanel.hint).toBe('active');
  });

  // ── Auth panel flow (reducer sets flat fields, not sub-object) ───
  it('authFlowStart sets flat flow fields', () => {
    const s = initial({
      authPanel: {
        open: true,
        view: 'list' as const,
        providers: [],
        presets: [],
        catalog: [],
        selected: 0,
        filter: '',
        busy: false,
        hint: '',
      },
    } as never);
    const r = reducer(s, {
      type: 'authFlowStart',
      title: 'OAuth Login',
      providerId: 'openai',
      kind: 'oauth',
    } as never);
    expect(r.authPanel.view).toBe('flow');
    expect(r.authPanel.flowTitle).toBe('OAuth Login');
    expect(r.authPanel.log).toEqual([]);
    expect(r.authPanel.flowDone).toBe(false);
    expect(r.authPanel.busy).toBe(true);
  });
  it('authFlowLog appends log', () => {
    const s = initial({
      authPanel: {
        open: true,
        view: 'flow' as const,
        providers: [],
        presets: [],
        catalog: [],
        selected: 0,
        filter: '',
        busy: true,
        hint: '',
        log: [],
        flowTitle: 'Test',
        flowDone: false,
      },
    } as never);
    expect(reducer(s, { type: 'authFlowLog', line: 'starting' }).authPanel.log).toHaveLength(1);
  });
  it('authFlowDone sets results', () => {
    const s = initial({
      authPanel: {
        open: true,
        view: 'flow' as const,
        providers: [],
        presets: [],
        catalog: [],
        selected: 0,
        filter: '',
        busy: true,
        hint: '',
        log: [],
        flowTitle: 'Test',
        flowDone: false,
      },
    } as never);
    const r = reducer(s, { type: 'authFlowDone', ok: true, key: 'sk-...' } as never);
    expect(r.authPanel.flowDone).toBe(true);
    expect(r.authPanel.flowOk).toBe(true);
    expect(r.authPanel.busy).toBe(false);
  });
  it('authPromptStart/Change/End cycle uses input field', () => {
    let s = initial({
      authPanel: {
        open: true,
        view: 'flow' as const,
        providers: [],
        presets: [],
        catalog: [],
        selected: 0,
        filter: '',
        busy: true,
        hint: '',
        log: [],
        flowTitle: 'Test',
        flowDone: false,
      },
    } as never);
    s = reducer(s, { type: 'authPromptStart', label: 'Enter key:', masked: true });
    expect(s.authPanel.input?.label).toBe('Enter key:');
    expect(s.authPanel.input?.masked).toBe(true);
    s = reducer(s, { type: 'authPromptChange', draft: 'sk-' });
    expect(s.authPanel.input?.draft).toBe('sk-');
    s = reducer(s, { type: 'authPromptEnd' });
    expect(s.authPanel.input).toBeUndefined();
  });
  it('authConfirmStart/End cycle uses confirm field', () => {
    let s = initial({
      authPanel: {
        open: true,
        view: 'list' as const,
        providers: [],
        presets: [],
        catalog: [],
        selected: 0,
        filter: '',
        busy: false,
        hint: '',
      },
    } as never);
    const confirmAction = { kind: 'remove-provider' as const, providerId: 'openai' };
    s = reducer(s, { type: 'authConfirmStart', question: 'Press Enter', action: confirmAction });
    expect(s.authPanel.confirm?.question).toBe('Press Enter');
    expect(s.authPanel.confirm?.action).toEqual(confirmAction);
    s = reducer(s, { type: 'authConfirmEnd' });
    expect(s.authPanel.confirm).toBeUndefined();
  });

  // ── Brain settings (needs settings with voters/councilEnabled) ──
  it('brainSettingsLoaded works with council settings', () => {
    const settings = brainSettings('off');
    const s = initial({
      brainPanel: {
        open: true,
        log: [],
        settings: null,
        selected: 0,
        view: 'settings' as const,
        busy: false,
        hint: undefined,
      },
    } as never);
    const r = reducer(s, { type: 'brainSettingsLoaded', settings });
    expect(r.brainPanel.settings?.riskLevel).toBe('off');
  });
  it('brainRowMove moves selection', () => {
    const settings = brainSettings('medium');
    const s = initial({
      brainPanel: {
        open: true,
        log: [],
        settings,
        selected: 0,
        row: 0,
        view: 'settings' as const,
        busy: false,
        hint: undefined,
      },
    } as never);
    expect(reducer(s, { type: 'brainRowMove', delta: 1 }).brainPanel.row).toBe(1);
  });

  // ── Resume picker busy/error (reducer uses `on` not `busy`) ─────
  it('resumePickerBusy/Error work when open', () => {
    let s = reducer(initial(), {
      type: 'resumePickerOpen',
      sessions: [
        {
          id: 's1',
          startedAt: '2026-01-01T00:00:00Z',
          title: 'Test',
          tokenTotal: 0,
          toolCallCount: 0,
          iterationCount: 0,
          toolErrorCount: 0,
          outcome: 'completed',
          isCurrent: false,
        },
      ],
    });
    s = reducer(s, { type: 'resumePickerBusy', on: true });
    expect(s.resumePicker.busy).toBe(true);
    s = reducer(s, { type: 'resumePickerError', text: 'fail' });
    expect(s.resumePicker.error).toBe('fail');
  });

  // ── Goal run task active (needs taskId, not worker) ──────────────
  it('goalRunTaskActive adds/removes by taskId', () => {
    const s = initial({
      goalRun: {
        title: 'Build',
        phases: {
          p1: {
            id: 'p1',
            title: 'P1',
            status: 'running' as const,
            tasks: [{ id: 't1', title: 'Task 1' }],
            activeTasks: [],
          },
        },
        runningPhaseIds: ['p1'],
        elapsedMs: 0,
        monitorOpen: false,
      },
    } as never);
    const add = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      active: true,
    } as never);
    expect(add.goalRun?.phases.p1!.activeTasks).toHaveLength(1);
    const remove = reducer(add, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      active: false,
    } as never);
    expect(remove.goalRun?.phases.p1!.activeTasks).toHaveLength(0);
  });
});
