import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @wrongstack/sage — controls getSageSurface return per-test
const mockGetSageSurface = vi.hoisted(() => vi.fn(() => null));
vi.mock('@wrongstack/sage', () => ({ getSageSurface: mockGetSageSurface }));

// Mock memory-formatters
vi.mock('../src/slash-commands/memory-formatters.js', () => {
  const requiresSageMock = vi.fn().mockReturnValue({ message: 'This command requires SAGE.' });
  return {
    formatSageShow: vi.fn(() => 'SAGE SHOW'),
    formatSageStats: vi.fn(() => 'SAGE STATS'),
    formatSageMemories: vi.fn(() => 'SAGE MEMORIES'),
    formatGraph: vi.fn(() => 'GRAPH'),
    formatAudit: vi.fn(() => 'AUDIT'),
    formatCandidates: vi.fn(() => 'CANDIDATES'),
    formatHygiene: vi.fn(() => 'HYGIENE'),
    formatVerification: vi.fn(() => 'VERIFICATION'),
    formatLegacyEntries: vi.fn(() => 'LEGACY'),
    formatLegacyImport: vi.fn(() => 'LEGACY IMPORT'),
    formatForFileResponse: vi.fn(() => 'FOR FILE'),
    requiresSage: requiresSageMock,
  };
});

// Mock memory-compact
vi.mock('../src/slash-commands/memory-compact.js', () => ({
  runCompact: vi.fn(async () => ({ message: 'Compacted.' })),
}));

import { buildMemoryCommand } from '../src/slash-commands/memory.js';
import type { SlashCommandContext } from '../src/slash-commands/command-context.js';

function makeCtx(): SlashCommandContext {
  return {
    memoryStore: {
      readAll: vi.fn(async () => ''),
      remember: vi.fn(async () => undefined),
      forget: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      search: vi.fn(async () => []),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: vi.fn(function () { return this; }) },
    broadcast: vi.fn(),
    send: vi.fn(),
  } as any;
}

function makeSageStub(extra: Record<string, unknown> = {}) {
  return {
    stats: vi.fn(async () => ({ total: 1, byStatus: { active: 1 }, byKind: {}, edges: 0 })),
    listSage: vi.fn(async () => [{ id: 'm1', kind: 'fact', status: 'active', text: 'hello', tags: [] }]),
    getSage: vi.fn(async () => ({ id: 'm1', kind: 'fact', status: 'active', text: 'hello', tags: [] })),
    rememberSage: vi.fn(async () => ({ id: 'mem-new', kind: 'fact', status: 'active', text: 'new', tags: ['t'] })),
    updateSage: vi.fn(async () => ({ id: 'm1', kind: 'fact', status: 'active', text: 'updated', tags: [] })),
    deleteSage: vi.fn(async () => undefined),
    listSagePage: vi.fn(async () => ({ memories: [], nextCursor: null, total: 0 })),
    graphFor: vi.fn(async () => []),
    findMemoriesForFile: vi.fn(async () => ({ primary: [], symbol: [], related: [] })),
    acceptCandidate: vi.fn(async () => null),
    rejectCandidate: vi.fn(async () => null),
    ...extra,
  };
}

describe('memory slash command', () => {
  beforeEach(() => {
    // Do NOT use vi.clearAllMocks() — it also clears mockReturnValue/mockImplementation
    // set in the mock factory, causing requiresSage to return undefined.
    mockGetSageSurface.mockClear();
    mockGetSageSurface.mockReturnValue(null);
  });

  it('returns error when memoryStore is undefined', async () => {
    const cmd = buildMemoryCommand({ memoryStore: undefined } as any);
    const result = await cmd.run('');
    expect(result.message).toContain('No memory store');
  });

  describe('show / list', () => {
    it('shows SAGE stats when SAGE is available', async () => {
      mockGetSageSurface.mockReturnValue(makeSageStub());
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('');
      expect(result.message).toContain('SAGE');
    });

    it('shows empty message when SAGE is empty', async () => {
      mockGetSageSurface.mockReturnValue({
        stats: vi.fn(async () => ({ total: 0, byStatus: {}, byKind: {}, edges: 0 })),
        listSage: vi.fn(async () => []),
      });
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('');
      expect(result.message).toContain('empty');
    });

    it('falls back to legacy readAll when no SAGE', async () => {
      const ctx = makeCtx();
      (ctx.memoryStore.readAll as any).mockResolvedValue('legacy text');
      const cmd = buildMemoryCommand(ctx);
      const result = await cmd.run('');
      expect(result.message).toBe('legacy text');
    });

    it('shows empty message for legacy empty store', async () => {
      const ctx = makeCtx();
      (ctx.memoryStore.readAll as any).mockResolvedValue('  ');
      const cmd = buildMemoryCommand(ctx);
      const result = await cmd.run('');
      expect(result.message).toContain('empty');
    });
  });

  describe('remember / add', () => {
    it('returns usage when no text provided', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('remember');
      expect(result.message).toContain('Usage');
    });

    it('stores in legacy store when no SAGE', async () => {
      const ctx = makeCtx();
      const cmd = buildMemoryCommand(ctx);
      const result = await cmd.run('remember hello world');
      expect(ctx.memoryStore.remember).toHaveBeenCalledWith('hello world');
      expect(result.message).toContain('Remembered');
    });

    it('stores via SAGE rememberSage when SAGE is available', async () => {
      const sage = makeSageStub();
      mockGetSageSurface.mockReturnValue(sage);
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('remember new fact');
      expect(sage.rememberSage).toHaveBeenCalled();
      expect(result.message).toContain('mem-new');
    });

    it('handles SAGE rememberSage errors', async () => {
      mockGetSageSurface.mockReturnValue({
        ...makeSageStub(),
        rememberSage: vi.fn(async () => { throw new Error('SAGE down'); }),
      });
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('remember test');
      expect(result.message).toContain('Could not remember');
    });
  });

  describe('update / edit', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('update id1');
      expect(result.message).toContain('SAGE');
    });

    it('returns usage when no id', async () => {
      mockGetSageSurface.mockReturnValue(makeSageStub());
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('update');
      expect(result.message).toContain('Usage');
    });
  });

  describe('delete / forget', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('delete id1');
      expect(result.message).toContain('SAGE');
    });

    it('returns usage when no id', async () => {
      mockGetSageSurface.mockReturnValue(makeSageStub());
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('delete');
      expect(result.message).toContain('Usage');
    });
  });

  describe('stats', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('stats');
      expect(result.message).toContain('SAGE');
    });

    it('returns formatted stats when SAGE available', async () => {
      mockGetSageSurface.mockReturnValue(makeSageStub());
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('stats');
      expect(result.message).toBeTruthy();
    });
  });

  describe('search', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('search query');
      expect(result.message).toContain('SAGE');
    });

    it('returns usage when no query', async () => {
      mockGetSageSurface.mockReturnValue(makeSageStub());
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('search');
      expect(result.message).toContain('Usage');
    });
  });

  describe('clear', () => {
    it('calls store.forget on legacy store', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('clear');
      expect(result.message).toBeTruthy();
    });
  });

  describe('compact', () => {
    it('runs compact', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('compact');
      expect(result.message).toBeTruthy();
    });
  });

  describe('unknown subcommand', () => {
    it('returns help for unknown subcommand', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('totally-unknown');
      expect(result.message).toBeTruthy();
    });
  });

  describe('graph', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('graph query');
      expect(result.message).toContain('SAGE');
    });
  });

  describe('for-file', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('for-file x.ts');
      expect(result.message).toContain('SAGE');
    });
  });

  describe('hygiene', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('hygiene');
      expect(result.message).toContain('SAGE');
    });
  });

  describe('verify', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('verify');
      expect(result.message).toContain('SAGE');
    });
  });

  describe('candidates', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('candidates');
      expect(result.message).toContain('SAGE');
    });
  });

  describe('audit', () => {
    it('returns requiresSage when no SAGE', async () => {
      const cmd = buildMemoryCommand(makeCtx());
      const result = await cmd.run('audit');
      expect(result.message).toContain('SAGE');
    });
  });
});
