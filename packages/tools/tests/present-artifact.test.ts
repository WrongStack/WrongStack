import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { liveBrowser } from '@wrongstack/browser-tools/tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArtifactPresentation } from '../src/artifact-presentation.js';
import { presentArtifactTool } from '../src/present-artifact.js';

const roots: string[] = [];
const call = { signal: new AbortController().signal };
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wrongstack-artifact-'));
  roots.push(root);
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'report.md'), '# Result\n');
  return {
    root,
    ctx: {
      projectRoot: root,
      eventSessionId: () => 'session-a',
      allowOutsideProjectRoot: true,
    } as unknown as Parameters<typeof presentArtifactTool.execute>[1],
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('present_artifact', () => {
  it('sniffs raster bytes independently of the extension and keeps diff previews read-only', async () => {
    const { root, ctx } = await fixture();
    await writeFile(
      path.join(root, 'picture.dat'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    );
    expect(await presentArtifactTool.execute({ path: 'picture.dat' }, ctx, call)).toMatchObject({
      version: 2,
      kind: 'image',
    });
    await writeFile(
      path.join(root, 'fix.patch'),
      '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new',
    );
    expect(await presentArtifactTool.execute({ path: 'fix.patch' }, ctx, call)).toMatchObject({
      kind: 'diff',
    });
    await writeFile(path.join(root, 'report.html'), '<script>alert(1)</script>');
    expect(await presentArtifactTool.execute({ path: 'report.html' }, ctx, call)).toMatchObject({
      kind: 'text',
    });
  });
  it('requires both agent and conversation ownership for a live browser', async () => {
    const { ctx } = await fixture();
    vi.spyOn(liveBrowser, 'sessions').mockResolvedValue([
      { id: 'browser-a', ownerId: 'leader', conversationId: 'session-a' } as never,
    ]);
    expect(
      await presentArtifactTool.execute({ browserSessionId: 'browser-a' }, ctx, call),
    ).toMatchObject({ kind: 'browser', browserSessionId: 'browser-a' });
    vi.mocked(liveBrowser.sessions).mockResolvedValue([
      { id: 'browser-a', ownerId: 'leader', conversationId: 'session-other' } as never,
    ]);
    await expect(
      presentArtifactTool.execute({ browserSessionId: 'browser-a' }, ctx, call),
    ).rejects.toThrow('owned');
    vi.mocked(liveBrowser.sessions).mockResolvedValue([
      { id: 'browser-a', ownerId: 'other-agent', conversationId: 'session-a' } as never,
    ]);
    await expect(
      presentArtifactTool.execute({ browserSessionId: 'browser-a' }, ctx, call),
    ).rejects.toThrow('owned');
  });
  it('returns a compact session-owned descriptor without copying report contents', async () => {
    const { ctx } = await fixture();
    const result = await presentArtifactTool.execute(
      { path: 'docs/report.md', title: 'Results' },
      ctx,
      call,
    );
    expect(parseArtifactPresentation(result)).toMatchObject({
      sessionId: 'session-a',
      path: 'docs/report.md',
      title: 'Results',
    });
    expect(JSON.stringify(result)).not.toContain('# Result');
  });
  it('rejects project escapes even with unrestricted filesystem settings', async () => {
    const { root, ctx } = await fixture();
    const outside = path.join(path.dirname(root), 'outside.md');
    await expect(presentArtifactTool.execute({ path: outside }, ctx, call)).rejects.toThrow(
      'inside the project',
    );
  });
  it('rejects an in-project symlink to another project', async () => {
    const { root, ctx } = await fixture();
    const other = await fixture();
    await symlink(
      other.root,
      path.join(root, 'outside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(
      presentArtifactTool.execute({ path: 'outside/docs/report.md' }, ctx, call),
    ).rejects.toThrow('symlink');
  });
  it('rejects binary files and directories', async () => {
    const { root, ctx } = await fixture();
    await writeFile(path.join(root, 'binary'), Buffer.from([0, 1, 2, 0]));
    await expect(presentArtifactTool.execute({ path: 'binary' }, ctx, call)).rejects.toThrow(
      'binary',
    );
    await expect(presentArtifactTool.execute({ path: 'docs' }, ctx, call)).rejects.toThrow(
      'text file',
    );
  });
  it('honors cancellation before doing filesystem work', async () => {
    const { ctx } = await fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(
      presentArtifactTool.execute({ path: 'docs/report.md' }, ctx, { signal: abort.signal }),
    ).rejects.toThrow();
  });
  it('does not issue a descriptor after session ownership changes', async () => {
    const { ctx } = await fixture();
    let calls = 0;
    const changing = { ...ctx, eventSessionId: () => (++calls === 1 ? 'session-a' : 'session-b') };
    await expect(
      presentArtifactTool.execute({ path: 'docs/report.md' }, changing as never, call),
    ).rejects.toThrow('session changed');
  });
  it.each([
    '../outside.md',
    '/outside.md',
    'C:/outside.md',
    'docs\\report.md',
    'https://example.com',
    'docs/./report.md',
  ])('rejects an unsafe wire path %s', (unsafe) => {
    expect(
      parseArtifactPresentation({
        type: 'artifact.presentation',
        version: 1,
        id: 'a',
        sessionId: 's',
        title: 'Report',
        path: unsafe,
      }),
    ).toBeNull();
  });
});
