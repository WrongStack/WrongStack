import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { editsByPath, summarizeWorkspaceEdit } from '../../src/formatters/workspace-edit.js';
import { applyWorkspaceEdit } from '../../src/tools/workspace-edit.js';
import { pathToUri, uriToPathOrUri } from '../../src/utils/uri.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function edit(newText: string) {
  return [
    {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
      newText,
    },
  ];
}

// Regression: editsByPath called fileURLToPath unconditionally, so a
// custom-scheme target anywhere in a WorkspaceEdit threw and discarded the
// entire rename result; applyWorkspaceEdit then had nothing it could write.
describe('workspace edits with non-file URIs', () => {
  it('keys custom-scheme targets by URI instead of throwing', () => {
    const input = {
      changes: {
        'file:///C:/tmp/a.ts': edit('x'),
        'jdt://contents/java.base/java.lang/String.class': edit('y'),
      },
    } as never;

    const entries = editsByPath(input);
    expect(entries.size).toBe(2);
    expect(entries.has('jdt://contents/java.base/java.lang/String.class')).toBe(true);
    expect(summarizeWorkspaceEdit(input, 'C:/tmp')).toContain('jdt://');
  });

  it('applies only file: targets and never throws on a malformed URI', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plug-lsp-workspace-edit-'));
    tempDirs.push(root);
    const file = path.join(root, 'a.ts');
    await fs.writeFile(file, 'answer;\n');

    const input = {
      changes: {
        [pathToUri(file)]: edit('result2'),
        'jdt://contents/java.base/java.lang/String.class': edit('y'),
      },
      documentChanges: [
        {
          textDocument: { uri: 'vscode-remote://ssh-remote%2Bhost/home/u/x.ts', version: 1 },
          edits: edit('z'),
        },
      ],
    } as never;

    const result = await applyWorkspaceEdit(input, { fileWritten: async () => {} } as never);
    expect(await fs.readFile(file, 'utf8')).toBe('result2;\n');
    expect(result.files).toEqual([file]);
    expect(result.edits).toBe(1);

    // `uriToPathOrUri` never throws: custom schemes and malformed file: URIs
    // come back verbatim, real file: URIs decode to a path.
    expect(uriToPathOrUri('jdt://x')).toBe('jdt://x');
    expect(uriToPathOrUri('file://%')).toBe('file://%');
    expect(uriToPathOrUri(pathToUri(file))).toBe(path.resolve(file));
  });
});
