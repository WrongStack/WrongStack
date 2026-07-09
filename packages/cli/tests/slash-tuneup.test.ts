import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { stripAnsi } from '@wrongstack/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildTuneupCommand } from '../src/slash-commands/tuneup.js';
import {
  buildDeepPrompt,
  checkAutonomy,
  checkConfigDoctor,
  checkHooks,
  checkMcp,
  checkMemoryDedup,
  checkMemorySize,
  checkPerformance,
  checkPermissions,
  checkPlugins,
  checkPowerProfile,
  checkReliability,
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
    // Power-gated: a plain tune-up recommends but does not write autonomy.
    expect(finding.action).toBeUndefined();
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

describe('checkPerformance', () => {
  it('flags disabled auto-fallback with a fix action', () => {
    const findings = checkPerformance(
      baseInput({
        config: { fallbackAuto: false, fallbackModels: [] } as TuneupInput['config'],
      }),
    );
    const fb = findings.find((f) => f.problem.includes('Automatic fallback is off'));
    expect(fb?.action).toMatchObject({ kind: 'set-config', path: ['fallbackAuto'], value: true });
  });

  it('always offers an adaptive-concurrency enable action when off', () => {
    const findings = checkPerformance(baseInput());
    expect(
      findings.some(
        (f) =>
          f.action?.kind === 'set-config' &&
          f.action.path.join('.') === 'adaptiveConcurrency.enabled',
      ),
    ).toBe(true);
  });

  it('flags oversubscribed maxConcurrent against CPU count', () => {
    const findings = checkPerformance(
      baseInput({ config: { maxConcurrent: 40 } as TuneupInput['config'], env: { cpuCount: 8 } }),
    );
    expect(findings.some((f) => f.problem.includes('oversubscribed'))).toBe(true);
  });
});

describe('checkReliability', () => {
  it('flags minimal audit level, unhardened vault, and large session logs', () => {
    const findings = checkReliability(
      baseInput({
        config: { session: { auditLevel: 'minimal' } } as TuneupInput['config'],
        env: { vaultHardened: false, sessionBytes: 200 * 1024 * 1024 },
      }),
    );
    expect(findings.some((f) => f.problem.includes('audit level'))).toBe(true);
    expect(findings.some((f) => f.problem.includes('vault'))).toBe(true);
    expect(findings.some((f) => f.problem.includes('Session logs'))).toBe(true);
  });
});

describe('checkPowerProfile', () => {
  it('emits yolo + director actions only under power', () => {
    expect(checkPowerProfile(baseInput())).toEqual([]);
    const findings = checkPowerProfile(baseInput({ power: true }));
    expect(
      findings.some((f) => f.action?.kind === 'set-config' && f.problem.includes('YOLO')),
    ).toBe(true);
    expect(findings.some((f) => f.problem.includes('Director'))).toBe(true);
  });
});

describe('checkAutonomy power-gating', () => {
  it('has no action without power, and an action with power', () => {
    const off = checkAutonomy(
      baseInput({ config: { autonomy: { defaultMode: 'off' } } as TuneupInput['config'] }),
    );
    expect(off[0].action).toBeUndefined();
    const on = checkAutonomy(
      baseInput({
        config: { autonomy: { defaultMode: 'off' } } as TuneupInput['config'],
        power: true,
      }),
    );
    expect(on[0].action).toMatchObject({ kind: 'set-config', path: ['autonomy', 'defaultMode'] });
  });
});

describe('checkConfigDoctor', () => {
  it('surfaces a doctor pointer when config issues exist', () => {
    expect(checkConfigDoctor(baseInput({ configIssues: 0 }))).toEqual([]);
    const [finding] = checkConfigDoctor(baseInput({ configIssues: 3 }));
    expect(finding.suggestion).toContain('/doctor fix');
  });
});

describe('buildDeepPrompt', () => {
  it('embeds non-ok findings and asks for a plan', () => {
    const report = runTuneup(
      baseInput({ config: { fallbackAuto: false, fallbackModels: [] } as TuneupInput['config'] }),
    );
    const prompt = buildDeepPrompt(report);
    expect(prompt).toContain('optimization');
    expect(prompt).toContain('[performance]');
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

  it('plain fix applies safe knobs and never touches autonomy', async () => {
    const { ctx, globalConfig, update } = makeCtx({ autonomy: { defaultMode: 'off' } });
    const res = await buildTuneupCommand(ctx).run!('fix');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    // A safe performance knob is written…
    expect(written.adaptiveConcurrency.enabled).toBe(true);
    // …but a plain tune-up must NOT flip autonomy (power-gated).
    expect(written.autonomy.defaultMode).toBe('off');
    expect(existsSync(`${globalConfig}.last`)).toBe(true);
    expect(update).toHaveBeenCalled();
    expect(stripAnsi(res!.message!)).toContain('adaptive concurrency enabled');
  });

  it('fix --power enables autonomy, yolo, and director (live-applied)', async () => {
    const { ctx, globalConfig } = makeCtx({ autonomy: { defaultMode: 'off' } });
    const onYolo = vi.fn();
    const onAutonomy = vi.fn();
    (ctx as { onYolo: unknown }).onYolo = onYolo;
    (ctx as { onAutonomy: unknown }).onAutonomy = onAutonomy;

    const res = await buildTuneupCommand(ctx).run!('fix --power');
    const written = JSON.parse(readFileSync(globalConfig, 'utf8'));
    expect(written.autonomy.defaultMode).toBe('auto');
    expect(written.yolo).toBe(true);
    expect(written.launch.director).toBe(true);
    // Live-applied through the runtime controllers.
    expect(onYolo).toHaveBeenCalledWith(true);
    expect(onAutonomy).toHaveBeenCalledWith('auto');
    expect(stripAnsi(res!.message!)).toContain('YOLO mode enabled');
  });

  it('deep mode hands a tailored-plan prompt to the agent', async () => {
    const { ctx, globalConfig } = makeCtx({ autonomy: { defaultMode: 'off' } });
    const before = readFileSync(globalConfig, 'utf8');
    const res = await buildTuneupCommand(ctx).run!('deep');
    expect(res!.runText).toContain('optimization');
    expect(readFileSync(globalConfig, 'utf8')).toBe(before); // deep never writes
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
