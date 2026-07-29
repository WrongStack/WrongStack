/**
 * Tests for chronicle/project-access.ts — resolveChronicleProjectServerOptions
 * and createChronicleProjectAccess inline mode.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
} from '../../src/chronicle/project-access.js';

describe('resolveChronicleProjectServerOptions', () => {
  it('resolves from explicit projectPaths', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      projectPaths: {
        globalRoot: '/global',
        projectId: 'proj-123',
        projectDir: '/global/projects/proj-123',
        workspaceId: 'my-project',
      },
    });
    expect(opts.projectRoot).toBe(path.resolve('/my/project'));
    expect(opts.globalRoot).toBe('/global');
    expect(opts.projectId).toBe('proj-123');
    expect(opts.workspaceId).toBe('my-project');
  });

  it('resolves from wstack paths when no projectPaths', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      userHome: '/home/testuser',
    });
    expect(opts.projectRoot).toBe(path.resolve('/my/project'));
    expect(opts.globalRoot).toBeDefined();
    expect(opts.projectId).toBeDefined();
    expect(opts.projectDir).toBeDefined();
    expect(opts.workspaceId).toBeDefined();
  });

  it('passes through retentionDays when set', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      projectPaths: {
        globalRoot: '/g',
        projectId: 'p',
        projectDir: '/g/p',
        workspaceId: 'w',
      },
      retentionDays: 30,
    });
    expect(opts.retentionDays).toBe(30);
  });

  it('omits retentionDays when not set', () => {
    const opts = resolveChronicleProjectServerOptions({
      projectRoot: '/my/project',
      projectPaths: {
        globalRoot: '/g',
        projectId: 'p',
        projectDir: '/g/p',
        workspaceId: 'w',
      },
    });
    expect(opts.retentionDays).toBeUndefined();
  });
});

describe('createChronicleProjectAccess — inline mode', () => {
  // Inline mode has to be asked for. Running from a tree with no built server
  // used to be enough to get it, which meant a broken build was indistinguish-
  // able from an intentional choice — and every process quietly kept its own
  // journal instead of sharing the project's daemon.
  beforeEach(() => {
    vi.stubEnv('WRONGSTACK_CHRONICLE_INLINE', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns inline access when inline mode is explicitly requested', () => {
    const access = createChronicleProjectAccess({
      projectRoot: '/tmp/test-project',
      userHome: '/tmp/test-home',
    });
    expect(access.mode).toBe('inline');
  });

  it('refuses to run inline when the server is merely missing', () => {
    vi.unstubAllEnvs();
    expect(() =>
      createChronicleProjectAccess({
        projectRoot: '/tmp/test-project',
        userHome: '/tmp/test-home',
      }),
    ).toThrow(/WRONGSTACK_CHRONICLE_INLINE/u);
  });

  it('ping returns health info', async () => {
    const access = createChronicleProjectAccess({
      projectRoot: '/tmp/test-project',
      userHome: '/tmp/test-home',
    });
    const health = await access.call('ping', {});
    expect(health).toBeDefined();
    expect(health.endpoint).toBe('inline');
    expect(health.pid).toBe(process.pid);
    expect(health.protocolVersion).toBeDefined();
    await access.close();
  });
});

describe('storage cut-over', () => {
  let root: string;

  beforeEach(async () => {
    vi.stubEnv('WRONGSTACK_CHRONICLE_INLINE', '1');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'chronicle-cutover-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  function accessFor() {
    return createChronicleProjectAccess({
      projectRoot: path.join(root, 'project'),
      projectPaths: {
        globalRoot: root,
        projectId: 'proj',
        projectDir: path.join(root, 'projectDir'),
        workspaceId: 'ws',
      },
    });
  }

  const event = {
    eventType: 'tool.started',
    scope: { installationId: 'i', machineId: 'm' },
    correlation: { traceId: 't', spanId: 's' },
  };

  it('writes appended events to SQLite and not to a JSONL partition', async () => {
    // "All tests pass" would also be true of a flag that never took effect, so
    // assert on where the bytes actually landed.
    const access = accessFor();
    await access.call('append', { inputs: [event] });
    await access.close();

    const chronicleDir = path.join(root, 'projectDir', 'chronicle');
    const files = await fs.readdir(chronicleDir);
    expect(files).toContain('chronicle.sqlite');
    expect(files.filter((name) => name.endsWith('.jsonl'))).toEqual([]);
  });

  it('reads back through the SQLite engine', async () => {
    const access = accessFor();
    await access.call('append', { inputs: [event] });
    const result = await access.call('query', { query: {} });
    await access.close();

    expect(result.total).toBe(1);
    expect(result.events[0]?.eventType).toBe('tool.started');
    // The SQLite engine reports a single source; the partition reader counted
    // files. This is how the two are told apart from the outside.
    expect(result.sourceFiles).toBe(1);
  });

  it('still writes partitions when the operator asks for the legacy store', async () => {
    vi.stubEnv('WRONGSTACK_CHRONICLE_STORE', 'jsonl');
    const access = accessFor();
    await access.call('append', { inputs: [event] });
    await access.close();

    const files = await fs.readdir(path.join(root, 'projectDir', 'chronicle'));
    expect(files.some((name) => name.endsWith('.events.jsonl'))).toBe(true);
    expect(files).not.toContain('chronicle.sqlite');
  });
});
