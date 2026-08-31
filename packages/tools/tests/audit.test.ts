import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

const spawnStreamMocks = vi.hoisted(() => ({ spawnStream: vi.fn() }));

vi.mock('../src/_spawn-stream.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    spawnStream: spawnStreamMocks.spawnStream,
  };
});

import { auditTool } from '../src/audit.js';

const makeCtx = () => ({ cwd: '/fake', tools: [], projectRoot: '/fake' }) as any;
const makeOpts = () => ({ signal: new AbortController().signal });

function fakeSpawnStream(stdout: string, exitCode = 0) {
  // biome-ignore lint/correctness/useYield: test mock doesn't need actual yield
  return async function* () {
    return { stdout, stderr: '', exitCode, truncated: false };
  };
}

beforeEach(() => {
  spawnStreamMocks.spawnStream.mockReset();
  // Default: empty audit (no vulnerabilities)
  spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 0));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('auditTool', () => {
  it('has correct metadata', () => {
    expect(auditTool.name).toBe('audit');
    expect(auditTool.permission).toBe('confirm');
    expect(auditTool.mutating).toBe(false);
    expect(auditTool.inputSchema.type).toBe('object');
  });

  it('handles empty packages', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    const result = await auditTool.execute({ level: 'high' }, ctx, opts);
    expect(result).toHaveProperty('exit_code');
    expect(result).toHaveProperty('vulnerabilities');
  });

  it('rejects fix: true — the tool is read-only and must not silently mutate', async () => {
    const ctx = makeCtx();
    const opts = makeOpts();
    await expect(auditTool.execute({ fix: true }, ctx, opts)).rejects.toThrow(
      /read-only.*install/s,
    );
    // No process was spawned for the rejected call.
    expect(spawnStreamMocks.spawnStream).not.toHaveBeenCalled();
  });

  it('accepts fix: false without rejecting', async () => {
    const result = await auditTool.execute({ fix: false }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('exit_code');
  });

  it('wires level to --audit-level for npm', async () => {
    let captured: { args: string[] } | undefined;
    spawnStreamMocks.spawnStream.mockImplementation((opts: { args: string[] }) => {
      captured = opts;
      return fakeSpawnStream('', 0)();
    });
    await auditTool.execute({ level: 'critical' }, makeCtx(), makeOpts());
    expect(captured?.args).toContain('--audit-level=critical');
  });

  it('filters parsed advisories below the requested level', async () => {
    const payload = JSON.stringify({
      advisories: {
        '1': { severity: 'low', module_name: 'low-pkg', title: 'meh', url: 'u' },
        '2': { severity: 'high', module_name: 'high-pkg', title: 'bad', url: 'u' },
        '3': { severity: 'critical', module_name: 'crit-pkg', title: 'worse', url: 'u' },
      },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 1));
    const result = await auditTool.execute({ level: 'high' }, makeCtx(), makeOpts());
    expect(result.total).toBe(2);
    expect(result.vulnerabilities.map((v) => v.package).sort()).toEqual(['crit-pkg', 'high-pkg']);
  });

  it('parses npm audit JSON into vulnerability list (with critical + high tally)', async () => {
    const payload = JSON.stringify({
      advisories: {
        '1001': {
          severity: 'critical',
          module_name: 'evil-pkg',
          title: 'Remote code execution',
          url: 'https://example.com/advisory/1001',
        },
        '1002': {
          severity: 'high',
          module_name: 'bad-pkg',
          title: 'Prototype pollution',
          url: 'https://example.com/advisory/1002',
        },
        '1003': {
          severity: 'moderate',
          module_name: 'meh-pkg',
          title: 'Regex DoS',
          url: 'https://example.com/advisory/1003',
        },
      },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 1));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.total).toBe(3);
    expect(result.summary).toContain('1 critical');
    expect(result.summary).toContain('1 high');
    expect(result.vulnerabilities.map((v) => v.package).sort()).toEqual([
      'bad-pkg',
      'evil-pkg',
      'meh-pkg',
    ]);
  });

  it('reports "No vulnerabilities found" on clean exit with empty output', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toBe('No vulnerabilities found');
    expect(result.total).toBe(0);
  });

  it('reports "Audit failed" when exit code is non-zero with empty output', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 1));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toBe('Audit failed');
    expect(result.exit_code).toBe(1);
  });

  it('returns "Could not parse" message when JSON is malformed', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('garbage{', 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toBe('Could not parse audit output');
    expect(result.vulnerabilities).toEqual([]);
    expect(result.output).toBe('garbage{');
  });

  it('uses fallback "Unknown vulnerability" when advisory entries are missing fields', async () => {
    const payload = JSON.stringify({
      advisories: {
        only_id: {
          /* no fields at all */
        },
      },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].title).toBe('Unknown vulnerability');
    expect(result.vulnerabilities[0].severity).toBe('unknown');
    expect(result.vulnerabilities[0].package).toBe('only_id');
  });

  it('parses the npm >=7 vulnerabilities shape (via objects carry title/url)', async () => {
    const payload = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        'evil-pkg': {
          name: 'evil-pkg',
          severity: 'critical',
          isDirect: true,
          via: [
            {
              source: 1001,
              name: 'evil-pkg',
              title: 'Remote code execution',
              url: 'https://example.com/advisory/1001',
              severity: 'critical',
            },
          ],
        },
        'transitive-pkg': {
          name: 'transitive-pkg',
          severity: 'high',
          isDirect: false,
          // String-only via entries: no advisory detail available.
          via: ['evil-pkg'],
        },
      },
      metadata: { vulnerabilities: { critical: 1, high: 1, total: 2 } },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 1));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.total).toBe(2);
    expect(result.summary).toContain('1 critical');
    expect(result.summary).toContain('1 high');
    const evil = result.vulnerabilities.find((v) => v.package === 'evil-pkg');
    expect(evil?.title).toBe('Remote code execution');
    expect(evil?.url).toBe('https://example.com/advisory/1001');
    const transitive = result.vulnerabilities.find((v) => v.package === 'transitive-pkg');
    expect(transitive?.title).toBe('Unknown vulnerability');
  });

  it('caps huge raw JSON output and reports truncated honestly', async () => {
    const payload = JSON.stringify({
      advisories: {
        '1': { severity: 'high', module_name: 'big', title: 'x'.repeat(120_000), url: 'u' },
      },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 1));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.truncated).toBe(true);
    // Normalized/truncated output stays within the 32 KB command-output cap
    // (plus a small marker allowance).
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(33_000);
  });

  it('reports zero critical/high when only lower-severity advisories are present', async () => {
    const payload = JSON.stringify({
      advisories: { '1': { severity: 'low', module_name: 'x', title: 't', url: 'u' } },
    });
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream(payload, 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.summary).toContain('0 critical');
    expect(result.summary).toContain('0 high');
  });

  it('resolves an explicit cwd', async () => {
    const result = await auditTool.execute({ cwd: '.' }, makeCtx(), makeOpts());
    expect(result).toHaveProperty('summary');
  });

  it('reports no vulnerabilities for valid JSON without an advisories key', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('{}', 0));
    const result = await auditTool.execute({}, makeCtx(), makeOpts());
    expect(result.total).toBe(0);
    expect(result.summary).toBe('No vulnerabilities found');
  });

  it('throws when executeStream is unavailable', async () => {
    const original = auditTool.executeStream;
    (auditTool as { executeStream: typeof original | undefined }).executeStream = undefined;
    try {
      await expect(auditTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      auditTool.executeStream = original;
    }
  });

  it('execute throws if executeStream emits no final event', async () => {
    // spawnStream returns empty output — but we make executeStream skip the final yield
    // by replacing it on the tool directly. Easier: stream that throws.
    spawnStreamMocks.spawnStream.mockImplementation(async function* () {
      // Yield nothing, return nothing
    });
    // The default executeStream's `yield* spawnStream(...)` will still call
    // parseAuditOutput on undefined.stdout — so we won't reach the "no final"
    // error. Instead, replace executeStream to skip the final yield entirely.
    const original = auditTool.executeStream!;
    auditTool.executeStream = async function* (this: never) {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(auditTool.execute({}, makeCtx(), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      auditTool.executeStream = original;
    }
  });

  it('executes cleanly when opts parameter is omitted', async () => {
    spawnStreamMocks.spawnStream.mockImplementation(fakeSpawnStream('', 0));
    const result = await auditTool.execute({}, makeCtx());
    expect(result.summary).toBe('No vulnerabilities found');
  });
});
