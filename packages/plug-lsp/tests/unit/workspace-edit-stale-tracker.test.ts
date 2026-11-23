import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import { DocumentTracker } from '../../src/document-tracker.js';
import { applyWorkspaceEdit } from '../../src/tools/workspace-edit.js';
import { pathToUri } from '../../src/utils/uri.js';

/**
 * The server computes a WorkspaceEdit against the text it was sent — the
 * tracked copy. A file rewritten on disk after it was tracked (an `exec`
 * formatter, a checkout) got those stale ranges spliced into its new text:
 * lsp_rename reported "Applied" and left `// fornewNameheader` behind
 * (F1510).
 */
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const log = { debug() {}, warn() {} } as unknown as Logger;
const server = {
  name: 'fake',
  state: 'ready',
  config: { languages: ['typescript'] },
  hasOpenDocument: () => true,
  notifyDidOpen() {},
  notifyDidChange() {},
  notifyDidClose() {},
};
const registry = { list: () => [server], languageIdForPath: () => 'typescript' };
const rename = (line: number, from: number, to: number) => [
  { range: { start: { line, character: from }, end: { line, character: to } }, newText: 'newName' },
];

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-stale-'));
  tempDirs.push(root);
  return { root, tracker: new DocumentTracker(() => registry as never, log, root) };
}

describe('applyWorkspaceEdit against a stale tracked document', () => {
  it('refuses the whole edit and writes nothing when a tracked file changed on disk', async () => {
    const { root, tracker } = await fixture();
    const a = path.join(root, 'a.ts');
    const b = path.join(root, 'b.ts');
    await fs.writeFile(a, 'const oldName = 1;\n');
    await fs.writeFile(b, 'oldName();\n');
    await tracker.open(a);
    await tracker.open(b);
    await fs.writeFile(b, '// formatted header\noldName();\n');

    await expect(
      applyWorkspaceEdit(
        { changes: { [pathToUri(a)]: rename(0, 6, 13), [pathToUri(b)]: rename(0, 0, 7) } },
        tracker,
        root,
      ),
    ).rejects.toThrow(/changed on disk since the language server analysed it/);
    expect(await fs.readFile(a, 'utf8')).toBe('const oldName = 1;\n');
    expect(await fs.readFile(b, 'utf8')).toBe('// formatted header\noldName();\n');
  });

  it('matches the server spelling of a Windows drive (file:///c%3A/...) to the tracked file', async () => {
    const { root, tracker } = await fixture();
    const file = path.join(root, 'b.ts');
    await fs.writeFile(file, 'oldName();\n');
    await tracker.open(file);
    await fs.writeFile(file, '// formatted header\noldName();\n');
    // typescript-language-server on Windows answers with a lowercase,
    // percent-encoded drive (see uriKey in utils/uri.ts). No-op on POSIX.
    const serverUri = pathToUri(file).replace(
      /^file:\/\/\/([A-Za-z]):/,
      (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`,
    );

    await expect(
      applyWorkspaceEdit({ changes: { [serverUri]: rename(0, 0, 7) } }, tracker, root),
    ).rejects.toThrow(/changed on disk/);
    expect(await fs.readFile(file, 'utf8')).toBe('// formatted header\noldName();\n');
  });

  it('still applies to in-sync tracked files (BOM kept) and untracked files', async () => {
    const { root, tracker } = await fixture();
    const bom = path.join(root, 'bom.ts');
    const untracked = path.join(root, 'untracked.ts');
    await fs.writeFile(bom, '﻿\nlet oldName;\n');
    await fs.writeFile(untracked, 'let oldName;\n');
    await tracker.open(bom);

    const result = await applyWorkspaceEdit(
      { changes: { [pathToUri(bom)]: rename(1, 4, 11), [pathToUri(untracked)]: rename(0, 4, 11) } },
      tracker,
      root,
    );
    expect(result.edits).toBe(2);
    expect(await fs.readFile(bom, 'utf8')).toBe('﻿\nlet newName;\n');
    expect(await fs.readFile(untracked, 'utf8')).toBe('let newName;\n');
    expect(tracker.get(bom)?.text).toBe('﻿\nlet newName;\n');
  });

  it('resyncs the tracked spelling after a lowercase-drive edit so the next edit still applies', async () => {
    const { root, tracker } = await fixture();
    const file = path.join(root, 'c.ts');
    await fs.writeFile(file, 'let oldName;\n');
    await tracker.open(file);
    const serverUri = pathToUri(file).replace(
      /^file:\/\/\/([A-Za-z]):/,
      (_match, drive: string) => `file:///${drive.toLowerCase()}%3A`,
    );

    await applyWorkspaceEdit({ changes: { [serverUri]: rename(0, 4, 11) } }, tracker, root);
    expect(tracker.get(file)?.text).toBe('let newName;\n');
    expect(tracker.list()).toHaveLength(1);

    const second = [
      {
        range: { start: { line: 0, character: 4 }, end: { line: 0, character: 11 } },
        newText: 'x',
      },
    ];
    await applyWorkspaceEdit({ changes: { [serverUri]: second } }, tracker, root);
    expect(await fs.readFile(file, 'utf8')).toBe('let x;\n');
  });
});
