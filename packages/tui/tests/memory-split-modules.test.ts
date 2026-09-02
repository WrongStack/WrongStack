import type { MemoryPort } from '@wrongstack/core/types';
import { SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { handleGatherSubcommand, handleGraphSubcommand } from '../src/memory-slash-gather.js';
import {
  computeStats,
  memErr,
  parseArgs,
  parseMemoryFlags,
  renderSageEntries,
  sparkbar,
} from '../src/memory-slash-renderers.js';
import {
  DEFAULT_MEMORY_LIMIT,
  MAX_MEMORY_LIMIT,
  MEMORY_KIND_VALUES,
  MEMORY_SCOPE_VALUES,
  MEMORY_STATUS_VALUES,
  MEMORY_WRITE_SUBS,
} from '../src/memory-slash-types.js';

function sagePort(surface: Record<string, unknown> | undefined): MemoryPort {
  const port = {
    list: async () => [],
    readAll: async () => '',
    read: async () => '',
    remember: async () => {},
    forget: async () => 0,
    consolidate: async () => {},
    clear: async () => {},
    search: async () => [],
    withTraceId: () => port,
    initialize: async () => {},
    health: async () => ({ status: 'ready' as const, backend: 'test' }),
    dispose: async () => {},
    getCapability: <T>(capability: { id: string }): T | undefined =>
      capability.id === SAGE_SURFACE_CAPABILITY.id ? (surface as T | undefined) : undefined,
  };
  return port as MemoryPort;
}

const memory = {
  id: 'mem-1',
  kind: 'decision',
  status: 'active',
  text: 'Use the split memory modules directly',
  tags: ['testing'],
  createdAt: '2026-08-14T00:00:00.000Z',
  updatedAt: '2026-08-14T00:00:00.000Z',
  importance: 0.9,
  confidence: 0.8,
  anchors: [{ type: 'file', path: 'packages/tui/src/memory-slash-gather.ts' }],
  sources: [{ type: 'user' }],
};

describe('split memory slash modules', () => {
  it('imports and exposes the shared runtime constants', () => {
    expect(DEFAULT_MEMORY_LIMIT).toBe(50);
    expect(MAX_MEMORY_LIMIT).toBe(500);
    expect(MEMORY_WRITE_SUBS.has('remember')).toBe(true);
    expect(MEMORY_KIND_VALUES).toContain('decision');
    expect(MEMORY_SCOPE_VALUES).toEqual(['project', 'user', 'session', 'file', 'symbol']);
    expect(MEMORY_STATUS_VALUES).toContain('active');
  });

  it('parses and renders representative memory values', () => {
    expect(parseArgs('project --tag testing --path src --limit 999 --compact')).toEqual({
      tag: 'testing',
      path: 'src',
      compact: true,
      limit: 500,
      positional: 'project',
    });
    expect(
      parseMemoryFlags([
        'remember',
        'this',
        '--kind',
        'decision',
        '--tags',
        'testing,tui',
        '--symbol',
        'src/app.ts#App',
        '--importance',
        '0.9',
      ]),
    ).toEqual({
      text: 'remember this',
      kind: 'decision',
      tags: ['testing', 'tui'],
      anchors: [{ type: 'symbol', path: 'src/app.ts', symbol: 'App' }],
      importance: 0.9,
      errors: [],
    });
    expect(
      renderSageEntries([memory], false, Date.parse('2026-08-15T00:00:00.000Z')).join('\n'),
    ).toContain('split memory modules');
    expect(sparkbar(1, 2)).toBe('█████');
    expect(memErr(new Error('boom'))).toBe('boom');
  });

  it('computes legacy statistics through the split renderer', () => {
    const stats = computeStats(
      [
        {
          scope: 'project-memory',
          text: 'fact',
          ts: '2026-08-14T00:00:00.000Z',
          type: 'fact',
          priority: 'high',
          tags: ['testing'],
          source: 'test',
        },
      ],
      Date.parse('2026-08-15T00:00:00.000Z'),
    );
    expect(stats.total).toBe(1);
    expect(stats.perScope['project-memory']).toBe(1);
    expect(stats.recency.week).toBe(1);
    expect(stats.tagCounts.get('testing')).toBe(1);
  });

  it('formats graph results and validates missing graph support', async () => {
    await expect(handleGraphSubcommand(sagePort(undefined), ['graph', 'mem-1'])).resolves.toEqual({
      message: '`/memory graph` requires the SAGE graph backend.',
    });
    const graphFor = vi.fn(async () => [
      { from: 'mem-1', to: 'mem-2', relation: 'supports', weight: 0.75, evidence: ['shared tag'] },
    ]);
    const result = await handleGraphSubcommand(sagePort({ graphFor }), ['graph', 'mem-1']);
    expect(graphFor).toHaveBeenCalledWith('mem-1', 2, 100);
    expect(result.message).toContain('mem-1 —[supports:0.75]→ mem-2');
  });

  it('gathers a page with filters and deduplicated graph relations', async () => {
    const listSagePage = vi.fn(async () => ({
      memories: [memory],
      total: 2,
      statusCounts: { active: 2 },
    }));
    const graphFor = vi.fn(async () => [
      { from: 'mem-1', to: 'mem-2', relation: 'supports', weight: 1 },
      { from: 'mem-1', to: 'mem-2', relation: 'supports', weight: 1 },
    ]);

    const result = await handleGatherSubcommand(sagePort({ listSagePage, graphFor }), [
      'gather',
      'split',
      '--status',
      'active',
      '--kind',
      'decision',
      '--limit',
      '1',
      '--relations',
    ]);

    expect(listSagePage).toHaveBeenCalledWith({
      statuses: ['active'],
      kind: 'decision',
      query: 'split',
      limit: 1,
      includeAllSessions: true,
    });
    expect(result.message).toContain('Memory Gather — 2 matched');
    expect(result.message.match(/mem-1 —\[supports\]→ mem-2/g)).toHaveLength(1);
    expect(result.message).toContain('Showing 1 of 2');
  });

  it('reports invalid filters and backend failures', async () => {
    const port = sagePort({ listSagePage: vi.fn().mockRejectedValue('offline') });
    await expect(handleGatherSubcommand(port, ['gather', '--status', 'bogus'])).resolves.toEqual({
      message: expect.stringContaining('Invalid --status "bogus"'),
    });
    await expect(handleGatherSubcommand(port, ['gather'])).resolves.toEqual({
      message: 'Failed to gather memories: offline',
    });
  });
});
