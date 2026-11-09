import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBoard,
  evaluateKanbanBoundaryOpaque,
  evaluateKanbanBoundaryPath,
  type KanbanBoundaryPolicy,
  mergeTasks,
  normalizeKanbanBoundaryPolicy,
  resolveKanbanBoundaryLayers,
  splitTask,
} from './helpers/session-manager.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const boardPolicy: KanbanBoundaryPolicy = {
  enabled: true,
  enforcement: 'confirm',
  shellAccess: 'confirm',
  allow: [
    { kind: 'package', path: 'packages/webui', access: 'read_write' },
    { kind: 'file', path: 'README.md', access: 'read' },
  ],
  deny: [{ kind: 'glob', path: 'packages/webui/**/*.secret', access: 'read_write' }],
};

describe('Kanban boundaries', () => {
  it('allows selected package paths and confirms outside paths', () => {
    const layers = resolveKanbanBoundaryLayers({ boundary: boardPolicy });
    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui/src/App.tsx', 'write')).toEqual({
      decision: 'allow',
      path: 'packages/webui/src/App.tsx',
    });
    expect(evaluateKanbanBoundaryPath(layers, 'packages/tui/src/app.tsx', 'write')).toMatchObject({
      decision: 'confirm',
      source: 'board',
    });
  });

  it('combines board and task layers without allowing the task to widen the board', () => {
    const taskPolicy: KanbanBoundaryPolicy = {
      enabled: true,
      enforcement: 'block',
      shellAccess: 'block',
      allow: [{ kind: 'directory', path: 'packages/webui/src/components', access: 'write' }],
    };
    const layers = resolveKanbanBoundaryLayers({ boundary: boardPolicy }, { boundary: taskPolicy });
    expect(
      evaluateKanbanBoundaryPath(layers, 'packages/webui/src/components/KanbanView.tsx', 'write'),
    ).toMatchObject({ decision: 'allow' });
    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui/src/App.tsx', 'write')).toMatchObject(
      {
        decision: 'block',
        source: 'task',
      },
    );
    expect(evaluateKanbanBoundaryPath(layers, 'packages/core/src/index.ts', 'write')).toMatchObject(
      {
        decision: 'block',
      },
    );
  });

  it('applies deny rules before allow rules and gates opaque tools', () => {
    const layers = resolveKanbanBoundaryLayers({ boundary: boardPolicy });
    expect(
      evaluateKanbanBoundaryPath(layers, 'packages/webui/src/token.secret', 'read'),
    ).toMatchObject({ decision: 'confirm', source: 'board' });
    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui/token.secret', 'read')).toMatchObject(
      { decision: 'confirm', source: 'board' },
    );
    expect(evaluateKanbanBoundaryOpaque(layers, 'bash')).toMatchObject({
      decision: 'confirm',
      source: 'board',
    });
  });

  describe('selector case folding', () => {
    const originalPlatform = process.platform;
    const setPlatform = (value: NodeJS.Platform) =>
      Object.defineProperty(process, 'platform', { value, configurable: true });
    afterEach(() => setPlatform(originalPlatform));

    const caseDeny = () =>
      resolveKanbanBoundaryLayers({
        boundary: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'allow',
          allow: [],
          deny: [
            { kind: 'directory', path: 'secrets', access: 'write' },
            { kind: 'file', path: 'config/App.json', access: 'write' },
            { kind: 'glob', path: '**/*.PEM', access: 'write' },
          ],
        },
      });

    it('matches selectors case-insensitively on Windows (ASCII fold)', () => {
      setPlatform('win32');
      // Tool paths arrive in on-disk casing (realpath); a `deny secrets`
      // selector missed the real `Secrets/` directory.
      const layers = caseDeny();
      for (const target of ['Secrets/key.pem', 'CONFIG/app.JSON', 'a/key.pem']) {
        expect(evaluateKanbanBoundaryPath(layers, target, 'write').decision, target).toBe('block');
      }
      expect(evaluateKanbanBoundaryPath(layers, 'SecretsX/key.txt', 'write').decision).toBe(
        'allow',
      );
      // ASCII only: a non-ASCII spelling is left to the filesystem.
      const unicode = resolveKanbanBoundaryLayers({
        boundary: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'allow',
          allow: [],
          deny: [{ kind: 'directory', path: 'Ünicode', access: 'write' }],
        },
      });
      expect(evaluateKanbanBoundaryPath(unicode, 'ünicode/a', 'write').decision).toBe('allow');
    });

    it('keeps selectors case-sensitive on a case-sensitive platform', () => {
      setPlatform('linux');
      const layers = caseDeny();
      expect(evaluateKanbanBoundaryPath(layers, 'secrets/key.pem', 'write').decision).toBe('block');
      for (const target of ['Secrets/key.txt', 'CONFIG/app.JSON']) {
        expect(evaluateKanbanBoundaryPath(layers, target, 'write').decision, target).toBe('allow');
      }
    });
  });

  it('matches a terminal globstar against both its root directory and descendants', () => {
    const layers = resolveKanbanBoundaryLayers({
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [{ kind: 'glob', path: 'packages/webui/**', access: 'read_write' }],
      },
    });

    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui', 'write').decision).toBe('allow');
    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui/src/App.tsx', 'write').decision).toBe(
      'allow',
    );
    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui-other', 'write').decision).toBe(
      'block',
    );

    const denyLayers = resolveKanbanBoundaryLayers({
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [],
        deny: [{ kind: 'glob', path: 'packages/webui/**', access: 'read_write' }],
      },
    });
    expect(evaluateKanbanBoundaryPath(denyLayers, 'packages/webui', 'write').decision).toBe(
      'block',
    );
  });

  it.each([
    ['secrets/**', 'secrets/line<break>break.txt'],
    ['**/key.pem', 'secrets/line<break>break/key.pem'],
    ['**', 'secrets/line<break>break.txt'],
  ])('matches globstar %s across filename line separators', (pattern, template) => {
    for (const separator of ['\n', '\r', '\u2028', '\u2029']) {
      const target = template.replace('<break>', separator);
      const selector = { kind: 'glob', path: pattern, access: 'read_write' } as const;
      const policy: KanbanBoundaryPolicy = {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [],
        deny: [selector],
      };
      const denied = resolveKanbanBoundaryLayers({ boundary: policy });
      const allowed = resolveKanbanBoundaryLayers({
        boundary: { ...policy, allow: [selector], deny: [] },
      });
      for (const access of ['read', 'write'] as const) {
        expect(evaluateKanbanBoundaryPath(denied, target, access).decision).toBe('block');
        expect(evaluateKanbanBoundaryPath(allowed, target, access).decision).toBe('allow');
      }
    }
  });

  it('rejects absolute and upward-traversal selectors', () => {
    expect(() =>
      normalizeKanbanBoundaryPolicy({
        ...boardPolicy,
        allow: [{ kind: 'directory', path: '../outside', access: 'write' }],
      }),
    ).toThrow(/stay inside the project/);
    expect(() =>
      normalizeKanbanBoundaryPolicy({
        ...boardPolicy,
        allow: [{ kind: 'file', path: 'C:\\outside.txt', access: 'write' }],
      }),
    ).toThrow(/stay inside the project/);
  });

  it('accepts `./` as the project root, like `.`', () => {
    const policy = normalizeKanbanBoundaryPolicy({
      ...boardPolicy,
      allow: [{ kind: 'directory', path: './', access: 'read' }],
      deny: [],
    });
    expect(policy.allow[0]?.path).toBe('.');
    const layers = resolveKanbanBoundaryLayers({ boundary: policy });
    expect(evaluateKanbanBoundaryPath(layers, 'src/a.ts', 'read').decision).toBe('allow');
  });

  it('rejects malformed policies received from untyped clients', () => {
    expect(() =>
      normalizeKanbanBoundaryPolicy({ ...boardPolicy, enabled: 'yes' } as never),
    ).toThrow(/enabled flag/);
    expect(() => normalizeKanbanBoundaryPolicy({ ...boardPolicy, allow: [null] } as never)).toThrow(
      /selectors must be objects/,
    );
  });

  it('returns confirm for shell tools when shellAccess is confirm', () => {
    const layers = resolveKanbanBoundaryLayers({ boundary: boardPolicy });
    const result = evaluateKanbanBoundaryOpaque(layers, 'bash');
    expect(result.decision).toBe('confirm');
    expect(result.source).toBe('board');
  });

  it('returns allow for shell tools when shellAccess is allow', () => {
    const layers = resolveKanbanBoundaryLayers({
      boundary: { ...boardPolicy, shellAccess: 'allow' },
    });
    const result = evaluateKanbanBoundaryOpaque(layers, 'bash');
    expect(result.decision).toBe('allow');
  });

  it('returns block for shell tools when shellAccess is block', () => {
    const layers = resolveKanbanBoundaryLayers({
      boundary: { ...boardPolicy, shellAccess: 'block' },
    });
    const result = evaluateKanbanBoundaryOpaque(layers, 'bash');
    expect(result.decision).toBe('block');
  });

  it('returns block when task policy blocks opaque tools', () => {
    const taskPolicy: KanbanBoundaryPolicy = {
      enabled: true,
      enforcement: 'block',
      shellAccess: 'block',
      allow: [],
    };
    const layers = resolveKanbanBoundaryLayers({ boundary: boardPolicy }, { boundary: taskPolicy });
    const result = evaluateKanbanBoundaryOpaque(layers, 'bash');
    expect(result.decision).toBe('block');
  });

  it('honors file access levels (read/write)', () => {
    const readPolicy: KanbanBoundaryPolicy = {
      enabled: true,
      enforcement: 'block',
      shellAccess: 'block',
      allow: [{ kind: 'file', path: 'README.md', access: 'read_write' }],
    };
    const layers = resolveKanbanBoundaryLayers({ boundary: readPolicy });
    // read_write permits both reads and writes
    expect(evaluateKanbanBoundaryPath(layers, 'README.md', 'read').decision).toBe('allow');
    expect(evaluateKanbanBoundaryPath(layers, 'README.md', 'write').decision).toBe('allow');
    // Unlisted path gets blocked by enforcement=block
    expect(evaluateKanbanBoundaryPath(layers, 'other.txt', 'read').decision).toBe('block');
  });

  it('falls back to board when task has no boundary policy', () => {
    const layers = resolveKanbanBoundaryLayers({ boundary: boardPolicy }, {});
    expect(evaluateKanbanBoundaryPath(layers, 'packages/webui/src/App.tsx', 'write').decision).toBe(
      'allow',
    );
    expect(evaluateKanbanBoundaryPath(layers, 'packages/core/src/index.ts', 'write').decision).toBe(
      'confirm',
    );
  });

  it('applies deny-first precedence over allow', () => {
    const policy: KanbanBoundaryPolicy = {
      enabled: true,
      enforcement: 'confirm',
      shellAccess: 'confirm',
      allow: [{ kind: 'file', path: 'secret.txt', access: 'read' }],
      deny: [{ kind: 'file', path: 'secret.txt', access: 'read' }],
    };
    const layers = resolveKanbanBoundaryLayers({ boundary: policy });
    // Deny should win over allow → confirm (enforcement=confirm)
    expect(evaluateKanbanBoundaryPath(layers, 'secret.txt', 'read').decision).toBe('confirm');
  });

  it('preserves ceilings when tasks split and locks incompatible merged scopes', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-manager-'));
    roots.push(projectRoot);
    const narrowPolicy: KanbanBoundaryPolicy = {
      ...boardPolicy,
      allow: [{ kind: 'directory', path: 'packages/webui', access: 'read_write' }],
    };
    const otherPolicy: KanbanBoundaryPolicy = {
      ...boardPolicy,
      allow: [{ kind: 'directory', path: 'packages/tui', access: 'read_write' }],
    };
    const board = await createBoard(projectRoot, {
      title: 'Boundary lifecycle',
      tasks: [
        { title: 'Parent', boundary: narrowPolicy },
        { title: 'Web', boundary: narrowPolicy },
        { title: 'TUI', boundary: otherPolicy },
      ],
    });

    const split = await splitTask(projectRoot, board.id, board.tasks[0]!.id, {
      titles: ['Child'],
    });
    expect(split?.children[0]?.boundary).toEqual(narrowPolicy);

    const merged = await mergeTasks(projectRoot, board.id, {
      taskIds: [board.tasks[1]!.id, board.tasks[2]!.id],
      title: 'Needs explicit boundary review',
    });
    expect(merged?.task.boundary).toMatchObject({
      enabled: true,
      enforcement: 'block',
      shellAccess: 'block',
      allow: [{ path: '.wrongstack/boundary-review-required' }],
    });
  });
});

describe('normalizeKanbanBoundaryPolicy inactive-rules warning', () => {
  const baseActive: KanbanBoundaryPolicy = {
    enabled: true,
    enforcement: 'block',
    shellAccess: 'block',
    allow: [{ kind: 'directory', path: 'src', access: 'write' }],
  };

  it('warns when selectors exist but enabled is false', () => {
    // The boundary editor lets operators configure allow/deny rules, but
    // resolveKanbanBoundaryLayers skips disabled layers — so without this
    // warning the editor would silently configure dead rules.
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    normalizeKanbanBoundaryPolicy({ ...baseActive, enabled: false });
    const calls = spy.mock.calls;
    spy.mockRestore();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const [msg, opts] = calls[0]!;
    expect(String(msg)).toContain('inert');
    expect((opts as { code?: string }).code).toBe('WRONGSTACK_KANBAN_BOUNDARY_RULES_INACTIVE');
  });

  it('does not warn when enabled is true', () => {
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    normalizeKanbanBoundaryPolicy(baseActive);
    const inactiveCalls = spy.mock.calls.filter(
      (c) => (c[1] as { code?: string })?.code === 'WRONGSTACK_KANBAN_BOUNDARY_RULES_INACTIVE',
    );
    spy.mockRestore();
    expect(inactiveCalls).toHaveLength(0);
  });

  it('does not warn when disabled but no selectors configured', () => {
    // An empty disabled boundary is the default state — no rules to be inert.
    const spy = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    normalizeKanbanBoundaryPolicy({
      enabled: false,
      enforcement: 'block',
      shellAccess: 'block',
      allow: [],
    });
    const inactiveCalls = spy.mock.calls.filter(
      (c) => (c[1] as { code?: string })?.code === 'WRONGSTACK_KANBAN_BOUNDARY_RULES_INACTIVE',
    );
    spy.mockRestore();
    expect(inactiveCalls).toHaveLength(0);
  });
});
