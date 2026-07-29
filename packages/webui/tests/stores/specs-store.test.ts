import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BoardTaskItem,
  type SpecDetail,
  type SpecListItem,
  useSpecsStore,
} from '../../src/stores/specs-store';

const store = () => useSpecsStore.getState();

function spec(overrides: Partial<SpecListItem> = {}): SpecListItem {
  return {
    id: 'spec-1',
    displayId: 'SPEC-001',
    title: 'Add rate limiting',
    status: 'in_progress',
    total: 4,
    completed: 1,
    ...overrides,
  };
}

function task(overrides: Partial<BoardTaskItem> = {}): BoardTaskItem {
  return {
    id: 't-1',
    shortId: 'T1',
    title: 'Wire the middleware',
    description: 'Add the limiter to the request pipeline',
    priority: 'high',
    type: 'feature',
    status: 'pending',
    displayStatus: 'pending',
    deps: [],
    ...overrides,
  };
}

function detail(overrides: Partial<SpecDetail> = {}): SpecDetail {
  return {
    specId: 'spec-1',
    graphId: 'g-1',
    title: 'Add rate limiting',
    overview: 'Protect the public API',
    status: 'in_progress',
    total: 4,
    completed: 1,
    running: 1,
    pending: 2,
    columns: [{ label: 'Pending', tasks: [task()] }],
    ...overrides,
  };
}

describe('specs store', () => {
  beforeEach(() => {
    useSpecsStore.setState({ specs: [], detail: null, expandedSpecId: null });
  });

  it('starts empty', () => {
    const s = store();
    expect(s.specs).toEqual([]);
    expect(s.detail).toBeNull();
    expect(s.expandedSpecId).toBeNull();
  });

  it('setSpecs replaces the list', () => {
    store().setSpecs([spec(), spec({ id: 'spec-2', displayId: 'SPEC-002' })]);
    expect(store().specs).toHaveLength(2);
    store().setSpecs([spec({ id: 'spec-3' })]);
    expect(store().specs.map((s) => s.id)).toEqual(['spec-3']);
  });

  it('setSpecs accepts an empty list', () => {
    store().setSpecs([spec()]);
    store().setSpecs([]);
    expect(store().specs).toEqual([]);
  });

  it('carries the optional graphId through', () => {
    store().setSpecs([spec({ graphId: 'g-9' })]);
    expect(store().specs[0]?.graphId).toBe('g-9');
  });

  it('setDetail stores the board detail', () => {
    store().setDetail(detail());
    expect(store().detail?.specId).toBe('spec-1');
    expect(store().detail?.columns[0]?.tasks[0]?.shortId).toBe('T1');
  });

  it('setDetail(null) clears the board', () => {
    store().setDetail(detail());
    store().setDetail(null);
    expect(store().detail).toBeNull();
  });

  it('preserves live run metadata on board tasks', () => {
    store().setDetail(
      detail({
        columns: [
          {
            label: 'Running',
            tasks: [
              task({
                status: 'in_progress',
                displayStatus: 'in_progress',
                agentName: 'worker-1',
                worktreeBranch: 'sdd/t-1',
                startedAt: 1_700_000_000_000,
                retries: 2,
                model: 'opus',
                provider: 'anthropic',
                fallbackModels: ['sonnet'],
              }),
            ],
          },
        ],
      }),
    );
    expect(store().detail?.columns[0]?.tasks[0]).toMatchObject({
      agentName: 'worker-1',
      worktreeBranch: 'sdd/t-1',
      retries: 2,
      model: 'opus',
      provider: 'anthropic',
      fallbackModels: ['sonnet'],
    });
  });

  it('preserves completion-gate verification fields', () => {
    store().setDetail(
      detail({
        columns: [
          {
            label: 'Review',
            tasks: [
              task({
                status: 'review',
                displayStatus: 'review',
                verificationCommand: 'pnpm test',
                verificationState: 'failed',
                verificationDetail: '2 tests failed',
              }),
            ],
          },
        ],
      }),
    );
    expect(store().detail?.columns[0]?.tasks[0]).toMatchObject({
      verificationCommand: 'pnpm test',
      verificationState: 'failed',
      verificationDetail: '2 tests failed',
    });
  });

  it('setExpanded records which spec is expanded', () => {
    store().setExpanded('spec-1');
    expect(store().expandedSpecId).toBe('spec-1');
  });

  it('setExpanded always drops the stale detail — the new spec must reload its board', () => {
    store().setDetail(detail());
    store().setExpanded('spec-2');
    expect(store().expandedSpecId).toBe('spec-2');
    expect(store().detail).toBeNull();
  });

  it('setExpanded(null) collapses and clears the detail', () => {
    store().setDetail(detail());
    store().setExpanded('spec-1');
    store().setExpanded(null);
    expect(store().expandedSpecId).toBeNull();
    expect(store().detail).toBeNull();
  });

  it('re-expanding the same spec still clears the detail', () => {
    store().setExpanded('spec-1');
    store().setDetail(detail());
    store().setExpanded('spec-1');
    expect(store().detail).toBeNull();
  });

  it('keeps the spec list independent of the expanded/detail state', () => {
    store().setSpecs([spec()]);
    store().setExpanded('spec-1');
    store().setDetail(detail());
    store().setExpanded(null);
    expect(store().specs).toHaveLength(1);
  });
});
