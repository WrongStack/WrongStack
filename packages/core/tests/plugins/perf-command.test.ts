import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/index.js';
import { PERF_MODES } from '../../src/performance/perf-modes.js';
import {
  buildPerfCommand,
  buildPerfRunText,
  parsePerfArgs,
} from '../../src/plugins/perf-command.js';
import type { PromptUsageStore } from '../../src/storage/prompt-usage-store.js';
import type { PromptEntry, PromptLoader } from '../../src/types/prompt.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-perfcmd-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

let sessionSeq = 0;

/**
 * A context the subagent-policy writer accepts. The mutating modes flip
 * `subagentsAllowed` off, which needs `meta`, an unlocked message list, and a
 * session writer — the same shape `/bughunt` requires.
 */
const ctx = (over: Record<string, unknown> = {}): Context => {
  sessionSeq += 1;
  return {
    model: 'm',
    projectRoot: dir,
    cwd: dir,
    messages: [],
    meta: {},
    session: { id: `perf-session-${sessionSeq}`, append: vi.fn(async () => undefined) },
    ...over,
  } as never as Context;
};

function entryFor(slug: string): PromptEntry {
  return {
    id: slug,
    slug,
    title: slug,
    description: '',
    content: `PROMPT BODY for ${slug}`,
    category: 'performance',
    tags: [],
    source: 'builtin',
    favorite: false,
    checksum: 'x',
    createdAt: '',
    updatedAt: '',
  } as never as PromptEntry;
}

function fakeLoader(known: Set<string> = new Set(Object.values(PERF_MODES).map((m) => m.slug))) {
  return {
    find: async (slug: string) => (known.has(slug) ? entryFor(slug) : undefined),
  } as never as PromptLoader;
}

function fakeUsage(): { store: PromptUsageStore; recorded: string[] } {
  const recorded: string[] = [];
  return {
    store: {
      record: async (slug: string) => {
        recorded.push(slug);
      },
    } as never as PromptUsageStore,
    recorded,
  };
}

describe('parsePerfArgs', () => {
  it('defaults to the ratchet — the mode that actually changes code', () => {
    const parsed = parsePerfArgs('');
    expect(parsed.mode).toBe('ratchet');
    expect(parsed.target).toBe('');
    expect(parsed.noStack).toBe(false);
  });

  it('reads a leading mode', () => {
    expect(parsePerfArgs('audit').mode).toBe('audit');
    expect(parsePerfArgs('io packages/sage').mode).toBe('io');
    expect(parsePerfArgs('io packages/sage').target).toBe('packages/sage');
  });

  it('treats a leading non-mode token as the target', () => {
    const parsed = parsePerfArgs('packages/sage the search path');
    expect(parsed.mode).toBe('ratchet');
    expect(parsed.target).toBe('packages/sage the search path');
  });

  it('accepts --scope= as a synonym for the positional target', () => {
    expect(parsePerfArgs('cpu --scope=packages/tui').target).toBe('packages/tui');
  });

  it('accepts a known metric and reports an unknown one instead of ignoring it', () => {
    expect(parsePerfArgs('--metric=peak-rss-bytes').metric).toBe('peak-rss-bytes');
    const bad = parsePerfArgs('--metric=vibes');
    expect(bad.metric).toBeUndefined();
    expect(bad.badMetric).toBe('vibes');
  });

  it('recognises log and help', () => {
    expect(parsePerfArgs('log').mode).toBe('log');
    expect(parsePerfArgs('help').mode).toBe('help');
    expect(parsePerfArgs('--help').mode).toBe('help');
  });

  it('does not swallow flags into the target', () => {
    const parsed = parsePerfArgs('memory packages/core --no-stack --metric=allocs-per-op');
    expect(parsed.target).toBe('packages/core');
    expect(parsed.noStack).toBe(true);
    expect(parsed.metric).toBe('allocs-per-op');
  });
});

describe('buildPerfRunText', () => {
  it('keeps the prompt contract first and the narrowing after it', () => {
    const text = buildPerfRunText('CONTRACT', { target: 'packages/sage' });
    expect(text.indexOf('CONTRACT')).toBeLessThan(text.indexOf('User-selected target'));
    expect(text).toContain('packages/sage');
  });

  it('spells out the metric and its direction', () => {
    const text = buildPerfRunText('CONTRACT', { metric: 'throughput-ops' });
    expect(text).toContain('Throughput');
    expect(text).toContain('higher is better');
  });

  it('ignores an unknown metric rather than emitting a broken section', () => {
    expect(buildPerfRunText('CONTRACT', { metric: 'vibes' })).toBe('CONTRACT');
  });

  it('appends stack guidance last', () => {
    const text = buildPerfRunText('CONTRACT', { target: 't', stackGuidance: 'STACK' });
    expect(text.trimEnd().endsWith('STACK')).toBe(true);
  });
});

describe('/perf', () => {
  it('sends the ratchet prompt and disables subagents for a mutating round', async () => {
    const usage = fakeUsage();
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => usage.store,
    );
    const session = { id: 'perf-ratchet-session', append: vi.fn(async () => undefined) };
    const out = await cmd.run!('packages/sage', ctx({ session }));
    expect(out?.runText).toContain('PROMPT BODY for elite-performance-ratchet');
    expect(out?.runText).toContain('packages/sage');
    expect(out?.message).toContain('Ratchet loop started for: packages/sage');
    expect(usage.recorded).toEqual(['elite-performance-ratchet']);
    // A ratchet round attributes one measured delta to one change; fanning it
    // across subagents would make that attribution undefendable.
    expect(session.append).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'subagent_policy', allowed: false }),
    );
  });

  it('leaves the subagent policy alone for a read-only mode', async () => {
    const session = { id: 'perf-audit-session', append: vi.fn(async () => undefined) };
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => null,
    );
    const out = await cmd.run!('audit', ctx({ session }));
    expect(out?.runText).toContain('performance-baseline-audit');
    expect(session.append).not.toHaveBeenCalled();
  });

  it('refuses a mutating round once the session policy is locked', async () => {
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => null,
    );
    const out = await cmd.run!(
      '',
      ctx({
        messages: [{ role: 'user', content: 'already started' }],
        session: { id: 'perf-locked', append: vi.fn(async () => undefined) },
      }),
    );
    expect(out?.runText).toBeUndefined();
    expect(out?.message).toContain('could not start');
  });

  it('injects the detected profiling commands for the project', async () => {
    await fs.writeFile(path.join(dir, 'go.mod'), 'module x\n');
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => null,
    );
    const out = await cmd.run!('cpu', ctx());
    expect(out?.runText).toContain('Profiling commands for this repository');
    expect(out?.runText).toContain('pprof');
  });

  it('omits the stack block when asked', async () => {
    await fs.writeFile(path.join(dir, 'go.mod'), 'module x\n');
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => null,
    );
    const out = await cmd.run!('cpu --no-stack', ctx());
    expect(out?.runText).not.toContain('Profiling commands');
  });

  it('rejects an unknown metric with the list of valid ones', async () => {
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => null,
    );
    const out = await cmd.run!('--metric=vibes', ctx());
    expect(out?.message).toContain('Unknown metric "vibes"');
    expect(out?.runText).toBeUndefined();
  });

  it('reports a missing builtin prompt instead of sending an empty round', async () => {
    const cmd = buildPerfCommand(
      () => fakeLoader(new Set()),
      () => null,
    );
    const out = await cmd.run!('audit', ctx());
    expect(out?.message).toContain('is unavailable');
    expect(out?.runText).toBeUndefined();
  });

  it('reports an unavailable prompt library', async () => {
    const cmd = buildPerfCommand(
      () => null,
      () => null,
    );
    expect((await cmd.run!('', ctx()))?.message).toContain('not available');
  });

  it('survives a usage store that throws — tracking never blocks a round', async () => {
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () =>
        ({
          record: async () => {
            throw new Error('disk full');
          },
        }) as never as PromptUsageStore,
    );
    expect((await cmd.run!('triage', ctx()))?.runText).toContain('PROMPT BODY');
  });

  it('prints help without calling the model', async () => {
    const cmd = buildPerfCommand(
      () => fakeLoader(),
      () => null,
    );
    const out = await cmd.run!('help', ctx());
    expect(out?.message).toContain('Modes:');
    expect(out?.message).toContain('/perf ratchet');
    expect(out?.runText).toBeUndefined();
  });

  describe('/perf log', () => {
    it('points at the first round when there is no ledger', async () => {
      const cmd = buildPerfCommand(
        () => fakeLoader(),
        () => null,
      );
      const out = await cmd.run!('log', ctx());
      expect(out?.message).toContain('No PERF_LOG.md in this project yet');
      expect(out?.runText).toBeUndefined();
    });

    it('summarises the ledger deterministically, with no model call', async () => {
      await fs.writeFile(
        path.join(dir, 'PERF_LOG.md'),
        [
          '# PERF_LOG',
          '',
          '## 2026-09-01 — parser throughput',
          'baseline: 412ms median',
          '',
          '- [KEPT]     preallocate slice → 388ms (-6%)',
          '- [REVERTED] sorted lookup     → within noise',
          '',
          'current:  388ms median',
        ].join('\n'),
      );
      const out = await cmd().run!('log', ctx());
      expect(out?.message).toContain('1 round(s)');
      expect(out?.message).toContain('1 kept / 1 reverted');
      expect(out?.message).toContain('388ms median');
      expect(out?.runText).toBeUndefined();
    });

    it('says so when the ledger exists but records nothing', async () => {
      await fs.writeFile(path.join(dir, 'PERF_LOG.md'), '# PERF_LOG\n\nnothing yet\n');
      expect((await cmd().run!('log', ctx()))?.message).toContain('records no rounds yet');
    });

    function cmd() {
      return buildPerfCommand(
        () => fakeLoader(),
        () => null,
      );
    }
  });
});
