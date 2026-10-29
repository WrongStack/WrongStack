import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { handleSkillsEdit } from '../src/server/skills-handlers.js';

it('refuses a skill edit when the file changed since the editor read it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ws-skill-edit-'));
  const file = join(dir, 'SKILL.md');
  const body = (text: string) => `---\nname: demo\ndescription: test skill\n---\n${text}\n`;
  await writeFile(file, body('original'));
  const messages: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => messages.push(JSON.parse(raw)),
  } as never as WebSocket;
  const invalidateCache = vi.fn();
  const ctx = {
    skillLoader: {
      listEntries: async () => [
        { name: 'demo', path: file, source: 'project', scope: ['project'] },
      ],
      invalidateCache,
    },
    skillInstaller: undefined,
    projectRoot: dir,
  } as never;
  try {
    // Another window saved in between.
    await writeFile(file, body('theirs'));
    await handleSkillsEdit(ws, ctx, {
      payload: { name: 'demo', body: body('mine'), expectedBody: body('original') },
    });
    expect(messages.at(-1)?.payload).toMatchObject({ success: false });
    expect(String(messages.at(-1)?.payload['error'])).toMatch(/changed/);
    expect(await readFile(file, 'utf8')).toBe(body('theirs'));
    await handleSkillsEdit(ws, ctx, {
      payload: { name: 'demo', body: body('mine'), expectedBody: body('theirs') },
    });
    expect(messages.at(-1)?.payload).toMatchObject({ success: true });
    expect(await readFile(file, 'utf8')).toBe(body('mine'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
