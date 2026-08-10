/**
 * System-prompt glossary block — tests the wiring on the
 * `DefaultSystemPromptBuilder` and the `renderDomainGlossary` helper.
 *
 * The block is sourced from a SAGE port by the host (CLI/TUI/WebUI),
 * not from `@wrongstack/sage-mcp`. The dependency inversion is the
 * point of the architectural rule referenced in
 * `packages/core/src/core/system-prompt-glossary.ts` — the core
 * package itself stays free of any `@wrongstack/sage` import. The
 * test confirms that a `MemoryStore`-shaped handle is sufficient.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MemoryEntry, MemoryStore } from '../../src/index.js';
import { DefaultSystemPromptBuilder, renderDomainGlossary } from '../../src/index.js';

function makeFakeMemory(entries: MemoryEntry[]): MemoryStore {
  const byQuery = (query: string): MemoryEntry[] =>
    entries.filter((e) => e.text.toLowerCase().includes(query.toLowerCase()));
  return {
    withTraceId: () => ({}) as unknown as MemoryStore,
    readAll: async () => entries.map((e) => `- ${e.text}`).join('\n'),
    read: async () => entries.map((e) => `- ${e.text}`).join('\n'),
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    list: async () => entries,
    search: async (query: string) => byQuery(query),
  };
}

describe('renderDomainGlossary (Project Jargon Dictionary)', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-glossary-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns null when the memory store is missing', async () => {
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, undefined);
    expect(text).toBeNull();
  });

  it('returns an empty string when no glossary entries exist', async () => {
    const mem = makeFakeMemory([
      {
        scope: 'project-memory',
        text: 'unrelated fact',
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['misc'],
      },
    ]);
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, mem);
    expect(text).toBe('');
  });

  it('renders the canonical heading and term/definition bullets', async () => {
    const mem = makeFakeMemory([
      {
        scope: 'project-memory',
        text: 'SddBoardProjector — runtime projection of the SDD plan board',
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['domain-term', 'glossary', 'project-jargon'],
        confidence: 0.9,
      },
      {
        scope: 'project-memory',
        text: 'TaskGraph — DAG of pending tasks the agent must complete',
        ts: '2026-08-10T00:00:01.000Z',
        tags: ['domain-term', 'glossary'],
        confidence: 0.7,
      },
    ]);
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, mem);
    expect(text).not.toBeNull();
    expect(text).toContain('Project Jargon Dictionary');
    expect(text).toContain('**SddBoardProjector** — runtime projection');
    expect(text).toContain('**TaskGraph** — DAG of pending tasks');
    expect(text).toContain('domain-terms.md');
    expect(text).toContain('`domain-term`');
  });

  it('orders higher-confidence terms first', async () => {
    const mem = makeFakeMemory([
      {
        scope: 'project-memory',
        text: 'Zeta — low confidence term',
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['domain-term'],
        confidence: 0.1,
      },
      {
        scope: 'project-memory',
        text: 'Alpha — high confidence term',
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['domain-term'],
        confidence: 0.95,
      },
    ]);
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, mem);
    expect(text).not.toBeNull();
    const alphaAt = (text as string).indexOf('**Alpha**');
    const zetaAt = (text as string).indexOf('**Zeta**');
    expect(alphaAt).toBeGreaterThanOrEqual(0);
    expect(zetaAt).toBeGreaterThan(alphaAt);
  });

  it('caps the bullet count to maxEntries', async () => {
    const mem = makeFakeMemory(
      Array.from({ length: 20 }, (_, i) => ({
        scope: 'project-memory' as const,
        text: `Term${i} — definition ${i}`,
        ts: `2026-08-10T00:00:0${i % 10}.000Z`,
        tags: ['domain-term'],
        confidence: 0.5,
      })),
    );
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, mem, {
      maxEntries: 3,
    });
    expect(text).not.toBeNull();
    const bullets = (text as string).split('\n').filter((l) => l.startsWith('-'));
    expect(bullets).toHaveLength(3);
  });

  it('truncates long definitions at maxEntryChars', async () => {
    const long = 'a'.repeat(500);
    const mem = makeFakeMemory([
      {
        scope: 'project-memory',
        text: `LongTerm — ${long}`,
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['domain-term'],
        confidence: 0.5,
      },
    ]);
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, mem, {
      maxEntryChars: 20,
    });
    expect(text).not.toBeNull();
    const bullet = (text as string).split('\n').find((l) => l.startsWith('-')) ?? '';
    // 80 chars max per bullet; well under 500.
    expect(bullet.length).toBeLessThan(120);
    expect(bullet).toContain('**LongTerm** — ');
  });

  it('falls back to term-only bullet when the entry has no definition', async () => {
    const mem = makeFakeMemory([
      {
        scope: 'project-memory',
        text: 'StandaloneTerm',
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['domain-term'],
        confidence: 0.5,
      },
    ]);
    const text = await renderDomainGlossary({ cwd: tmp, projectRoot: tmp, tools: [] }, mem);
    expect(text).not.toBeNull();
    expect(text).toContain('- **StandaloneTerm**');
  });
});

describe('DefaultSystemPromptBuilder with domainGlossary', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt-glossary-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('omits the glossary block when no domainGlossary is provided', async () => {
    const b = new DefaultSystemPromptBuilder({ todayIso: '2026-05-13' });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    expect(blocks.some((bl) => bl.text.includes('Project Jargon Dictionary'))).toBe(false);
  });

  it('appends the glossary block when domainGlossary is provided', async () => {
    const mem = makeFakeMemory([
      {
        scope: 'project-memory',
        text: 'MailboxBridge — external HTTP bridge for the inter-agent mailbox',
        ts: '2026-08-10T00:00:00.000Z',
        tags: ['domain-term'],
        confidence: 0.8,
      },
    ]);
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-05-13',
      domainGlossary: mem,
    });
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const joined = blocks.map((bl) => bl.text).join('\n');
    expect(joined).toContain('Project Jargon Dictionary');
    expect(joined).toContain('**MailboxBridge**');
  });

  it('does not throw when the memory store throws', async () => {
    const flaky: MemoryStore = {
      ...makeFakeMemory([]),
      list: async () => {
        throw new Error('disk on fire');
      },
    };
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-05-13',
      domainGlossary: flaky,
    });
    // Should not throw — the builder logs and continues without the block.
    const blocks = await b.build({ cwd: tmp, projectRoot: tmp, tools: [] });
    const joined = blocks.map((bl) => bl.text).join('\n');
    expect(joined).not.toContain('Project Jargon Dictionary');
  });
});
