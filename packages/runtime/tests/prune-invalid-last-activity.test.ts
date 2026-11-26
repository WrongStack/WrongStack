import { describe, expect, it } from 'vitest';
import { buildPruneCommand } from '../src/portable-commands/prune.js';

describe('prune --dry-run invalid lastActivityAt fallback', () => {
  it('falls back to startedAt when lastActivityAt is unparseable', async () => {
    const cmd = buildPruneCommand({
      sessionStore: {
        list: async () => [
          {
            id: 'sess-old',
            title: 'Old Session',
            startedAt: '2020-01-01T00:00:00.000Z',
            lastActivityAt: 'not-a-date',
          },
          {
            id: 'sess-fresh',
            title: 'Fresh Session',
            startedAt: '2020-01-01T00:00:00.000Z',
            lastActivityAt: new Date().toISOString(),
          },
        ],
        prune: async () => 0,
      } as never,
    });

    const out = (await cmd.run('--dry-run 30', {} as never)) as { message?: string };
    expect(out.message).toContain('sess-old');
    expect(out.message).not.toContain('sess-fresh');
  });
});
