import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const changelogWriterPlugin = (await import('../src/changelog-writer')).default;
const { commitToEntry, commitSubjectFromCommand, mergeIntoChangelog } = await import(
  '../src/changelog-writer'
);

interface MockApi {
  tools: { register: ReturnType<typeof vi.fn> };
  config: { extensions: Record<string, unknown> };
  log: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  metrics: {
    counter: ReturnType<typeof vi.fn>;
    histogram: ReturnType<typeof vi.fn>;
    gauge: ReturnType<typeof vi.fn>;
  };
  registerHook: ReturnType<typeof vi.fn>;
  onPattern: ReturnType<typeof vi.fn>;
  llm?: { complete: ReturnType<typeof vi.fn> } | undefined;
}

function makeApi(
  overrides: {
    extensions?: Record<string, unknown>;
    llm?: { complete: ReturnType<typeof vi.fn> } | undefined;
  } = {},
): MockApi {
  return {
    tools: { register: vi.fn() },
    config: { extensions: overrides.extensions ?? {} },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    metrics: { counter: vi.fn(), histogram: vi.fn(), gauge: vi.fn() },
    registerHook: vi.fn(() => vi.fn()),
    onPattern: vi.fn(() => vi.fn()),
    llm: overrides.llm,
  };
}

function getTool(
  api: MockApi,
  name: string,
): { execute: (input: unknown) => Promise<Record<string, unknown>> } {
  const call = api.tools.register.mock.calls.find(
    ([t]: unknown[]) => (t as { name: string }).name === name,
  );
  if (!call) throw new Error(`${name} not registered`);
  return call[0] as { execute: (input: unknown) => Promise<Record<string, unknown>> };
}

describe('per-session reset', () => {
  it('clears pending entries when a session ends', async () => {
    // Entries describe "this session's" work, but the plugin is set up once
    // per PROCESS and the host outlives any one session. Only a completed
    // write cleared the buffer, so an unwritten session's entries were carried
    // into the next one and rendered as its work. The mock has no onEvent of
    // its own — the subscription is guarded, so the test must supply one.
    const api = {
      ...makeApi(),
      onEvent: vi.fn((_event: string, _handler: () => void) => vi.fn()),
    };
    changelogWriterPlugin.setup(api as never);

    await getTool(api as never, 'changelog_add').execute({ text: 'session A entry' });
    const before = (await changelogWriterPlugin.health!()) as { counters: Record<string, number> };
    expect(before.counters['pendingEntries']).toBe(1);

    const sessionEnded = api.onEvent.mock.calls.find(([e]: unknown[]) => e === 'session.ended');
    expect(sessionEnded).toBeDefined();
    sessionEnded![1]();

    const after = (await changelogWriterPlugin.health!()) as { counters: Record<string, number> };
    expect(after.counters['pendingEntries']).toBe(0);
  });
});

let tmp: string;
let originalCwd: string;

beforeEach(() => {
  vi.clearAllMocks();
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), 'changelog-writer-'));
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(originalCwd);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // best-effort on Windows
  }
});

describe('commitToEntry / commitSubjectFromCommand', () => {
  it('maps conventional types to sections', () => {
    expect(commitToEntry('feat(ui): add dark mode')).toEqual({
      section: 'Added',
      text: 'add dark mode (ui)',
    });
    expect(commitToEntry('fix: crash on start').section).toBe('Fixed');
    expect(commitToEntry('docs: update README').section).toBe('Documentation');
    expect(commitToEntry('chore: bump deps').section).toBe('Maintenance');
    expect(commitToEntry('plain subject').section).toBe('Changed');
  });

  it('extracts subjects from git commit commands', () => {
    expect(commitSubjectFromCommand('git commit -m "feat: x"')).toBe('feat: x');
    expect(commitSubjectFromCommand("git add . && git commit -m 'fix: y'")).toBe('fix: y');
    expect(commitSubjectFromCommand('git status')).toBeNull();
    expect(commitSubjectFromCommand('echo "git commit style"')).toBeNull();
  });
});

describe('mergeIntoChangelog', () => {
  it('creates a Keep-a-Changelog file when missing', () => {
    const out = mergeIntoChangelog(null, '### Added\n- dark mode');
    expect(out).toContain('# Changelog');
    expect(out).toContain('## [Unreleased]');
    expect(out).toContain('- dark mode');
  });

  it('inserts under an existing Unreleased heading, preserving old content', () => {
    const existing =
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n- old fix\n\n## [1.0.0]\n- release\n';
    const out = mergeIntoChangelog(existing, '### Added\n- new thing');
    const unreleasedIdx = out.indexOf('## [Unreleased]');
    const newIdx = out.indexOf('- new thing');
    const oldIdx = out.indexOf('- old fix');
    const releaseIdx = out.indexOf('## [1.0.0]');
    expect(unreleasedIdx).toBeLessThan(newIdx);
    expect(newIdx).toBeLessThan(oldIdx);
    expect(oldIdx).toBeLessThan(releaseIdx);
  });

  it('keeps prose, other bullet styles, sub-bullets and unknown sections it does not model', () => {
    const existing = [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      'Big refactor ahead.',
      '',
      '### Added',
      '- feature A',
      '  - detail of A',
      '* starred item',
      '',
      '### Deprecated',
      '- old api',
      '',
      '### Migration Notes',
      '- run the script',
      '',
      '## [1.0.0]',
      '- release',
      '',
    ].join('\n');
    const out = mergeIntoChangelog(existing, '### Fixed\n- bug B');
    expect(out).toContain('Big refactor ahead.');
    expect(out).toContain('- feature A\n  - detail of A');
    expect(out).toContain('starred item');
    // Deprecated items stay under Deprecated, not the previous section.
    expect(out).toMatch(/### Deprecated\n- old api/);
    expect(out).toMatch(/### Migration Notes\n- run the script/);
    expect(out).toContain('### Fixed\n- bug B');
    expect(out.indexOf('## [1.0.0]')).toBeGreaterThan(out.indexOf('run the script'));
  });

  it('adds an Unreleased section after the H1 when absent', () => {
    const out = mergeIntoChangelog('# Changelog\n\n## [1.0.0]\n- x\n', '### Added\n- y');
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [1.0.0]'));
  });
});

describe('changelog-writer plugin', () => {
  it('registers add/preview/write tools and a bus subscription', () => {
    const api = makeApi();
    changelogWriterPlugin.setup(api as never);
    const names = api.tools.register.mock.calls.map(
      ([t]: unknown[]) => (t as { name: string }).name,
    );
    expect(names).toEqual(
      expect.arrayContaining(['changelog_add', 'changelog_preview', 'changelog_write']),
    );
    expect(api.onPattern).toHaveBeenCalledWith('tool.*', expect.any(Function));
  });

  it('collects commit subjects from bash events', async () => {
    const api = makeApi();
    changelogWriterPlugin.setup(api as never);
    const busHandler = api.onPattern.mock.calls[0]![1] as (event: string, payload: unknown) => void;
    busHandler('tool.completed', {
      tool: 'bash',
      input: { command: 'git commit -m "feat: shiny feature"' },
      isError: false,
    });
    const preview = await getTool(api, 'changelog_preview').execute({});
    expect(preview['markdown']).toContain('### Added');
    expect(preview['markdown']).toContain('- shiny feature');
  });

  it('changelog_add + changelog_write produce a valid file and clear pending entries', async () => {
    const filePath = join(tmp, 'CHANGELOG.md');
    const api = makeApi({ extensions: { 'changelog-writer': { filePath } } });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'dark mode', section: 'Added' });
    await getTool(api, 'changelog_add').execute({ text: 'crash on start', section: 'Fixed' });
    const write = await getTool(api, 'changelog_write').execute({});
    expect(write['ok']).toBe(true);
    expect(write['created']).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('## [Unreleased]');
    expect(content).toContain('### Added');
    expect(content).toContain('- dark mode');
    expect(content).toContain('### Fixed');
    // pending cleared:
    await expect(getTool(api, 'changelog_write').execute({})).rejects.toThrow(/no pending entries/);
  });

  it('throws instead of overwriting when the existing changelog cannot be read', async () => {
    // A directory at filePath: read fails with EISDIR, not ENOENT.
    const filePath = join(tmp, 'CHANGELOG.md');
    mkdirSync(filePath);
    const api = makeApi({ extensions: { 'changelog-writer': { filePath } } });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'x', section: 'Added' });
    await expect(getTool(api, 'changelog_write').execute({})).rejects.toThrow(/failed to read/);
  });

  it('rejects changelog writes outside the project directory', async () => {
    const filePath = join(tmpdir(), `outside-changelog-${Date.now()}.md`);
    const api = makeApi({ extensions: { 'changelog-writer': { filePath } } });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'dark mode', section: 'Added' });
    await expect(getTool(api, 'changelog_write').execute({})).rejects.toThrow(
      /current project directory/,
    );
  });

  it('merges into an existing changelog without clobbering it', async () => {
    const filePath = join(tmp, 'CHANGELOG.md');
    writeFileSync(filePath, '# Changelog\n\n## [Unreleased]\n\n## [2.0.0]\n- big release\n');
    const api = makeApi({ extensions: { 'changelog-writer': { filePath } } });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'patch', section: 'Fixed' });
    await getTool(api, 'changelog_write').execute({});
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('- big release');
    expect(content).toContain('- patch');
  });

  it('dedupes identical entry lines in the rendered block', async () => {
    const api = makeApi();
    changelogWriterPlugin.setup(api as never);
    const add = getTool(api, 'changelog_add');
    await add.execute({ text: 'same thing', section: 'Added' });
    await add.execute({ text: 'same thing', section: 'Added' });
    const preview = await getTool(api, 'changelog_preview').execute({});
    const occurrences = String(preview['markdown']).split('- same thing').length - 1;
    expect(occurrences).toBe(1);
  });

  it('enabled:false rejects adds and skips collection', async () => {
    const api = makeApi({ extensions: { 'changelog-writer': { enabled: false } } });
    changelogWriterPlugin.setup(api as never);
    expect(api.onPattern).not.toHaveBeenCalled();
    await expect(getTool(api, 'changelog_add').execute({ text: 'x' })).rejects.toThrow(/disabled/);
  });

  it('polish rewrites the block via api.llm and falls back on failure', async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue({
        text: '### Added\n- Beautiful dark mode for night owls',
        model: 'claude-haiku-4-5',
        provider: 'anthropic',
        usage: { input: 100, output: 30 },
        stopReason: 'end_turn',
      }),
    };
    const api = makeApi({ llm });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'dark mode', section: 'Added' });

    const preview = await getTool(api, 'changelog_preview').execute({ polish: true });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(preview['polished']).toBe(true);
    expect(preview['markdown']).toContain('night owls');

    // LLM breaks → raw block survives, tool still succeeds.
    llm.complete.mockRejectedValueOnce(new Error('provider down'));
    const fallback = await getTool(api, 'changelog_preview').execute({ polish: true });
    expect(fallback['polished']).toBe(false);
    expect(fallback['markdown']).toContain('- dark mode');
  });

  it('polish is rejected when the LLM response loses the block shape', async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue({
        text: 'Sure! Here are your release notes: dark mode is great.',
        model: 'm',
        provider: 'p',
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      }),
    };
    const api = makeApi({ llm });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'dark mode', section: 'Added' });
    const preview = await getTool(api, 'changelog_preview').execute({ polish: true });
    expect(preview['polished']).toBe(false);
    expect(preview['markdown']).toContain('### Added');
  });

  it('polish without api.llm is a silent no-op', async () => {
    const api = makeApi();
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'x', section: 'Fixed' });
    const preview = await getTool(api, 'changelog_preview').execute({ polish: true });
    expect(preview['polished']).toBe(false);
    expect(preview['llmAvailable']).toBe(false);
    expect(preview['markdown']).toContain('- x');
  });

  it('changelog_write polish writes the polished block', async () => {
    const filePath = join(tmp, 'CHANGELOG.md');
    const llm = {
      complete: vi.fn().mockResolvedValue({
        text: '### Fixed\n- Fixed a crash when starting the app',
        model: 'm',
        provider: 'p',
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
      }),
    };
    const api = makeApi({ llm, extensions: { 'changelog-writer': { filePath } } });
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'crash on start', section: 'Fixed' });
    const write = await getTool(api, 'changelog_write').execute({ polish: true });
    expect(write['ok']).toBe(true);
    expect(readFileSync(filePath, 'utf-8')).toContain('Fixed a crash when starting the app');
  });

  it('teardown clears state and logs', async () => {
    const api = makeApi();
    changelogWriterPlugin.setup(api as never);
    await getTool(api, 'changelog_add').execute({ text: 'x' });
    changelogWriterPlugin.teardown!(api as never);
    const health = (await changelogWriterPlugin.health!()) as { counters: Record<string, number> };
    expect(health.counters['pendingEntries']).toBe(0);
    expect(api.log.info).toHaveBeenCalledWith(
      'changelog-writer: teardown complete',
      expect.any(Object),
    );
  });

  it('falls back to Changed for Object.prototype commit types (F236)', () => {
    expect(commitToEntry('constructor: harden lookup').section).toBe('Changed');
    expect(commitToEntry('toString: harden lookup').section).toBe('Changed');
    expect(commitToEntry('__proto__: harden lookup').section).toBe('Changed');
  });
});
