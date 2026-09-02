/**
 * SageDomainTermExtractor — focused contract tests.
 *
 * Why these tests exist:
 *
 *   The extractor is the only piece of code that decides "is this
 *   phrase project jargon?". If its heuristics drift (false positives
 *   pollute the prompt, false negatives drop legit terms), every
 *   downstream consumer — system prompt, `.wrongstack/domain-terms.md`,
 *   SAGE search results — silently breaks. So the tests cover the
 *   five surfaces that have independent failure modes:
 *
 *     1. Conversation extraction — accepts jargon, rejects stop-list
 *        and acronym noise, merges evidence.
 *     2. Persist via typed surface — happy path, dedupe vs existing
 *        memory, overwrite-off vs overwrite-on branches.
 *     3. The Markdown mirror — derives from SAGE; survives deletion of
 *        existing terms.
 *     4. The prompt block — compact form, escapes markdown, clamps
 *        to the cap.
 *     5. Port-shape guard — non-SAGE MemoryPort is a clean skip, not a
 *        crash. This protects the architectural rule that in-process
 *        consumers always pass a SAGE port.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MemoryPort } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  DOMAIN_TERM_LOOKUP_TAG,
  DOMAIN_TERMS_FILENAME,
  normalizeTerm,
  SageDomainTermExtractor,
} from '../src/domain-term-extractor.js';
import type { Sage } from '../src/types.js';

interface MutableSurface {
  rememberSage: (input: {
    text: string;
    summary?: string | undefined;
    kind?: string | undefined;
    scope?: string | undefined;
    tags?: string[] | undefined;
    confidence?: number | undefined;
    importance?: number | undefined;
    anchors?: unknown[] | undefined;
    sources?: unknown[] | undefined;
  }) => Promise<Sage>;
  updateSage: (
    id: string,
    patch: {
      text?: string | undefined;
      tags?: string[] | undefined;
      kind?: string | undefined;
      confidence?: number | undefined;
      importance?: number | undefined;
    },
  ) => Promise<Sage>;
  searchSage: (query: string, options?: { limit?: number; tags?: string[] }) => Promise<Sage[]>;
}

function makeFakeSurface(initial: Sage[] = []): { surface: MutableSurface; store: () => Sage[] } {
  const rows: Sage[] = [...initial];
  const surface: MutableSurface = {
    searchSage: async (_q, _opts) => rows.slice(),
    rememberSage: async (input) => {
      const id = `mem_${rows.length + 1}`;
      const now = new Date().toISOString();
      const row: Sage = {
        id,
        revision: 1,
        text: input.text,
        summary: input.summary,
        kind: (input.kind as Sage['kind']) ?? 'fact',
        scope: (input.scope as Sage['scope']) ?? 'project',
        status: 'active',
        confidence: input.confidence ?? 0.5,
        importance: input.importance ?? 0.5,
        freshness: 1,
        tags: input.tags ?? [],
        anchors: (input.anchors as Sage['anchors']) ?? [],
        sources: (input.sources as Sage['sources']) ?? [],
        createdAt: now,
        updatedAt: now,
      };
      rows.push(row);
      return row;
    },
    updateSage: async (id, patch) => {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`not found: ${id}`);
      if (patch.text !== undefined) row.text = patch.text;
      if (patch.tags !== undefined) row.tags = patch.tags;
      if (patch.kind !== undefined) row.kind = patch.kind as Sage['kind'];
      if (patch.confidence !== undefined) row.confidence = patch.confidence;
      if (patch.importance !== undefined) row.importance = patch.importance;
      row.updatedAt = new Date().toISOString();
      return row;
    },
  };
  return { surface, store: () => rows };
}

function makeFakePort(surface: MutableSurface): MemoryPort {
  // Use a minimal object; the extractor only goes through
  // getSageSurface, never on the bare MemoryStore shape, so the
  // MemoryStore-shaped methods can be stubbed no-ops. `as never`
  // keeps the `MemoryCapability<T>` contract (T | undefined) intact
  // without forcing the test to know about the SAGE surface type.
  return {
    initialize: async () => {},
    getCapability: () => surface as never,
    health: async () => ({ status: 'ready' as const, backend: 'fake' }),
    dispose: async () => {},
    withTraceId: () => ({}) as unknown as MemoryPort,
    readAll: async () => '',
    read: async () => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    list: async () => [],
    search: async () => [],
  };
}

describe('SageDomainTermExtractor — detection', () => {
  const ex = new SageDomainTermExtractor();

  it('recognises back-ticked, bolded, and PascalCase identifiers in conversation', () => {
    const result = ex.extractFromConversation({
      messages: [
        {
          role: 'user',
          text: 'We should hook the `MailboxBridge` to `ProjectSageMemoryPort`. The **SddBoardProjector** owns the kanban flow, and TaskGraph is the dependency structure.',
        },
      ],
    });
    const names = result.map((r) => r.term).sort();
    expect(names).toContain('MailboxBridge');
    expect(names).toContain('ProjectSageMemoryPort');
    expect(names).toContain('SddBoardProjector');
    expect(names).toContain('TaskGraph');
  });

  it('captures inline "TERM is DEFINITION" hints as the definition field', () => {
    const result = ex.extractFromConversation({
      messages: [
        {
          role: 'user',
          text: '`SddBoardProjector` is the runtime projection of the kanban board for the host agent.',
        },
      ],
    });
    const found = result.find((r) => r.term === 'SddBoardProjector');
    expect(found).toBeDefined();
    expect(found?.definition).toContain('runtime projection');
  });

  it('captures definitions after question-mark sentence boundaries', () => {
    const result = ex.extractFromConversation({
      messages: [
        {
          role: 'user',
          text: 'What is TaskGraph? TaskGraph is the dependency graph that orders tool calls.',
        },
      ],
    });
    const found = result.find((r) => r.term === 'TaskGraph');
    expect(found).toBeDefined();
    expect(found?.definition).toContain('dependency graph');
  });

  it('captures definitions after exclamation-mark sentence boundaries', () => {
    const result = ex.extractFromConversation({
      messages: [
        {
          role: 'user',
          text: 'Be careful with that! SddBoardProjector is the runtime projection of the kanban board.',
        },
      ],
    });
    const found = result.find((r) => r.term === 'SddBoardProjector');
    expect(found).toBeDefined();
    expect(found?.definition).toContain('runtime projection');
  });

  it('does not attach definitions from YAML/config colon keys', () => {
    const result = ex.extractFromConversation({
      messages: [
        {
          role: 'user',
          text: '`fallbackModels` is configured in the profile.\nfallbackModels: empty\n',
        },
      ],
      minConfidence: 0.3,
    });
    const term = result.find((r) => r.term === 'fallbackModels');
    if (term) {
      expect(term.definition).not.toContain('empty');
    }
  });

  it('does not attach definitions from TypeScript annotation colons', () => {
    const result = ex.extractFromConversation({
      messages: [
        { role: 'user', text: 'const span: Span | undefined) imports every named type.\n' },
      ],
      minConfidence: 0.3,
    });
    const term = result.find((r) => r.term === 'Span');
    if (term) {
      expect(term.definition).not.toContain('undefined)');
    }
  });

  it('does not attach definitions from code-comment colons', () => {
    const result = ex.extractFromConversation({
      messages: [
        {
          role: 'user',
          text: '`requireKanbanGovernance`: true, // Kanban tracks work; it does not gate it\n',
        },
      ],
      minConfidence: 0.3,
    });
    const term = result.find((r) => r.term === 'requireKanbanGovernance');
    if (term) {
      expect(term.definition).not.toContain('true,');
    }
  });

  it('rejects common English stop-list words and pure acronyms', () => {
    const result = ex.extractFromConversation({
      messages: [
        { role: 'user', text: 'The system reads a file and writes to the project. OK. HTTP. URL.' },
      ],
      minConfidence: 0.3,
    });
    const names = result.map((r) => r.term.toLowerCase());
    expect(names).not.toContain('the');
    expect(names).not.toContain('system');
    expect(names).not.toContain('file');
    expect(names).not.toContain('http');
    expect(names).not.toContain('ok');
  });

  it('merges duplicate terms from multiple messages into a single record', () => {
    const result = ex.extractFromConversation({
      messages: [
        { role: 'user', text: '`TaskGraph` holds task dependencies.' },
        { role: 'agent', text: 'I will inspect the TaskGraph for `TaskGraph` conflicts.' },
      ],
    });
    const graphMatches = result.filter((r) => r.term === 'TaskGraph');
    expect(graphMatches).toHaveLength(1);
    expect(graphMatches[0]?.sources).toEqual(expect.arrayContaining(['user', 'agent']));
  });
});

describe('SageDomainTermExtractor — persistence (disabled)', () => {
  // Domain-term persistence was removed because the `domain-term` tag
  // polluted the SAGE corpus with auto-generated entries that were
  // indistinguishable from genuine project facts. The extractor now
  // only writes the in-memory `ExtractedTerm[]` to the
  // `.wrongstack/domain-terms.md` mirror; `persistVia` is a stable
  // no-op that returns a `skipped` outcome for every term so the
  // existing call sites and report shape are preserved.

  const PERSIST_DISABLED_REASON = 'memory persistence disabled (domain-term tagging removed)';
  const ex = new SageDomainTermExtractor();

  it('returns a skipped report for every term and never touches SAGE', async () => {
    const { surface, store } = makeFakeSurface();
    const report = await ex.persistVia(makeFakePort(surface), [
      {
        term: 'SddBoardProjector',
        definition: 'runtime projection of the kanban board',
        confidence: 0.7,
        mentionCount: 1,
        evidence: [],
        sources: ['user'],
      },
      {
        term: 'TaskGraph',
        definition: 'DAG of pending tasks',
        confidence: 0.6,
        mentionCount: 1,
        evidence: [],
        sources: ['agent'],
      },
    ]);
    expect(report.added).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(2);
    expect(report.outcomes).toHaveLength(2);
    for (const outcome of report.outcomes) {
      expect(outcome.action).toBe('skipped');
      expect(outcome.reason).toBe(PERSIST_DISABLED_REASON);
      expect(outcome.memoryId).toBeUndefined();
    }
    // Critical: the surface must be untouched. No `rememberSage` /
    // `updateSage` should be called by `persistVia`.
    expect(store()).toHaveLength(0);
  });

  it('ignores minConfidence — every term is still reported as skipped', async () => {
    const { surface, store } = makeFakeSurface();
    const report = await ex.persistVia(
      makeFakePort(surface),
      [
        {
          term: 'NoisyTerm',
          definition: '',
          confidence: 0.1,
          mentionCount: 1,
          evidence: [],
          sources: ['user'],
        },
      ],
      { minConfidence: 0.9 },
    );
    expect(report.added).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.outcomes[0]?.reason).toBe(PERSIST_DISABLED_REASON);
    expect(store()).toHaveLength(0);
  });

  it('ignores overwriteExisting — the store is still untouched', async () => {
    const existing = makeFakeSage('mem_existing', 'SddBoardProjector — old', 0.6);
    const { surface, store } = makeFakeSurface([existing]);
    const report = await ex.persistVia(
      makeFakePort(surface),
      [
        {
          term: 'SddBoardProjector',
          definition: 'runtime projection of the kanban board',
          confidence: 0.9,
          mentionCount: 1,
          evidence: [],
          sources: ['user'],
        },
      ],
      { overwriteExisting: true },
    );
    expect(report.added).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    // The pre-existing memory is still present, untouched, with its
    // original text — the migration command is the only path that
    // should remove it.
    expect(store()).toHaveLength(1);
    expect(store()[0]?.text).toBe('SddBoardProjector — old');
  });

  it('returns an empty-skipped report when called with no terms', async () => {
    const { surface, store } = makeFakeSurface();
    const report = await ex.persistVia(makeFakePort(surface), []);
    expect(report.added).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.outcomes).toEqual([]);
    expect(store()).toHaveLength(0);
  });

  it('does not consult the MemoryPort shape — even a no-capability port is fine', async () => {
    const port: MemoryPort = {
      initialize: async () => {},
      getCapability: () => undefined,
      health: async () => ({ status: 'ready' as const, backend: 'none' }),
      dispose: async () => {},
      withTraceId: () => ({}) as unknown as MemoryPort,
      readAll: async () => '',
      read: async () => '',
      remember: async () => {},
      forget: async () => 0,
      consolidate: async () => {},
      clear: async () => {},
      list: async () => [],
      search: async () => [],
    };
    const report = await ex.persistVia(port, [
      {
        term: 'Anything',
        definition: 'irrelevant',
        confidence: 0.9,
        mentionCount: 1,
        evidence: [],
        sources: ['user'],
      },
    ]);
    expect(report.added).toBe(0);
    expect(report.skipped).toBe(1);
    expect(report.outcomes[0]?.reason).toBe(PERSIST_DISABLED_REASON);
  });
});

describe('SageDomainTermExtractor — markdown file mirror', () => {
  it('writes <projectRoot>/.wrongstack/domain-terms.md from the supplied in-memory terms', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const ex = new SageDomainTermExtractor();
      const filePath = await ex.writeDomainTermsFile(projectRoot, [
        {
          term: 'SddBoardProjector',
          definition: 'runtime projection of the kanban board',
          confidence: 0.8,
          mentionCount: 1,
          evidence: [],
          sources: ['user'],
        },
      ]);
      expect(filePath).toBe(path.join(projectRoot, '.wrongstack', DOMAIN_TERMS_FILENAME));
      const contents = await fs.readFile(filePath, 'utf8');
      expect(contents).toContain('# Project Domain Glossary');
      expect(contents).toContain('SddBoardProjector');
      expect(contents).toContain('runtime projection of the kanban board');
      expect(contents).toContain('| Term | Definition | Confidence |');
      // No reference to SAGE persistence in the regenerated prose —
      // the mirror is the only persisted view now.
      expect(contents).toContain('SAGE persistence is disabled');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes the empty-placeholder body when there are no terms', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const ex = new SageDomainTermExtractor();
      const filePath = await ex.writeDomainTermsFile(projectRoot, []);
      const contents = await fs.readFile(filePath, 'utf8');
      expect(contents).toContain('_No project-specific terms detected yet._');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('persistViaAndMirror reports all terms as skipped and writes the mirror from in-memory terms', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const { surface, store } = makeFakeSurface([]);
      const ex = new SageDomainTermExtractor();
      const result = await ex.persistViaAndMirror(
        makeFakePort(surface),
        [
          {
            term: 'SddBoardProjector',
            definition: 'runtime projection of the kanban board',
            confidence: 0.7,
            mentionCount: 1,
            evidence: [],
            sources: ['user'],
          },
        ],
        { projectRoot },
      );
      // Persistence is disabled — the surface must be untouched.
      expect(result.report.added).toBe(0);
      expect(result.report.updated).toBe(0);
      expect(result.report.skipped).toBe(1);
      expect(result.report.outcomes[0]?.action).toBe('skipped');
      expect(store()).toHaveLength(0);
      // Mirror was written, points at the canonical path, and includes the term.
      expect(result.mirrorPath).toBe(path.join(projectRoot, '.wrongstack', DOMAIN_TERMS_FILENAME));
      const contents = await fs.readFile(result.mirrorPath as string, 'utf8');
      expect(contents).toContain('SddBoardProjector');
      expect(contents).toContain('runtime projection of the kanban board');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('persistViaAndMirror still writes the mirror even when every term is skipped', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const { surface, store } = makeFakeSurface([
        makeFakeSage('mem_existing', 'MailboxBridge — IPC bridge between agents', 0.8),
      ]);
      const ex = new SageDomainTermExtractor();
      const result = await ex.persistViaAndMirror(
        makeFakePort(surface),
        [
          {
            term: 'MailboxBridge',
            definition: 'IPC bridge between agents',
            confidence: 0.85,
            mentionCount: 1,
            evidence: [],
            sources: ['user'],
          },
        ],
        { projectRoot },
      );
      expect(result.report.added).toBe(0);
      expect(result.report.skipped).toBe(1);
      // Pre-existing memory stays untouched — the migration command
      // is the only path that removes it.
      expect(store()).toHaveLength(1);
      expect(result.mirrorPath).toBe(path.join(projectRoot, '.wrongstack', DOMAIN_TERMS_FILENAME));
      const contents = await fs.readFile(result.mirrorPath as string, 'utf8');
      expect(contents).toContain('MailboxBridge');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('persistViaAndMirror without projectRoot skips the mirror and returns null path', async () => {
    const { surface, store } = makeFakeSurface([]);
    const ex = new SageDomainTermExtractor();
    const result = await ex.persistViaAndMirror(makeFakePort(surface), [
      {
        term: 'SddBoardProjector',
        definition: 'runtime projection of the kanban board',
        confidence: 0.7,
        mentionCount: 1,
        evidence: [],
        sources: ['user'],
      },
    ]);
    expect(result.report.added).toBe(0);
    expect(result.report.skipped).toBe(1);
    expect(result.mirrorPath).toBeNull();
    expect(store()).toHaveLength(0);
  });
});

describe('SageDomainTermExtractor — normalizeTerm', () => {
  it('lowercases and strips punctuation for stable dedupe keys', () => {
    expect(normalizeTerm('Mailbox Bridge')).toBe('mailbox bridge');
    expect(normalizeTerm('  SddBoardProjector!  ')).toBe('sddboardprojector');
    expect(normalizeTerm('sdd-board-projector')).toBe('sdd-board-projector');
    expect(normalizeTerm('Mailbox Bridge')).toBe(normalizeTerm('mailbox  bridge'));
  });
});

// ── helpers ─────────────────────────────────────────────────────────

function makeFakeSage(id: string, text: string, confidence: number): Sage {
  return {
    id,
    revision: 1,
    text,
    summary: text.split(' — ')[1] ?? '',
    kind: 'fact',
    scope: 'project',
    status: 'active',
    confidence,
    importance: Math.max(0.5, confidence),
    freshness: 1,
    tags: [DOMAIN_TERM_LOOKUP_TAG, 'glossary', 'project-jargon'],
    anchors: [],
    sources: [{ type: 'user' }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
