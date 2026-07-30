import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditCmd } from '../src/subcommands/handlers/audit.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  verify: vi.fn(),
  sessionsDir: '',
}));

vi.mock('@wrongstack/core/storage', () => ({
  ToolAuditLog: vi.fn(function ToolAuditLog() {
    return { load: mocks.load, verify: mocks.verify };
  }),
}));
vi.mock('@wrongstack/core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/core/utils')>();
  return {
    ...actual,
    resolveWstackPaths: () => ({ projectSessions: mocks.sessionsDir }),
  };
});

const roots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deps() {
  return {
    projectRoot: 'D:/repo',
    userHome: 'D:/home',
    renderer: { write: vi.fn(), writeError: vi.fn() },
  };
}

function entry(index: number, isError = false) {
  return {
    index,
    ts: '2026-07-30T12:34:56.000Z',
    toolName: `tool-${index}`,
    isError,
    hash: `${index}`.repeat(64),
  };
}

describe('audit subcommand', () => {
  it('prints usage when no session id is supplied', async () => {
    const render = deps();
    await expect(auditCmd([], render as never)).resolves.toBe(1);
    expect(render.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Usage: wstack audit'),
    );
  });

  it('reports an empty audit log without failing', async () => {
    mocks.load.mockResolvedValueOnce([]);
    const render = deps();
    await expect(auditCmd(['session'], render as never)).resolves.toBe(0);
    expect(render.renderer.write).toHaveBeenCalledWith(expect.stringContaining('No audit entries'));
  });

  it('renders verified and broken logs with a bounded entry list', async () => {
    const entries = Array.from({ length: 14 }, (_, index) => entry(index, index === 1));
    mocks.load.mockResolvedValue(entries);
    mocks.verify.mockResolvedValueOnce({ ok: true });
    const verified = deps();
    await expect(auditCmd(['good'], verified as never)).resolves.toBe(0);
    expect(verified.renderer.write.mock.calls.flat().join(' ')).toContain('Verified');
    expect(verified.renderer.write.mock.calls.flat().join(' ')).toContain('and 2 more');

    mocks.verify.mockResolvedValueOnce({ ok: false, brokenAt: 2, reason: 'hash mismatch' });
    const broken = deps();
    await expect(auditCmd(['bad'], broken as never)).resolves.toBe(1);
    expect(broken.renderer.write.mock.calls.flat().join(' ')).toContain('BROKEN');
    expect(broken.renderer.write.mock.calls.flat().join(' ')).toContain('hash mismatch');
  });

  it('lists root and date-sharded audit logs while ignoring hidden and unrelated files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'audit-command-'));
    roots.push(root);
    mocks.sessionsDir = root;
    await writeFile(join(root, 'root.audit.jsonl'), '');
    await writeFile(join(root, 'session.jsonl'), '');
    await writeFile(join(root, '.hidden.audit.jsonl'), '');
    await mkdir(join(root, '2026-07-30'));
    await writeFile(join(root, '2026-07-30', 'nested.audit.jsonl'), '');
    mocks.load.mockImplementation(async (id: string) => [entry(id.includes('nested') ? 2 : 1)]);
    mocks.verify.mockImplementation(async (id: string) => ({ ok: !id.includes('nested') }));
    const render = deps();

    await expect(auditCmd(['--list'], render as never)).resolves.toBe(0);
    const output = render.renderer.write.mock.calls.flat().join(' ');
    expect(output).toContain('2 audit log(s)');
    expect(output).toContain('root');
    expect(output).toContain('2026-07-30/nested');
    expect(output).toContain('intact');
    expect(output).toContain('broken');
  });

  it('handles a missing sessions directory and an empty one', async () => {
    mocks.sessionsDir = join(tmpdir(), `missing-${Date.now()}`);
    const missing = deps();
    await expect(auditCmd(['-l'], missing as never)).resolves.toBe(0);
    expect(missing.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('No sessions dir found'),
    );

    const root = await mkdtemp(join(tmpdir(), 'audit-command-empty-'));
    roots.push(root);
    mocks.sessionsDir = root;
    const empty = deps();
    await expect(auditCmd(['--list'], empty as never)).resolves.toBe(0);
    expect(empty.renderer.write).toHaveBeenCalledWith(
      expect.stringContaining('No audit logs recorded'),
    );
  });
});
