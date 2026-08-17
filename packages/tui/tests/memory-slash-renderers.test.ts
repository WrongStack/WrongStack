import type { MemoryEntry, MemoryPort } from '@wrongstack/core/types';
import { SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import {
  computeStats,
  handleMemoryWrite,
  memErr,
  parseArgs,
  parseMemoryFlags,
  renderLegacyCompactList,
  renderLegacyEntry,
  renderLegacySummary,
  renderSageEntries,
  renderSageStats,
  sparkbar,
} from '../src/memory-slash-renderers.js';
import type { SageLike, SageStatsLike } from '../src/memory-slash-types.js';

const NOW = new Date('2026-08-17T12:00:00Z').getTime();
const DAY = 24 * 60 * 60 * 1000;

function iso(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    scope: 'project-memory',
    text: 'some memory text',
    ts: iso(1),
    ...overrides,
  } as MemoryEntry;
}

function sage(overrides: Partial<SageLike> = {}): SageLike {
  return {
    id: 'sage-1',
    kind: 'fact',
    status: 'active',
    text: 'A sage memory',
    tags: [],
    createdAt: iso(2),
    updatedAt: iso(2),
    importance: 0.5,
    confidence: 0.8,
    anchors: [],
    sources: [{ type: 'user' }],
    ...overrides,
  };
}

function sageStats(overrides: Partial<SageStatsLike> = {}): SageStatsLike {
  return {
    total: 0,
    byStatus: {},
    byKind: {},
    edges: 0,
    ...overrides,
  };
}

describe('computeStats', () => {
  it('counts scopes, types, priorities, tags, and sources', () => {
    const stats = computeStats(
      [
        entry({
          scope: 'project-agents',
          type: 'fact',
          priority: 'high',
          tags: ['a', 'b'],
          source: 'agent',
        }),
        entry({ type: 'fact', tags: ['a'], source: 'user' }),
        entry({ scope: 'user-memory' }),
      ],
      NOW,
    );
    expect(stats.total).toBe(3);
    expect(stats.perScope['project-agents']).toBe(1);
    expect(stats.perScope['project-memory']).toBe(1);
    expect(stats.perScope['user-memory']).toBe(1);
    expect(stats.perType['fact']).toBe(2);
    expect(stats.noTypeCount).toBe(1);
    expect(stats.perPriority['high']).toBe(1);
    expect(stats.noPriorityCount).toBe(2);
    expect(stats.tagCounts.get('a')).toBe(2);
    expect(stats.tagCounts.get('b')).toBe(1);
    expect([...stats.sources].sort()).toEqual(['agent', 'user']);
  });

  it('buckets recency by week/month/older and treats unparsable dates as older', () => {
    const stats = computeStats(
      [entry({ ts: iso(1) }), entry({ ts: iso(10) }), entry({ ts: iso(90) }), entry({ ts: 'not-a-date' })],
      NOW,
    );
    expect(stats.recency).toEqual({ week: 1, month: 1, older: 2 });
  });

  it('handles an empty inventory', () => {
    const stats = computeStats([], NOW);
    expect(stats.total).toBe(0);
    expect(stats.tagCounts.size).toBe(0);
    expect(stats.recency).toEqual({ week: 0, month: 0, older: 0 });
  });
});

describe('renderSageStats', () => {
  it('renders the status header, edge count, and non-zero kinds in order', () => {
    const lines = renderSageStats(
      sageStats({
        total: 10,
        byStatus: { active: 6, stale: 2, archived: 1, deleted: 1 },
        byKind: { decision: 4, fact: 6 },
        edges: 9,
      }),
      [],
    );
    const text = lines.join('\n');
    expect(text).toContain('**Total:** 10 memories');
    expect(text).toContain('🟢 6 active · 🟡 2 stale · 🔵 1 archived · ⚫ 1 deleted');
    expect(text).toContain('**Graph edges:** 9');
    expect(text).toContain('### 📊 By kind');
    const factIdx = text.indexOf('**fact**: 6');
    const decisionIdx = text.indexOf('**decision**: 4');
    expect(decisionIdx).toBeGreaterThan(-1);
    expect(factIdx).toBeLessThan(decisionIdx); // fact listed first in kind order
  });

  it('omits the kind section when no kinds are present', () => {
    const lines = renderSageStats(sageStats({ total: 0 }), []);
    expect(lines.join('\n')).not.toContain('By kind');
  });

  it('renders top tags sorted by count with the filter hint', () => {
    const lines = renderSageStats(
      sageStats({ total: 3 }),
      [sage({ tags: ['x'] }), sage({ tags: ['y', 'x'] }), sage({ tags: ['y', 'y'] })],
    );
    const text = lines.join('\n');
    expect(text).toContain('### 🏷️ Top tags');
    expect(text.indexOf('`y` ×2')).toBeLessThan(text.indexOf('`x` ×2'));
    expect(text).toContain('> Filter: `/memory --tag <tag>`');
  });

  it('renders the filtered view section when filters are provided', () => {
    const withTag = renderSageStats(sageStats(), [], 'build').join('\n');
    expect(withTag).toContain('### 🔍 Filtered view');
    expect(withTag).toContain('tag: `build`');

    const both = renderSageStats(sageStats(), [], 'build', 'src/a.ts').join('\n');
    expect(both).toContain('tag: `build`  ·  path: `src/a.ts`');
  });
});

describe('renderSageEntries', () => {
  it('returns nothing for an empty list', () => {
    expect(renderSageEntries([], false, NOW)).toEqual([]);
  });

  it('renders the compact table with tag ellipsis and a squashed 60-char preview', () => {
    const lines = renderSageEntries(
      [
        sage({ id: 'very-long-sage-identifier-1234', tags: ['t1', 't2', 't3', 't4'], text: '  spaced   out \n text '.repeat(6) }),
      ],
      true,
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain('| # | ID | Kind | Status | Tags | Text |');
    expect(text).toContain('`very-long-sage-i…`'); // id sliced to 15 chars
    expect(text).toContain('t1, t2, t3…');
    expect(text).not.toContain('t4');
    const row = lines.find((l) => l.startsWith('| 1 |'));
    expect(row).toBeDefined();
    expect(row).not.toContain('  '); // whitespace squashed inside the preview
  });

  it('renders the full view with badges, tags, and the first anchor', () => {
    const lines = renderSageEntries(
      [
        sage({
          id: 'm1',
          kind: 'decision',
          status: 'stale',
          importance: 0.9,
          confidence: 0.3,
          tags: ['arch'],
          anchors: [{ type: 'file' }, { type: 'symbol', path: 'src/a.ts', symbol: 'alpha' }],
        }),
      ],
      false,
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain('⚖️ **A sage memory**');
    expect(text).toContain('`m1` · `decision` · 🟡 stale · 📅');
    expect(text).toContain('⭐ important');
    expect(text).toContain('⚠️ low confidence');
    expect(text).toContain('🏷️ `arch`');
    expect(text).toContain('📎 `src/a.ts`');
  });

  it('falls back to neutral icons for unknown statuses and skips absent anchors', () => {
    const lines = renderSageEntries(
      [sage({ status: 'mysterious' as string })],
      false,
      NOW,
    );
    const text = lines.join('\n');
    expect(text).toContain('⚪ mysterious');
    expect(text).not.toContain('📎');
  });

  it('truncates text previews beyond 100 characters', () => {
    const long = 'L'.repeat(140);
    const text = renderSageEntries([sage({ text: long })], false, NOW).join('\n');
    expect(text).toContain(`${'L'.repeat(98)}…`);
    expect(text).not.toContain('L'.repeat(99));
  });
});

describe('renderLegacySummary', () => {
  it('renders only non-zero scope rows plus totals, type, priority, and recency tables', () => {
    const stats = computeStats(
      [
        entry({ scope: 'project-agents', type: 'decision', priority: 'critical', ts: iso(2) }),
        entry({ type: 'convention', priority: 'low', ts: iso(20) }),
        entry({ ts: iso(200) }),
      ],
      NOW,
    );
    const text = renderLegacySummary(stats).join('\n');
    expect(text).toContain('## 🗂️ Memory Overview (legacy)');
    expect(text).toContain('| 🤖 Project AGENTS.md | **1** |');
    expect(text).toContain('| 🧠 Project memory | **2** |');
    expect(text).not.toContain('User memory | **'); // zero scope omitted
    expect(text).toContain('| **Total** | **3** |');
    expect(text).toContain('**Decision**');
    expect(text).toContain('**Convention**');
    expect(text).toContain('*Uncategorized*: 1');
    expect(text).toContain('**critical**: 1');
    expect(text).toContain('*Unset*: 1');
    expect(text).toContain('| **< 7 days** | 1 |');
    expect(text).toContain('| **7–30 days** | 1 |');
    expect(text).toContain('| **> 30 days** | 1 |');
  });

  it('renders top tags and sorted sources when present', () => {
    const stats = computeStats(
      [entry({ tags: ['z', 'a'], source: 'beta' }), entry({ tags: ['a'], source: 'alpha' })],
      NOW,
    );
    const text = renderLegacySummary(stats).join('\n');
    expect(text).toContain('### 🏷️ Top tags');
    expect(text.indexOf('`a` ×2')).toBeLessThan(text.indexOf('`z` ×1'));
    expect(text).toContain('*Sources: alpha, beta*');
  });
});

describe('renderLegacyEntry', () => {
  it('renders badges only when present', () => {
    const text = renderLegacyEntry(entry({ type: 'fact', priority: 'high', confidence: 0.9 }), NOW);
    expect(text).toContain('📌 **some memory text**');
    expect(text).toContain('`Fact` · 🟠 high · 📅');
    expect(text).not.toContain('low confidence');

    const bare = renderLegacyEntry(entry(), NOW);
    expect(bare).toContain('• **some memory text**');
    expect(bare).toContain('📅');
    expect(bare).not.toContain('`Fact`');
  });

  it('marks low confidence, tags, and first-line previews', () => {
    const text = renderLegacyEntry(
      entry({ confidence: 0.4, tags: ['t1', 't2'], text: 'first line\nsecond line' }),
      NOW,
    );
    expect(text).toContain('⚠️ low confidence');
    expect(text).toContain('🏷️ `t1` `t2`');
    expect(text).toContain('first line');
    expect(text).not.toContain('second line');
  });

  it('truncates previews beyond 100 characters', () => {
    const text = renderLegacyEntry(entry({ text: 'L'.repeat(140) }), NOW);
    expect(text).toContain(`${'L'.repeat(98)}…`);
  });
});

describe('renderLegacyCompactList', () => {
  it('returns nothing for empty input', () => {
    expect(renderLegacyCompactList([])).toEqual([]);
  });

  it('renders table rows with dash placeholders and tag ellipsis', () => {
    const lines = renderLegacyCompactList([
      entry({ type: 'fact', priority: 'high', tags: ['a', 'b', 'c', 'd'] }),
      entry({ text: 'no   extra   whitespace' }),
    ]);
    const text = lines.join('\n');
    expect(text).toContain('| # | Date | Type | Priority | Tags | Preview |');
    expect(text).toContain('a, b, c…');
    expect(text).toContain('no extra whitespace');
    expect(text).toMatch(/—.*—/s); // type/priority dashes on the bare row
  });
});

describe('sparkbar', () => {
  it('is empty for zero value or zero total', () => {
    expect(sparkbar(0, 10)).toBe('');
    expect(sparkbar(5, 0)).toBe('');
  });

  it('scales to at least one block and caps at ten', () => {
    expect(sparkbar(1, 1000)).toBe('█');
    expect(sparkbar(50, 100)).toBe('█████');
    expect(sparkbar(100, 100)).toBe('██████████');
    expect(sparkbar(96, 100)).toBe('██████████'); // rounds to 10
  });
});

describe('parseArgs', () => {
  it('parses tag, path, limit, and compact flags', () => {
    const parsed = parseArgs('search terms --tag build --path src/a.ts --limit 7 --compact');
    expect(parsed.tag).toBe('build');
    expect(parsed.path).toBe('src/a.ts');
    expect(parsed.limit).toBe(7);
    expect(parsed.compact).toBe(true);
    expect(parsed.positional).toBe('search terms');
  });

  it('keeps defaults when flags are absent', () => {
    const parsed = parseArgs('  plain query  ');
    expect(parsed.compact).toBe(false);
    expect(parsed.limit).toBe(50);
    expect(parsed.positional).toBe('plain query');
    expect(parsed.tag).toBeUndefined();
  });

  it('clamps the limit into [1, 500] and ignores invalid limits', () => {
    expect(parseArgs('--limit 9999').limit).toBe(500);
    expect(parseArgs('--limit 1').limit).toBe(1);
    expect(parseArgs('--limit 0').limit).toBe(50);
    expect(parseArgs('--limit abc').limit).toBe(50);
  });
});

describe('parseMemoryFlags', () => {
  it('collects words and text flags into the final text', () => {
    const parsed = parseMemoryFlags(['uses', 'pnpm', '--text', 'workspace']);
    expect(parsed.text).toBe('uses pnpm workspace');
    expect(parsed.errors).toEqual([]);
  });

  it('validates kind, scope, and status against allow-lists', () => {
    const ok = parseMemoryFlags(['--kind', 'fact', '--scope', 'user', '--status', 'stale']);
    expect(ok.kind).toBe('fact');
    expect(ok.scope).toBe('user');
    expect(ok.status).toBe('stale');

    const bad = parseMemoryFlags(['--kind', 'nope', '--scope', 'nope', '--status', 'nope']);
    expect(bad.errors.join('\n')).toContain('--kind must be one of:');
    expect(bad.errors.join('\n')).toContain('--scope must be one of:');
    expect(bad.errors.join('\n')).toContain('--status must be one of:');
  });

  it('parses tag, anchor, symbol, and command anchors', () => {
    const parsed = parseMemoryFlags([
      '--tag',
      'a,b',
      '--tags',
      'c',
      '--anchor',
      'src/a.ts',
      '--file',
      'src/b.ts',
      '--symbol',
      'src/a.ts#alpha',
      '--command',
      'pnpm build',
    ]);
    expect(parsed.tags).toEqual(['a', 'b', 'c']);
    expect(parsed.anchors).toEqual([
      { type: 'file', path: 'src/a.ts' },
      { type: 'file', path: 'src/b.ts' },
      { type: 'symbol', path: 'src/a.ts', symbol: 'alpha' },
      { type: 'command', command: 'pnpm build' },
    ]);
  });

  it('rejects malformed symbol anchors and missing values', () => {
    const parsed = parseMemoryFlags([
      '--symbol',
      'nohash',
      '--symbol',
      '#leading',
      '--symbol',
      'trail#',
      '--symbol',
      '--anchor',
      '--command',
      '--tag',
    ]);
    expect(parsed.errors).toHaveLength(7);
    expect(parsed.errors.join('\n')).toContain('--symbol must be path#SymbolName.');
    expect(parsed.errors.join('\n')).toContain('--anchor needs a file path.');
    expect(parsed.errors.join('\n')).toContain('--command needs a value.');
    expect(parsed.errors.join('\n')).toContain('--tag needs a value');
  });

  it('validates numeric flags in [0, 1]', () => {
    const ok = parseMemoryFlags(['--importance', '0.8', '--confidence', '0.2', '--freshness', '1']);
    expect(ok.importance).toBeCloseTo(0.8);
    expect(ok.confidence).toBeCloseTo(0.2);
    expect(ok.freshness).toBe(1);

    const bad = parseMemoryFlags(['--importance', '1.5', '--confidence', 'x', '--freshness']);
    expect(bad.errors.join('\n')).toContain('--importance must be a number between 0 and 1 (got "1.5").');
    expect(bad.errors.join('\n')).toContain('--confidence must be a number between 0 and 1 (got "x").');
    expect(bad.errors.join('\n')).toContain('--freshness needs a value between 0 and 1.');
  });

  it('collects supersedes, contradicts, and rejects unknown flags', () => {
    const parsed = parseMemoryFlags(['--supersedes', 'a,b', '--contradicts', 'c', '--bogus']);
    expect(parsed.supersedes).toEqual(['a', 'b']);
    expect(parsed.contradicts).toEqual(['c']);
    expect(parsed.errors).toEqual(['Unknown flag "--bogus".']);
  });
});

describe('memErr', () => {
  it('unwraps Error messages and stringifies everything else', () => {
    expect(memErr(new Error('boom'))).toBe('boom');
    expect(memErr('plain string')).toBe('plain string');
    expect(memErr(42)).toBe('42');
  });
});

describe('handleMemoryWrite', () => {
  function sageSurface(overrides: Record<string, ReturnType<typeof vi.fn>> = {}) {
    return {
      rememberSage: vi.fn(async (input: Record<string, unknown>) => ({
        id: 'sage-9',
        kind: 'fact',
        status: 'active',
        text: 'A sage memory',
        tags: [],
        createdAt: iso(0),
        updatedAt: iso(0),
        importance: 0.5,
        confidence: 0.8,
        anchors: [],
        sources: [],
        ...input,
      })),
      updateSage: vi.fn(async (id: string) => ({
        id,
        kind: 'decision',
        status: 'stale',
        text: 'updated text',
        tags: [],
        createdAt: iso(0),
        updatedAt: iso(0),
        importance: 0.5,
        confidence: 0.8,
        anchors: [],
        sources: [],
      })),
      getSage: vi.fn(async () => sage()),
      deleteSage: vi.fn(async () => {}),
      ...overrides,
    };
  }

  function storeWith(surface: unknown) {
    return {
      getCapability: (cap: unknown) => (cap === SAGE_SURFACE_CAPABILITY ? surface : undefined),
    } as unknown as MemoryPort;
  }

  function legacyStore() {
    return {
      getCapability: () => undefined,
      remember: vi.fn(async () => {}),
      forget: vi.fn(async () => 2),
    } as unknown as MemoryPort;
  }

  it('prints usage for a bare remember', async () => {
    const out = await handleMemoryWrite(storeWith(sageSurface()), 'remember', []);
    expect(out.message).toContain('Usage: /memory remember');
  });

  it('falls back to the legacy store when no SAGE surface exists', async () => {
    const store = legacyStore();
    const out = await handleMemoryWrite(store, 'remember', ['legacy', 'note']);
    expect(out.message).toBe('Remembered: legacy note');
    expect(store.remember).toHaveBeenCalledWith('legacy note');
  });

  it('rejects an empty legacy remember', async () => {
    const out = await handleMemoryWrite(legacyStore(), 'remember', ['   ']);
    expect(out.message).toBe('Usage: /memory remember <text>');
  });

  it('returns flag errors from remember before touching the store', async () => {
    const surface = sageSurface();
    const out = await handleMemoryWrite(storeWith(surface), 'remember', ['--kind', 'bogus']);
    expect(out.message).toContain('Cannot remember:');
    expect(surface.rememberSage).not.toHaveBeenCalled();
  });

  it('refuses a remember with flags but no text', async () => {
    const out = await handleMemoryWrite(storeWith(sageSurface()), 'remember', ['--kind', 'fact']);
    expect(out.message).toContain('Nothing to remember');
  });

  it('remembers through the SAGE surface and echoes id, kind, and tags', async () => {
    const surface = sageSurface();
    const out = await handleMemoryWrite(
      storeWith(surface),
      'remember',
      ['uses pnpm', '--kind', 'decision', '--tag', 'build,tooling'],
    );
    expect(out.message).toContain('Remembered `sage-9` [decision] uses pnpm #build #tooling');
    expect(surface.rememberSage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'uses pnpm', kind: 'decision', tags: ['build', 'tooling'] }),
    );
  });

  it('surfaces rememberSage failures', async () => {
    const surface = sageSurface({
      rememberSage: vi.fn(async () => {
        throw new Error('db locked');
      }),
    });
    const out = await handleMemoryWrite(storeWith(surface), 'remember', ['text here']);
    expect(out.message).toBe('Could not remember: db locked');
  });

  it('requires SAGE for non-remember subcommands', async () => {
    const out = await handleMemoryWrite(legacyStore(), 'update', ['id1']);
    expect(out.message).toContain('requires the SAGE backend');
  });

  it('prints update usage without an id and rejects empty patches', async () => {
    const surface = sageSurface();
    const noId = await handleMemoryWrite(storeWith(surface), 'update', []);
    expect(noId.message).toContain('Usage: /memory update');

    const noPatch = await handleMemoryWrite(storeWith(surface), 'update', ['sage-9']);
    expect(noPatch.message).toContain('Nothing to update');
  });

  it('applies an update patch built from flags', async () => {
    const surface = sageSurface();
    const out = await handleMemoryWrite(
      storeWith(surface),
      'edit',
      ['sage-9', '--text', 'new text', '--status', 'stale', '--importance', '0.9'],
    );
    expect(out.message).toContain('Updated `sage-9`');
    expect(surface.updateSage).toHaveBeenCalledWith(
      'sage-9',
      expect.objectContaining({ text: 'new text', status: 'stale', importance: 0.9 }),
    );
  });

  it('returns update flag errors verbatim', async () => {
    const out = await handleMemoryWrite(storeWith(sageSurface()), 'update', ['id', '--status', 'nope']);
    expect(out.message).toContain('Cannot update:');
  });

  it('surfaces updateSage failures', async () => {
    const surface = sageSurface({
      updateSage: vi.fn(async () => {
        throw new Error('readonly');
      }),
    });
    const out = await handleMemoryWrite(storeWith(surface), 'update', ['id', '--text', 'x']);
    expect(out.message).toBe('Could not update: readonly');
  });

  it('deletes with force after confirming the memory exists', async () => {
    const surface = sageSurface();
    const out = await handleMemoryWrite(storeWith(surface), 'delete', ['sage-9', 'obsolete']);
    expect(out.message).toBe('Deleted `sage-9`.');
    expect(surface.deleteSage).toHaveBeenCalledWith('sage-9', 'obsolete', { force: true });
  });

  it('prints delete usage without an id and reports unknown ids', async () => {
    const noId = await handleMemoryWrite(storeWith(sageSurface()), 'delete', []);
    expect(noId.message).toContain('Usage: /memory delete');

    const surface = sageSurface({ getSage: vi.fn(async () => null) });
    const missing = await handleMemoryWrite(storeWith(surface), 'del', ['ghost']);
    expect(missing.message).toContain('No memory with id `ghost`');
  });

  it('surfaces deleteSage failures', async () => {
    const surface = sageSurface({
      deleteSage: vi.fn(async () => {
        throw new Error('pinned');
      }),
    });
    const out = await handleMemoryWrite(storeWith(surface), 'delete', ['id']);
    expect(out.message).toBe('Could not delete: pinned');
  });

  // The forget path sits behind the SAGE gate, so store.forget is only
  // reached when a surface exists — the surface itself is not used for it.
  function forgettingStore(removed: number | Error) {
    return {
      getCapability: () => sageSurface(),
      forget: vi.fn(async () => {
        if (removed instanceof Error) throw removed;
        return removed;
      }),
    } as unknown as MemoryPort;
  }

  it('forgets entries with singular and plural counts', async () => {
    const plural = await handleMemoryWrite(forgettingStore(2), 'forget', ['old', 'stuff']);
    expect(plural.message).toBe('Forgot 2 entries.');

    const single = await handleMemoryWrite(forgettingStore(1), 'rm', ['one']);
    expect(single.message).toBe('Forgot 1 entry.');
  });

  it('prints forget usage for an empty query and reports no matches', async () => {
    const usage = await handleMemoryWrite(forgettingStore(0), 'forget', []);
    expect(usage.message).toBe('Usage: /memory forget <query>');

    const none = await handleMemoryWrite(forgettingStore(0), 'forget', ['nothing']);
    expect(none.message).toBe('No entries matched "nothing".');
  });

  it('surfaces forget failures', async () => {
    const out = await handleMemoryWrite(forgettingStore(new Error('store down')), 'forget', ['q']);
    expect(out.message).toBe('Could not forget: store down');
  });
});
