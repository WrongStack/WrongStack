import type { MemoryPort } from '@wrongstack/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomainGlossaryAdapter } from '../src/wiring/domain-glossary.js';

const mocks = vi.hoisted(() => ({
  getSageService: vi.fn(),
  searchSage: vi.fn(),
}));

vi.mock('@wrongstack/sage', () => ({
  getSageService: mocks.getSageService,
}));

const memoryStore = {} as MemoryPort;

describe('buildDomainGlossaryAdapter', () => {
  beforeEach(() => {
    mocks.getSageService.mockReset();
    mocks.searchSage.mockReset();
    mocks.getSageService.mockReturnValue({ searchSage: mocks.searchSage });
  });

  it('maps SAGE hits into glossary rows and priority bands', async () => {
    mocks.searchSage.mockResolvedValue(
      [
        { text: 'critical', tags: ['domain-term'], importance: 0.9 },
        { text: 'high', tags: ['domain-term'], importance: 0.75 },
        { text: 'medium', tags: ['domain-term'], importance: 0.4 },
        { text: 'low', tags: ['domain-term'], importance: 0.39 },
      ].map((hit, index) => ({
        ...hit,
        confidence: 0.8,
        createdAt: `2026-08-0${index + 1}T00:00:00.000Z`,
        updatedAt: `2026-08-0${index + 2}T00:00:00.000Z`,
      })),
    );

    const rows = await createDomainGlossaryAdapter(memoryStore).list('project-memory', 8);

    expect(mocks.searchSage).toHaveBeenCalledWith('domain-term', { limit: 8 });
    expect(rows.map((row) => row.priority)).toEqual(['critical', 'high', 'medium', 'low']);
    expect(rows[0]).toMatchObject({ text: 'critical', tags: ['domain-term'] });
  });

  it('clamps requested limits to the supported range', async () => {
    mocks.searchSage.mockResolvedValue([]);
    const adapter = createDomainGlossaryAdapter(memoryStore);

    await adapter.list('project-memory', 0);
    await adapter.list('project-memory', 99);
    await adapter.list('project-memory');

    expect(mocks.searchSage.mock.calls).toEqual([
      ['domain-term', { limit: 1 }],
      ['domain-term', { limit: 16 }],
      ['domain-term', { limit: 16 }],
    ]);
  });

  it('returns an empty glossary for a legacy port without SAGE capability', async () => {
    mocks.getSageService.mockReturnValue(null);

    await expect(
      createDomainGlossaryAdapter(memoryStore).list('project-memory', 4),
    ).resolves.toEqual([]);
    expect(mocks.searchSage).not.toHaveBeenCalled();
  });

  it('keeps prompt assembly alive when SAGE search rejects', async () => {
    mocks.searchSage.mockRejectedValue(new Error('database busy'));

    await expect(
      createDomainGlossaryAdapter(memoryStore).list('project-memory', 4),
    ).resolves.toEqual([]);
  });
});
