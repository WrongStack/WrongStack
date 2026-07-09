import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildTuneupCommand } from '../src/slash-commands/tuneup.js';
import {
  checkAutonomy,
  checkHooks,
  checkMcp,
  checkMemoryDedup,
  checkMemorySize,
  checkPermissions,
  checkPlugins,
  checkSkills,
  isReadOnlyCommand,
  runTuneup,
  type TuneupInput,
} from '../src/tuneup.js';

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------

function baseInput(overrides: Partial<TuneupInput> = {}): TuneupInput {
  return {
    config: {} as TuneupInput['config'],
    skills: [],
    eagerMaxChars: 24_000,
    skillMode: 'eager',
    memoryFiles: [],
    ...overrides,
  };
}

describe('isReadOnlyCommand', () => {
  it('accepts conservative read-only verbs', () => {
    expect(isReadOnlyCommand('ls -la')).toBe(true);
    expect(isReadOnlyCommand('grep -R foo src')).toBe(true);
    expect(isReadOnlyCommand('git status')).toBe(true);
    expect(isReadOnlyCommand('git log --oneline')).toBe(true);
  });

  it('rejects mutating or shell-piped commands', () => {
    expect(isReadOnlyCommand('rm -rf build')).toBe(false);
    expect(isReadOnlyCommand('git push --force')).toBe(false);
    expect(isReadOnlyCommand('echo hi > file')).toBe(false);
    expect(isReadOnlyCommand('cat a | tee b')).toBe(false);
    expect(isReadOnlyCommand('npm install')).toBe(false);
    expect(isReadOnlyCommand('')).toBe(false);
  });
});

describe('checkAutonomy', () => {
  it('flags a non-auto default with a fix action', () => {
    const [finding] = checkAutonomy(
      baseInput({ config: { autonomy: { defaultMode: 'off' } } as TuneupInput['config'] }),
    );
    expect(finding.severity).toBe('info');
    expect(finding.action).toEqual({ kind: 'set-autonomy-auto' });
  });

  it('reports ok when auto is already the default', () => {
    const [finding] = checkAutonomy(
      baseInput({ config: { autonomy: { defaultMode: 'auto' } } as TuneupInput['config'] }),
    );
    expect(finding.severity).toBe('ok');
    expect(finding.action).toBeUndefined();
  });
});

describe('checkHooks', () => {
  it('flags a slow hook with a clamp action', () => {
    const findings = checkHooks(
      baseInput({
        config: {
          hooks: { PreToolUse: [{ command: 'sleep 30', timeoutMs: 30_000 }] },
        } as TuneupInput['config'],
      }),
    );
    const slow = findings.find((f) => f.action?.kind === 'normalize-hook-timeout');
    expect(slow).toBeDefined();
    expect(slow?.action).toMatchObject({ event: 'PreToolUse', index: 0, timeoutMs: 10_000 });
  });

  it('flags many hooks on one event', () => {
    const findings = checkHooks(
      baseInput({
        config: {
          hooks: {
            PostToolUse: Array.from({ length: 5 }, () => ({ command: 'noop' })),
          },
        } as TuneupInput['config'],
      }),
    );
    expect(findings.some((f) => f.problem.includes('5 shell hooks'))).toBe(true);
  });

  it('is silent with no hooks', () => {
    expect(checkHooks(baseInput())).toEqual([]);
  });
});

describe('checkMemoryDedup', () => {
  it('flags a significant line duplicated across two files', () => {
    const dupLine = 'Always run the full test suite before every release.';
    const findings = checkMemoryDedup(
      baseInput({
        memoryFiles: [
          { label: 'user memory', path: '/a', content: dupLine, committed: false },
          {
            label: 'project AGENTS.md',
            path: '/b',
            content: `# Rules\n${dupLine}`,
            committed: true,
          },
        ],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].handoff).toBeTruthy();
  });

  it('ignores short/trivial lines and single files', () => {
    expect(
      checkMemoryDedup(
        baseInput({
          memoryFiles: [
            { label: 'a', path: '/a', content: '# Title\nok\n', committed: false },
            { label: 'b', path: '/b', content: '# Title\nok\n', committed: true },
          ],
        }),
      ),
    ).toEqual([]);
  });
});

describe('checkMemorySize', () => {
  it('flags an oversized instruction file with a handoff', () => {
    const big = 'x'.repeat(13_000);
    const [finding] = checkMemorySize(
      baseInput({
        memoryFiles: [{ label: 'root CLAUDE.md', path: '/c', content: big, committed: true }],
      }),
    );
    expect(finding.severity).toBe('info');
    expect(finding.handoff).toContain('root CLAUDE.md');
  });
});

describe('checkMcp', () => {
  it('flags configured-but-disabled and live-failed servers', () => {
    const findings = checkMcp(
      baseInput({
        config: { mcpServers: { old: { enabled: false } } } as TuneupInput['config'],
        mcp: [{ name: 'broken', state: 'failed', enabled: true, toolCount: 0 }],
      }),
    );
    expect(findings.some((f) => f.problem.includes('"old"') && f.severity === 'info')).toBe(true);
    expect(findings.some((f) => f.problem.includes('"broken"') && f.severity === 'warning')).toBe(
      true,
    );
  });
});

describe('checkPlugins', () => {
  it('flags disabled-but-listed plugins', () => {
    const [finding] = checkPlugins(
      baseInput({
        config: { plugins: [{ name: 'telemetry', enabled: false }] } as TuneupInput['config'],
      }),
    );
    expect(finding.problem).toContain('telemetry');
  });
});

describe('checkSkills', () => {
  it('flags eager skill bodies over the budget', () => {
    const skills = Array.from({ length: 6 }, (_, i) => ({
      name: `s${i}`,
      source: 'user',
      bodyChars: 5_000,
    }));
    const [finding] = checkSkills(baseInput({ skills, eagerMaxChars: 24_000 }));
    expect(finding.severity).toBe('warning');
    expect(finding.problem).toContain('exceed the eager inject budget');
  });

  it('stays quiet in progressive mode', () => {
    const skills = [{ name: 's', source: 'user', bodyChars: 99_999 }];
    expect(checkSkills(baseInput({ skills, skillMode: 'progressive' }))).toEqual([]);
  });
});

describe('checkPermissions', () => {
  it('promotes read-only denied commands to an exec-allow action', () => {
    const [finding] = checkPermissions(
      baseInput({
        trust: { bash: { deny: ['ls -la', 'rm -rf /'] } },
      }),
    );
    expect(finding.category).toBe('permissions');
    expect(finding.action).toMatchObject({ kind: 'add-exec-allow', commands: ['ls'] });
  });

  it('mines history counts and de-dupes command names', () => {
    const [finding] = checkPermissions(
      baseInput({
        deniedFromHistory: [
          { command: 'grep foo', count: 4 },
          { command: 'grep bar', count: 2 },
          { command: 'make build', count: 3 },
        ],
      }),
    );
    expect(finding.action).toMatchObject({ kind: 'add-exec-allow', commands: ['grep'] });
  });
});

describe('runTuneup', () => {
  it('composes findings and an agent hand-off from fuzzy items', () => {
    const report = runTuneup(
      baseInput({
        config: { autonomy: { defaultMode: 'off' } } as TuneupInput['config'],
        memoryFiles: [
          { label: 'root CLAUDE.md', path: '/c', content: 'x'.repeat(13_000), committed: true },
        ],
      }),
    );
    expect(report.findings.some((f) => f.category === 'autonomy')).toBe(true);
    expect(report.agentHandoff).toContain('root CLAUDE.md');
  });
});

// ---------------------------------------------------------------------------
// Slash command (IO)
// ---------------------------------------------------------------------------

// Keep checkForUpdate hermetic + offline: seed a fresh cache so it returns
// from disk without a network round-trip, and restore the real cache after.
const updateCache = path.join(homedir(), '.wrongstack', 'update-cache.json');
let savedCache: string | null = null;

beforeEach(() => {
  savedCache = existsSync(updateCache) ? readFileSync(updateCache, 'utf8') : null;
  mkdirSync(path.dirname(updateCache), { recursive: true });
  writeFileSync(updateCache, JSON.stringify({ timestamp: Date.now(), latestVersion: '0.0.0' }));
});

afterEach(() => {
  if (savedCache !== null) writeFileSync(updateCache, savedCache);
  else if (existsSync(updateCache)) rmSync(updateCache);
});

function makeCtx(configObj: Record<string, unknown>): {
  ctx: SlashCommandContext;
  globalConfig: string;
  update: ReturnType<typeof vi.fn>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), 'wstack-tuneup-test-'));
  const wsDir = path.join(dir, '.wrongstack');
  mkdirSync(wsDir, { recursive: true });
  const globalConfig = path.join(wsDir, 'config.json');
  writeFileSync(globalConfig, JSON.stringify(configObj));
  const update = vi.fn();
  const ctx = {
    projectRoot: dir,
    configStore: { get: vi.fn(() => configObj), update },
    paths: {
      globalConfig,
      globalMemory: path.join(wsDir, 'memory.md'),
      inProjectAgentsFile: path.join(dir, 'project', '.wrongstack', 'AGENTS.md'),
      projectTrust: path.join(wsDir, 'trust.json'),
    },
  } as never as SlashCommandContext;
  return { ctx, globalConfig, update };
}

describe('/tuneup slash command', () => {
  it('reports without writing in report mode', async () => {
    const { ctx, globalConfig } = makeCtx({ autonomy: { defaultMode: 'off' } });
    const before = readFileSync(globalConfig, 'utf8');
    const res = await buildTuneupCommand(ctx).run!('');
    const text = stripAnsi(res!.message!);
    expect(text).toContain('Tune-up');
    expect(text).toContain('Autonomy');
    expect(text).toContain('/tuneup fix');
    expect(readFileSync(globalConfig, 'utf8')).toBe(before); // untouched
  });

  it('fix mode enables auto mode, backs up, and updates the store', async () => {
    const { ctx, globalConfig, update } = makeCtx({ autonomy: { defaultMode: 'off' } });
    const res = await buildTuneupCommand(ctx).run!('fix');
    expect(stripAnsi(res!.message!)).toContain('auto mode is now the startup default');

    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.defaultMode).toBe('auto');
    expect(existsSync(`${globalConfig}.last`)).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ autonomy: expect.objectContaining({ defaultMode: 'auto' }) }),
    );
  });

  it('fix mode hands fuzzy instruction-file items to the agent via runText', async () => {
    const { ctx } = makeCtx({ autonomy: { defaultMode: 'auto' } });
    // Seed an oversized root instruction file so a handoff is produced.
    writeFileSync(path.join(ctx.projectRoot, 'CLAUDE.md'), 'x'.repeat(13_000));
    const res = await buildTuneupCommand(ctx).run!('fix');
    expect(res!.runText).toContain('CLAUDE.md');
  });

  it('rejects unknown subcommands', async () => {
    const { ctx } = makeCtx({});
    const res = await buildTuneupCommand(ctx).run!('bogus');
    expect(stripAnsi(res!.message!)).toContain('Usage:');
  });
});
