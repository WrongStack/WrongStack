import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  generateRepoMapMock,
  writeProjectAtlasMock,
  checkProjectAtlasFreshnessMock,
  exportProjectAtlasHtmlMock,
} = vi.hoisted(() => ({
  generateRepoMapMock: vi.fn(async () => ({
    map: '// Repo map — ranked by graph centrality (1.00 = most central).',
    filesCount: 7,
    totalFilesScanned: 8412,
    estimatedTokens: 1198,
    rankedFiles: ['packages/kanban/src/types.ts'],
  })),
  writeProjectAtlasMock: vi.fn(async () => ({
    dir: '.wrongstack/atlas',
    files: ['atlas.json', 'manifest.json', 'ATLAS.md'],
    fileCount: 300,
    packageCount: 30,
  })),
  checkProjectAtlasFreshnessMock: vi.fn(async () => ({
    fresh: true,
    changed: [],
    removed: [],
    added: 0,
    digestMatches: true,
  })),
  exportProjectAtlasHtmlMock: vi.fn(async () => '<!doctype html>\n<html></html>\n'),
}));

vi.mock('@wrongstack/tools', () => ({
  ATLAS_DIR: '.wrongstack\\atlas',
  MAX_REPORTED_DRIFT: 20,
  generateRepoMap: generateRepoMapMock,
  writeProjectAtlas: writeProjectAtlasMock,
  checkProjectAtlasFreshness: checkProjectAtlasFreshnessMock,
  exportProjectAtlasHtml: exportProjectAtlasHtmlMock,
}));

const { buildCodebaseMapCommand } = await import('../src/slash-commands/codebase-map.js');

const build = () =>
  buildCodebaseMapCommand({ renderer: { write: () => {} }, projectRoot: '/proj' } as never);

const ctx = {} as never;

/** Strip ANSI so assertions read the text, not the escape codes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const plain = (s: string) => s.replace(/\[[0-9;]*m/g, '');

describe('buildCodebaseMapCommand', () => {
  beforeEach(() => {
    generateRepoMapMock.mockClear();
    writeProjectAtlasMock.mockClear();
    checkProjectAtlasFreshnessMock.mockClear();
    exportProjectAtlasHtmlMock.mockClear();
  });

  it('registers under codebase-map with an atlas alias', () => {
    const cmd = build();
    expect(cmd.name).toBe('codebase-map');
    expect(cmd.aliases).toContain('atlas');
  });

  it('prints the ranked map by default', async () => {
    const result = await build().run('', ctx);

    expect(generateRepoMapMock).toHaveBeenCalledTimes(1);
    expect(writeProjectAtlasMock).not.toHaveBeenCalled();
    expect(plain(result.message ?? '')).toContain('graph centrality');
    expect(plain(result.message ?? '')).toContain('7 of 8412 files');
  });

  it('passes a token budget through', async () => {
    await build().run('--tokens 2000', ctx);
    expect(generateRepoMapMock.mock.calls[0]?.[0]).toMatchObject({ maxTokens: 2000 });
  });

  it('writes the atlas on --write', async () => {
    const result = await build().run('--write', ctx);

    expect(writeProjectAtlasMock).toHaveBeenCalledTimes(1);
    expect(generateRepoMapMock).not.toHaveBeenCalled();
    expect(plain(result.message ?? '')).toContain('.wrongstack/atlas');
    expect(plain(result.message ?? '')).toContain('300 files');
  });

  it('reports a current atlas on --check', async () => {
    const result = await build().run('--check', ctx);

    expect(checkProjectAtlasFreshnessMock).toHaveBeenCalledTimes(1);
    expect(plain(result.message ?? '')).toContain('atlas is current');
  });

  it('names the drifted files on --check', async () => {
    checkProjectAtlasFreshnessMock.mockResolvedValueOnce({
      fresh: false,
      reason: 'drift',
      changed: ['packages/core/src/types/provider.ts'],
      removed: [],
      added: 0,
      digestMatches: false,
    } as never);

    const message = plain((await build().run('--check', ctx)).message ?? '');

    expect(message).toContain('drifted');
    expect(message).toContain('packages/core/src/types/provider.ts');
  });

  it('says drift happened outside the atlas when no atlas file changed', async () => {
    checkProjectAtlasFreshnessMock.mockResolvedValueOnce({
      fresh: false,
      reason: 'drift',
      changed: [],
      removed: [],
      added: 3,
      digestMatches: false,
    } as never);

    expect(plain((await build().run('--check', ctx)).message ?? '')).toContain('outside the atlas');
  });

  it('points at --write when no atlas exists yet', async () => {
    checkProjectAtlasFreshnessMock.mockResolvedValueOnce({
      fresh: false,
      reason: 'missing',
      changed: [],
      removed: [],
      added: 0,
      digestMatches: false,
    } as never);

    expect(plain((await build().run('--check', ctx)).message ?? '')).toContain(
      'No atlas written yet',
    );
  });

  it('points at /codebase-reindex when the project has no index', async () => {
    writeProjectAtlasMock.mockResolvedValueOnce({ indexed: false } as never);

    expect(plain((await build().run('--write', ctx)).message ?? '')).toContain('/codebase-reindex');
  });

  it('reports a failure instead of throwing', async () => {
    generateRepoMapMock.mockRejectedValueOnce(new Error('index exploded'));

    expect(plain((await build().run('', ctx)).message ?? '')).toContain('index exploded');
  });
});

describe('/codebase-map --export', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-mapexport-'));
  });

  afterEach(async () => {
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  const run = (args: string) =>
    buildCodebaseMapCommand({
      renderer: { write: () => {} },
      projectRoot,
    } as never).run(args, ctx);

  it('writes atlas.html into the project root by default', async () => {
    const message = plain((await run('--export')).message ?? '');

    const written = await fs.readFile(path.join(projectRoot, 'atlas.html'), 'utf8');
    expect(written.startsWith('<!doctype html>')).toBe(true);
    expect(message).toContain('atlas.html');
  });

  it('honours an explicit destination, creating the directory', async () => {
    await run('--export dist/reports/map.html');

    const written = await fs.readFile(
      path.join(projectRoot, 'dist', 'reports', 'map.html'),
      'utf8',
    );
    expect(written).toContain('<html>');
  });

  it('points at /codebase-reindex instead of writing an empty file', async () => {
    exportProjectAtlasHtmlMock.mockResolvedValueOnce({ indexed: false } as never);

    const message = plain((await run('--export')).message ?? '');

    expect(message).toContain('/codebase-reindex');
    await expect(fs.access(path.join(projectRoot, 'atlas.html'))).rejects.toThrow();
  });

  it('takes precedence over printing the map', async () => {
    await run('--export');

    expect(generateRepoMapMock).not.toHaveBeenCalled();
  });
});
