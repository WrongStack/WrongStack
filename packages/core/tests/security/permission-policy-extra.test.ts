import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DefaultPermissionPolicy } from '../../src/security/permission-policy.js';
import type { Context } from '../../src/core/context.js';
import type { Tool } from '../../src/types/index.js';

function tool(
  name: string,
  permission: 'auto' | 'confirm' | 'deny' = 'confirm',
  opts: {
    riskTier?: 'safe' | 'standard' | 'destructive';
    mutating?: boolean;
    capabilities?: readonly string[];
    subjectKey?: string;
  } = {},
): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission,
    mutating: opts.mutating ?? true,
    riskTier: opts.riskTier,
    capabilities: opts.capabilities,
    subjectKey: opts.subjectKey,
    async execute() {
      return 'ok';
    },
  } as Tool;
}

const ctx = (): Context => ({ hasRead: () => false, projectRoot: '/proj' }) as never as Context;

let dir: string;
let trustFile: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-extra-'));
  trustFile = path.join(dir, 'trust.json');
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('session soft deny / allow', () => {
  it('denyOnce blocks a tool+subject for the session', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.reload(); // first evaluate would otherwise reload() and clear the soft set
    p.denyOnce({ tool: 'edit', pattern: 'src/a.ts' });
    const d = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, ctx());
    expect(d).toMatchObject({ permission: 'deny', source: 'deny' });
  });

  it('allowOnce auto-approves a tool+subject once', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.reload();
    p.allowOnce({ tool: 'edit', pattern: 'src/a.ts' });
    const d = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'trust' });
    const second = await p.evaluate(tool('edit'), { path: 'src/a.ts' }, ctx());
    expect(second.permission).toBe('confirm');
  });
});

describe('yolo + confirmDestructive', () => {
  const destructiveBash = () => tool('bash', 'confirm', { capabilities: ['shell.arbitrary'] });

  // WS-008: both of these asserted that YOLO auto-approves destructive shell
  // commands. isClearlyDestructiveBashCommand existed and was tested but had no
  // production caller, so the gate this file describes never ran.
  it('confirms a destructive-classified call with no prompt delegate', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    p.setYolo(true);
    const d = await p.evaluate(destructiveBash(), { command: 'rm -rf /' }, ctx());
    expect(d).toMatchObject({ permission: 'confirm', source: 'yolo_destructive' });
  });

  it('confirms destructive YOLO calls without consulting the prompt delegate', async () => {
    const delegate = vi.fn();
    const p = new DefaultPermissionPolicy({ trustFile, promptDelegate: delegate });
    p.setYolo(true);

    delegate.mockResolvedValueOnce('always');
    expect(await p.evaluate(destructiveBash(), { command: 'rm -rf /etc' }, ctx())).toMatchObject({
      permission: 'confirm',
      source: 'yolo_destructive',
    });
    expect(delegate).not.toHaveBeenCalled();
  });

  it('auto-approves destructive calls once yoloDestructive is opted into', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    p.setYolo(true);
    p.setYoloDestructive(true);
    const d = await p.evaluate(destructiveBash(), { command: 'rm -rf /' }, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'yolo' });
  });

  it('auto-approves a non-destructive call under yolo', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    p.setYolo(true);
    const d = await p.evaluate(tool('read', 'auto', { mutating: false }), { path: 'a.ts' }, ctx());
    expect(d.permission).toBe('auto');
  });
});

describe('confirm prompt delegate (step 9)', () => {
  it('handles always / deny / yes / no', async () => {
    const delegate = vi.fn();
    const p = new DefaultPermissionPolicy({ trustFile, promptDelegate: delegate });

    delegate.mockResolvedValueOnce('always');
    expect(await p.evaluate(tool('edit'), { path: 'a.ts' }, ctx())).toMatchObject({
      permission: 'auto',
      source: 'user',
    });
    delegate.mockResolvedValueOnce('deny');
    expect(await p.evaluate(tool('edit'), { path: 'b.ts' }, ctx())).toMatchObject({
      permission: 'deny',
      source: 'user',
    });
    delegate.mockResolvedValueOnce('yes');
    expect(await p.evaluate(tool('edit'), { path: 'c.ts' }, ctx())).toMatchObject({
      permission: 'auto',
      source: 'user',
    });
    delegate.mockResolvedValueOnce('no');
    expect(await p.evaluate(tool('edit'), { path: 'd.ts' }, ctx())).toMatchObject({
      permission: 'deny',
      source: 'user',
    });
  });
});

describe('deny / trust persistence + revert', () => {
  it('deny() persists a deny rule that blocks subsequent evaluation', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.deny({ tool: 'edit', pattern: 'src/secret.ts' });
    const d = await p.evaluate(tool('edit'), { path: 'src/secret.ts' }, ctx());
    expect(d).toMatchObject({ permission: 'deny', source: 'deny' });
    // The deny is persisted to the trust file.
    expect(JSON.parse(await fs.readFile(trustFile, 'utf8')).edit.deny).toContain('src/secret.ts');
  });

  it('fails closed when the trust path is unreadable and refuses deny updates', async () => {
    // A directory cannot be parsed as trust.json. Runtime enforcement denies
    // calls until the operator repairs it, and mutation cannot overwrite it.
    const badTrust = path.join(dir, 'as-dir');
    await fs.mkdir(badTrust);
    const p = new DefaultPermissionPolicy({ trustFile: badTrust });
    await expect(p.deny({ tool: 'edit', pattern: 'x' })).rejects.toThrow();
    const d = await p.evaluate(tool('edit'), { path: 'x' }, ctx());
    expect(d).toMatchObject({ permission: 'deny', source: 'deny' });
    expect(p.getPolicyDiagnostics()).toContainEqual(
      expect.objectContaining({ code: 'read_error' }),
    );
  });

  it('trust() reverts the in-memory rule and rethrows when the write fails', async () => {
    const badTrust = path.join(dir, 'as-dir2');
    await fs.mkdir(badTrust);
    const p = new DefaultPermissionPolicy({ trustFile: badTrust });
    await expect(p.trust({ tool: 'edit', pattern: 'y' })).rejects.toThrow();
  });
});

describe('subjectFor with an explicit subjectKey', () => {
  it('matches a non-path subjectKey opaquely and a path subjectKey normalized', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    await p.reload();
    // A url-keyed tool: trust the exact url, then it auto-approves.
    p.allowOnce({ tool: 'fetch', pattern: 'https://example.com/x' });
    const d = await p.evaluate(
      tool('fetch', 'confirm', { subjectKey: 'url' }),
      { url: 'https://example.com/x' },
      ctx(),
    );
    expect(d.permission).toBe('auto');
  });

  it('normalizes a path-typed subjectKey for matching', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ patch: { allow: ['src/x.ts'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(
      tool('patch', 'confirm', { subjectKey: 'path' }),
      { path: 'src\\x.ts' },
      ctx(),
    );
    expect(d).toMatchObject({ permission: 'auto', source: 'trust' });
  });

  it('falls back to the legacy heuristic when the subjectKey value is not a string', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    // subjectKey 'url' is declared but the value is a number → fall through to path.
    const d = await p.evaluate(
      tool('fetch', 'confirm', { subjectKey: 'url' }),
      { url: 123, path: 'p.ts' },
      ctx(),
    );
    expect(d.permission).toBe('confirm');
  });
});

describe('cache / default / trust-entry paths', () => {
  it('returns the cached decision on a repeat evaluation', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const t = tool('read', 'auto', { mutating: false });
    const first = await p.evaluate(t, { path: 'a.ts' }, ctx());
    const second = await p.evaluate(t, { path: 'a.ts' }, ctx());
    expect(second).toEqual(first); // 2nd call hits the eval cache
  });

  it('denies a tool whose default permission is deny', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('blocked', 'deny'), { path: 'a' }, ctx());
    expect(d).toMatchObject({ permission: 'deny', source: 'default' });
  });

  it('auto-approves a tool carrying an `auto` trust entry', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ autoTool: { auto: true } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('autoTool'), { path: 'a' }, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'trust' });
  });

  it('auto-approves write when the file was already read this session', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const c = { hasRead: () => true, projectRoot: '/proj' } as never as Context;
    const d = await p.evaluate(tool('write'), { path: 'x.ts' }, c);
    expect(d).toMatchObject({ permission: 'auto', source: 'context' });
  });
});

describe('destructive detection — capability and legacy paths', () => {
  const yoloDestructive = () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    p.setYolo(true);
    return p;
  };

  it('auto-approves a fs.write.outside-project capability under yolo', async () => {
    const d = await yoloDestructive().evaluate(
      tool('deploy', 'confirm', { capabilities: ['fs.write.outside-project'] }),
      {},
      ctx(),
    );
    expect(d).toMatchObject({ permission: 'auto', source: 'yolo' });
  });

  it('a fs.write tool with no path is not destructive', async () => {
    const d = await yoloDestructive().evaluate(
      tool('write', 'confirm', { capabilities: ['fs.write'] }),
      {},
      ctx(),
    );
    expect(d).toMatchObject({ permission: 'auto', source: 'yolo' });
  });

  it('legacy name-based: an edit outside the project is auto-approved under yolo', async () => {
    const d = await yoloDestructive().evaluate(tool('edit'), { path: '/etc/passwd' }, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'yolo' });
  });

  it('legacy name-based: an edit with no path is not destructive', async () => {
    const d = await yoloDestructive().evaluate(tool('edit'), {}, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'yolo' });
  });

  it('legacy: riskTier destructive still auto-approves under yolo', async () => {
    const d = await yoloDestructive().evaluate(
      tool('exec', 'confirm', { riskTier: 'destructive' }),
      {},
      ctx(),
    );
    expect(d).toMatchObject({ permission: 'auto', source: 'yolo' });
  });
});

describe('subjectFor legacy heuristics', () => {
  it('handles a non-object input (no subject)', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('read', 'auto', { mutating: false }), null, ctx());
    expect(d.permission).toBe('auto');
  });

  it('escapes glob metacharacters in the subject', async () => {
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(
      tool('bash', 'confirm', { capabilities: ['shell.arbitrary'] }),
      { command: 'ls *.ts' },
      ctx(),
    );
    expect(d.permission).toBeDefined();
  });

  it('derives the subject from a url field when no subjectKey is set', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ webget: { allow: ['http://x/'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('webget'), { url: 'http://x/' }, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'trust' });
  });

  it('derives the subject from a name field as a last resort', async () => {
    await fs.writeFile(trustFile, JSON.stringify({ skill: { allow: ['myskill'] } }));
    const p = new DefaultPermissionPolicy({ trustFile });
    const d = await p.evaluate(tool('skill'), { name: 'myskill' }, ctx());
    expect(d).toMatchObject({ permission: 'auto', source: 'trust' });
  });
});
