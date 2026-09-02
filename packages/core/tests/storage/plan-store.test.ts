import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSessionError } from '../../src/types/errors.js';
import {
  addPlanItem,
  clearPlan,
  deriveTodosFromPlanItem,
  emptyPlan,
  formatPlan,
  loadPlan,
  mutatePlan,
  removePlanItem,
  savePlan,
  setPlanItemStatus,
} from '../../src/storage/plan-store.js';

describe('plan-store', () => {
  it('round-trips a plan through save/load', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-'));
    const file = path.join(dir, 'sess.plan.json');
    try {
      let plan = emptyPlan('sess', 'Migration roadmap');
      ({ plan } = addPlanItem(plan, 'Audit database schema'));
      ({ plan } = addPlanItem(plan, 'Write migration scripts', 'idempotent + reversible'));
      await savePlan(file, plan);

      const loaded = await loadPlan(file);
      expect(loaded?.title).toBe('Migration roadmap');
      expect(loaded?.items).toHaveLength(2);
      expect(loaded?.items[0]?.title).toBe('Audit database schema');
      expect(loaded?.items[1]?.details).toBe('idempotent + reversible');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('mutatePlan rejects omission of unfinished plan coverage', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-'));
    const file = path.join(dir, 'coverage.plan.json');
    try {
      let plan = emptyPlan('sess');
      ({ plan } = addPlanItem(plan, 'Still open'));
      await savePlan(file, plan);

      await expect(
        mutatePlan(file, 'sess', (current) => ({ ...current, items: [] })),
      ).rejects.toThrow('unfinished items cannot be omitted');
      expect((await loadPlan(file))?.items.map((item) => item.title)).toEqual(['Still open']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('updates and removes by index', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'one'));
    ({ plan } = addPlanItem(plan, 'two'));
    plan = setPlanItemStatus(plan, '2', 'done');
    expect(plan.items[1]?.status).toBe('done');
    plan = removePlanItem(plan, '1');
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.title).toBe('two');
  });

  it('formatPlan renders status marks', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'alpha'));
    ({ plan } = addPlanItem(plan, 'beta'));
    plan = setPlanItemStatus(plan, '2', 'in_progress');
    const out = formatPlan(plan);
    expect(out).toContain('[ ] alpha');
    expect(out).toContain('[~] beta');
  });

  it('clearPlan empties items', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'x'));
    plan = clearPlan(plan);
    expect(plan.items).toEqual([]);
  });

  it('loadPlan returns null on missing file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-'));
    try {
      expect(await loadPlan(path.join(dir, 'no.json'))).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('deriveTodosFromPlanItem creates todos from plan item', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Refactor auth', 'Extract JWT logic'));
    ({ plan } = addPlanItem(plan, 'Add OAuth2'));

    const derived = deriveTodosFromPlanItem(plan, '1');
    expect(derived).not.toBeNull();
    expect(derived!.todos).toHaveLength(1);
    expect(derived!.todos[0]!.content).toBe('Refactor auth');
    expect(derived!.todos[0]!.status).toBe('in_progress');
    expect(derived!.todos[0]!.activeForm).toBe('Refactor auth');
    // Plan item should be marked in_progress
    expect(derived!.plan.items[0]!.status).toBe('in_progress');
  });

  it('deriveTodosFromPlanItem with subtasks creates multiple todos', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Build feature'));

    const derived = deriveTodosFromPlanItem(plan, '1', ['Write tests', 'Implement', 'Deploy']);
    expect(derived).not.toBeNull();
    expect(derived!.todos).toHaveLength(4); // 1 parent + 3 subtasks
    expect(derived!.todos[0]!.content).toBe('Build feature');
    expect(derived!.todos[1]!.content).toBe('Write tests');
    expect(derived!.todos[2]!.content).toBe('Implement');
    expect(derived!.todos[3]!.content).toBe('Deploy');
  });

  it('deriveTodosFromPlanItem returns null for invalid target', () => {
    const plan = emptyPlan('s');
    const derived = deriveTodosFromPlanItem(plan, '999');
    expect(derived).toBeNull();
  });

  it('deriveTodosFromPlanItem does not change done items', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Done item'));
    plan = setPlanItemStatus(plan, '1', 'done');

    const derived = deriveTodosFromPlanItem(plan, '1');
    expect(derived).not.toBeNull();
    expect(derived!.plan.items[0]!.status).toBe('done'); // stays done
    expect(derived!.todos[0]!.status).toBe('in_progress'); // but todo is in_progress
  });

  it('loadPlan returns null when version !== 1', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-'));
    const file = path.join(dir, 'v2.json');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 2, sessionId: 's', items: [] }));
      expect(await loadPlan(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadPlan returns null when items is not an array', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-'));
    const file = path.join(dir, 'no-array.json');
    try {
      await fs.writeFile(file, JSON.stringify({ version: 1, sessionId: 's', items: 'not array' }));
      expect(await loadPlan(file)).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('removePlanItem matches by title (case-insensitive partial)', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Fix bug in auth module'));
    ({ plan } = addPlanItem(plan, 'Write unit tests'));
    ({ plan } = addPlanItem(plan, 'Update docs'));
    // "bug in auth" should match the first item (case-insensitive, partial)
    plan = removePlanItem(plan, 'BUG IN');
    expect(plan.items).toHaveLength(2);
    expect(plan.items[0]!.title).toBe('Write unit tests');
    expect(plan.items[1]!.title).toBe('Update docs');
  });

  it('setPlanItemStatus matches by title', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Refactor DB layer'));
    ({ plan } = addPlanItem(plan, 'Add logging'));
    // Match "db layer" (case-insensitive, partial) → index 0
    plan = setPlanItemStatus(plan, 'DB LAYER', 'done');
    expect(plan.items[0]!.status).toBe('done');
    expect(plan.items[1]!.status).toBe('open');
  });

  it('deriveTodosFromPlanItem with subtasks appends multiple todos', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Deploy v2'));
    const derived = deriveTodosFromPlanItem(plan, '1', ['Build', 'Test', 'Ship']);
    expect(derived).not.toBeNull();
    // 1 from plan item + 3 subtasks = 4 todos
    expect(derived!.todos).toHaveLength(4);
    expect(derived!.todos[0]!.content).toBe('Deploy v2');
    expect(derived!.todos[1]!.content).toBe('Build');
    expect(derived!.todos[2]!.content).toBe('Test');
    expect(derived!.todos[3]!.content).toBe('Ship');
  });

  it('deriveTodosFromPlanItem does not change status when item is already done', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Old completed task'));
    plan = setPlanItemStatus(plan, '1', 'done');
    const before = plan.items[0]!.status;
    const derived = deriveTodosFromPlanItem(plan, '1');
    expect(derived).not.toBeNull();
    expect(derived!.plan.items[0]!.status).toBe(before); // still done
  });

  it('deriveTodosFromPlanItem matches by title (case-insensitive)', () => {
    let plan = emptyPlan('s');
    ({ plan } = addPlanItem(plan, 'Migrate to PostgreSQL'));
    const derived = deriveTodosFromPlanItem(plan, 'POSTGRESQL');
    expect(derived).not.toBeNull();
    expect(derived!.todos[0]!.content).toBe('Migrate to PostgreSQL');
  });

  it('attachPlanCheckpoint returns a noop function', async () => {
    const { attachPlanCheckpoint } = await import('../../src/storage/plan-store.js');
    // attachPlanCheckpoint takes a ConversationState, filePath, sessionId but just returns noop
    const noop = attachPlanCheckpoint(
      {} as import('../../src/core/conversation-state.js').ConversationState,
      '/tmp/plan.json',
      'session-1',
    );
    expect(typeof noop).toBe('function');
    expect(noop()).toBeUndefined();
  });

  it('mutatePlan throws a structured SessionError when persistence fails', async () => {
    // Force savePlan to fail by creating a directory at the target path —
    // atomicWrite then can't open a file at that name, savePlan returns
    // false, and mutatePlan must throw the structured SessionError rather
    // than a bare Error. Same trick used in plan-store-extra.test.ts.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-plan-bad-'));
    const fileAsDir = path.join(dir, 'plan.json');
    await fs.mkdir(fileAsDir, { recursive: true });
    try {
      let caught: unknown;
      try {
        await mutatePlan(fileAsDir, 'session-x', (p) => {
          p.title = 'should not save';
          return p;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeDefined();
      expect(isSessionError(caught)).toBe(true);
      const se = caught as ReturnType<typeof isSessionError> & {
        code: string;
        context?: Record<string, unknown>;
        sessionId?: string;
      };
      expect(se.code).toBe('SESSION_WRITE_FAILED');
      expect(se.context?.operation).toBe('mutatePlan');
      expect(se.sessionId).toBe('session-x');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
