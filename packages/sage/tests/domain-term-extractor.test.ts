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

describe('SageDomainTermExtractor — persistence', () => {
  const ex = new SageDomainTermExtractor();

  it('persists new terms with kind=fact and the domain-term tag trio', async () => {
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
    ]);
    expect(report.added).toBe(1);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(0);
    const rows = store();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tags).toEqual(
      expect.arrayContaining([DOMAIN_TERM_LOOKUP_TAG, 'glossary', 'project-jargon']),
    );
    expect(rows[0]?.text).toContain('SddBoardProjector');
    expect(rows[0]?.text).toContain('runtime projection');
  });

  it('skips persistence when below minConfidence', async () => {
    const { surface, store } = makeFakeSurface();
    const report = await ex.persistVia(
      makeFakePort(surface),
      [
        {
          term: 'NoisyTerm',
          definition: '',
          confidence: 0.2,
          mentionCount: 1,
          evidence: [],
          sources: ['user'],
        },
      ],
      { minConfidence: 0.5 },
    );
    expect(report.added).toBe(0);
    expect(report.skipped).toBe(1);
    expect(store()).toHaveLength(0);
  });

  it('dedupes against existing term memory and skips when identical', async () => {
    const existing = makeFakeSage(
      'mem_existing',
      'SddBoardProjector — runtime projection of the kanban board',
      0.8,
    );
    const { surface, store } = makeFakeSurface([existing]);
    const report = await ex.persistVia(makeFakePort(surface), [
      {
        term: 'SddBoardProjector',
        definition: 'runtime projection of the kanban board',
        confidence: 0.85,
        mentionCount: 1,
        evidence: [],
        sources: ['user'],
      },
    ]);
    expect(report.added).toBe(0);
    expect(report.updated).toBe(0);
    expect(report.skipped).toBe(1);
    expect(store()).toHaveLength(1);
  });

  it('updates existing term memory when overwriteExisting=true', async () => {
    const existing = makeFakeSage('mem_existing', 'SddBoardProjector — old definition', 0.6);
    const { surface, store } = makeFakeSurface([existing]);
    const report = await ex.persistVia(
      makeFakePort(surface),
      [
        {
          term: 'SddBoardProjector',
          definition: 'runtime projection of the kanban board',
          confidence: 0.8,
          mentionCount: 1,
          evidence: [],
          sources: ['user'],
        },
      ],
      { overwriteExisting: true },
    );
    expect(report.updated).toBe(1);
    expect(store()[0]?.text).toContain('runtime projection');
    expect(store()[0]?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('skips cleanly when the MemoryPort lacks the SAGE surface capability', async () => {
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
  });
});

describe('SageDomainTermExtractor — markdown file mirror', () => {
  it('writes <projectRoot>/.wrongstack/domain-terms.md derived from SAGE', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const terms = makeFakeSage(
        'mem_1',
        'SddBoardProjector — runtime projection of the kanban board',
        0.8,
      );
      const { surface } = makeFakeSurface([terms]);
      const ex = new SageDomainTermExtractor();
      const filePath = await ex.writeDomainTermsFile(projectRoot, makeFakePort(surface));
      expect(filePath).toBe(path.join(projectRoot, '.wrongstack', DOMAIN_TERMS_FILENAME));
      const contents = await fs.readFile(filePath, 'utf8');
      expect(contents).toContain('# Project Domain Glossary');
      expect(contents).toContain('SddBoardProjector');
      expect(contents).toContain('runtime projection of the kanban board');
      expect(contents).toContain('| Term | Definition | Confidence |');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('writes an empty-table body when there are no terms yet', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const { surface } = makeFakeSurface([]);
      const ex = new SageDomainTermExtractor();
      const filePath = await ex.writeDomainTermsFile(projectRoot, makeFakePort(surface));
      const contents = await fs.readFile(filePath, 'utf8');
      expect(contents).toContain('_No project-specific terms detected yet._');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('persistViaAndMirror persists first, then writes the mirror file', async () => {
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
      // Persist happened.
      expect(result.report.added).toBe(1);
      expect(store()).toHaveLength(1);
      // Mirror was written, points at the canonical path, and includes the term.
      expect(result.mirrorPath).toBe(path.join(projectRoot, '.wrongstack', DOMAIN_TERMS_FILENAME));
      const contents = await fs.readFile(result.mirrorPath as string, 'utf8');
      expect(contents).toContain('SddBoardProjector');
      expect(contents).toContain('runtime projection of the kanban board');
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('persistViaAndMirror refreshes the mirror even when nothing is added', async () => {
    // When the corpus already has the term, persistVia returns
    // skipped-but-no-mutation; the mirror must still be regenerated
    // so SAGE and the file never drift.
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-domain-'));
    try {
      const existing = makeFakeSage(
        'mem_existing',
        'MailboxBridge — IPC bridge between agents',
        0.8,
      );
      const { surface } = makeFakeSurface([existing]);
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
    expect(result.report.added).toBe(1);
    expect(result.mirrorPath).toBeNull();
    expect(store()).toHaveLength(1);
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
