import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { createZipBuffer, readZipEntries } from '@wrongstack/webui-server';
import { handleSkillsExport } from '@wrongstack/webui-server/server/skills-handlers';

function mockWs() {
  const sent: unknown[] = [];
  return {
    sent,
    ws: {
      readyState: 1,
      send(data: string) { sent.push(JSON.parse(data)); },
    } as unknown as WebSocket,
  };
}

describe('skills.export', () => {
  it('creates a compressed ZIP that round-trips Unicode and empty archives', () => {
    const body = '# Skill\n\nUnicode: café 🎉\n' + 'repeat '.repeat(500);
    const archive = createZipBuffer([{ name: 'api-design/SKILL.md', data: body }]);
    const entries = readZipEntries(archive);
    expect(entries.get('api-design/SKILL.md')?.toString('utf8')).toBe(body);
    expect(archive.length).toBeLessThan(Buffer.byteLength(body));
    expect(readZipEntries(createZipBuffer([])).size).toBe(0);
  });

  it('rejects zip-slip entry names', () => {
    expect(() => createZipBuffer([{ name: '../escape.txt', data: 'bad' }])).toThrow(/unsafe/i);
  });

  it('returns an explicit error when skills are disabled', async () => {
    const { ws, sent } = mockWs();
    await handleSkillsExport(ws, { skillLoader: undefined, skillInstaller: undefined, projectRoot: '.' });
    expect(sent).toEqual([
      expect.objectContaining({ type: 'skills.exported', payload: expect.objectContaining({ error: 'Skills not enabled' }) }),
    ]);
  });

  it('exports readable skills, sanitizes folder names, and skips read failures', async () => {
    const { ws, sent } = mockWs();
    const loader = {
      listEntries: async () => [{ name: 'api/design' }, { name: 'broken' }],
      readBody: async (name: string) => {
        if (name === 'broken') throw new Error('unreadable');
        return '# API Design';
      },
    };
    await handleSkillsExport(ws, {
      skillLoader: loader as never,
      skillInstaller: undefined,
      projectRoot: '.',
    });
    const payload = (sent[0] as { payload: { zipBase64: string; skillCount: number } }).payload;
    expect(payload.skillCount).toBe(1);
    const entries = readZipEntries(Buffer.from(payload.zipBase64, 'base64'));
    expect(entries.get('api_design/SKILL.md')?.toString()).toBe('# API Design');
    expect(entries.has('broken/SKILL.md')).toBe(false);
  });
});
