import { randomBytes } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleFilesDelete, handleFilesMove, handleFilesRename } from '@wrongstack/webui-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { isSamePath } from '../src/server/path-containment.js';

/**
 * The files.delete / files.rename / files.move "never the project root" guard
 * compared canonical paths with `===`, while the containment check it pairs
 * with (`isPathInside`) folds case on win32. A case-variant spelling of the
 * root (`../PROJ-1A2B` for `proj-1a2b`) therefore passed containment as "the
 * root itself" and slipped past the root guard — `files.delete` with
 * `recursive: true` removed the whole project. On case-sensitive filesystems
 * the variant names a non-existent sibling, so the request fails either way;
 * the contract asserted here — the root survives and the request is refused —
 * holds on every platform.
 */

type SentFrame = { type: string; payload: Record<string, unknown> };

function mockWs(): WebSocket & { sent: SentFrame[] } {
  // Close over the array instead of reaching it through `this`: a literal cast
  // straight to `WebSocket` types `this` as `never` inside its methods.
  const sent: SentFrame[] = [];
  const ws = {
    readyState: 1,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data) as SentFrame);
    },
  };
  return ws as unknown as WebSocket & { sent: SentFrame[] };
}

function invertCase(name: string): string {
  return [...name].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
}

describe('file mutations — project root guard vs case-variant root spelling', () => {
  let parent: string;
  let root: string;
  let variant: string;

  beforeEach(() => {
    parent = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ws-rootcase-'));
    root = path.join(parent, `proj-${randomBytes(3).toString('hex')}`);
    fsSync.mkdirSync(path.join(root, 'src'), { recursive: true });
    fsSync.writeFileSync(path.join(root, 'src', 'keep.ts'), 'export {}');
    fsSync.writeFileSync(path.join(root, 'victim.txt'), 'x');
    variant = `../${invertCase(path.basename(root))}`;
  });

  afterEach(() => {
    fsSync.rmSync(parent, { recursive: true, force: true });
  });

  it('refuses to delete the project root through a case-variant spelling', async () => {
    const ws = mockWs();
    await handleFilesDelete(
      ws,
      { type: 'files.delete', payload: { filePath: variant, recursive: true } },
      root,
    );
    expect(ws.sent).toHaveLength(1);
    expect(ws.sent[0]?.payload.success).toBe(false);
    expect(fsSync.existsSync(path.join(root, 'src', 'keep.ts'))).toBe(true);
  });

  it('refuses to rename the project root through a case-variant spelling', async () => {
    const ws = mockWs();
    await handleFilesRename(
      ws,
      { type: 'files.rename', payload: { oldPath: variant, newPath: 'moved-root' } },
      root,
    );
    expect(ws.sent[0]?.payload.success).toBe(false);
    expect(fsSync.existsSync(path.join(root, 'src', 'keep.ts'))).toBe(true);
  });

  it('refuses to move the project root through a case-variant spelling', async () => {
    const ws = mockWs();
    await handleFilesMove(
      ws,
      { type: 'files.move', payload: { srcPath: variant, destDir: 'src' } },
      root,
    );
    expect(ws.sent[0]?.payload.success).toBe(false);
    expect(fsSync.existsSync(path.join(root, 'src', 'keep.ts'))).toBe(true);
  });

  it('still deletes an ordinary in-project file and directory', async () => {
    const ws = mockWs();
    await handleFilesDelete(
      ws,
      { type: 'files.delete', payload: { filePath: 'victim.txt' } },
      root,
    );
    expect(ws.sent[0]?.payload.success).toBe(true);
    expect(fsSync.existsSync(path.join(root, 'victim.txt'))).toBe(false);

    const ws2 = mockWs();
    await handleFilesDelete(
      ws2,
      { type: 'files.delete', payload: { filePath: 'src', recursive: true } },
      root,
    );
    expect(ws2.sent[0]?.payload.success).toBe(true);
    expect(fsSync.existsSync(path.join(root, 'src'))).toBe(false);
    expect(fsSync.existsSync(root)).toBe(true);
  });

  it('refuses to rename or move a directory into its own descendant without mutating disk (F928)', async () => {
    const wsRename = mockWs();
    await handleFilesRename(
      wsRename,
      {
        type: 'files.rename',
        payload: { oldPath: 'src', newPath: 'src/nested/deep/src-renamed' },
      },
      root,
    );
    expect(wsRename.sent[0]?.payload.success).toBe(false);
    expect(fsSync.existsSync(path.join(root, 'src', 'nested'))).toBe(false);

    fsSync.mkdirSync(path.join(root, 'src', 'sub'), { recursive: true });
    const wsMove = mockWs();
    await handleFilesMove(
      wsMove,
      {
        type: 'files.move',
        payload: { srcPath: 'src', destDir: 'src/sub' },
      },
      root,
    );
    expect(wsMove.sent[0]?.payload.success).toBe(false);
    expect(fsSync.existsSync(path.join(root, 'src', 'keep.ts'))).toBe(true);
  });
});

describe('isSamePath', () => {
  it('matches identical and equivalently spelled paths', () => {
    expect(isSamePath('/project/root', '/project/root')).toBe(true);
    expect(isSamePath('/project/root', '/project/root/')).toBe(true);
    expect(isSamePath('/project/root', '/project/root/sub/..')).toBe(true);
  });

  it('does not match a child, parent or sibling', () => {
    expect(isSamePath('/project/root', '/project/root/src')).toBe(false);
    expect(isSamePath('/project/root', '/project')).toBe(false);
    expect(isSamePath('/project/root', '/project/root2')).toBe(false);
  });

  it('folds case exactly where isPathInside does (win32)', () => {
    expect(isSamePath('C:/Project/Root', 'c:/project/root')).toBe(process.platform === 'win32');
  });
});
