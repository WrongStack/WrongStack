import * as path from 'node:path';
import { extractCodeMapFileTargets, normalizeCodeMapFileTarget } from '@wrongstack/webui-server';
import { describe, expect, it } from 'vitest';

describe('CodeMap tool telemetry', () => {
  const projectRoot = path.resolve('D:/repo');

  it('normalizes a file tool target and preserves its line range', () => {
    expect(
      extractCodeMapFileTargets(projectRoot, 'read', {
        path: 'src/agent.ts',
        offset: 42,
        limit: 10,
      }),
    ).toEqual([
      {
        filePath: path.join(projectRoot, 'src/agent.ts'),
        operation: 'read',
        line: 42,
        endLine: 51,
      },
    ]);
  });

  it('extracts and deduplicates all apply_patch destination files', () => {
    const patch = [
      '*** Begin Patch',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '+++ b/src/one.ts',
      '*** End Patch',
    ].join('\n');

    expect(extractCodeMapFileTargets(projectRoot, 'apply_patch', { patch })).toEqual([
      { filePath: path.join(projectRoot, 'src/one.ts'), operation: 'edit' },
      { filePath: path.join(projectRoot, 'src/two.ts'), operation: 'edit' },
    ]);
  });

  it('does not invent file targets for pathless or unknown tools', () => {
    expect(extractCodeMapFileTargets(projectRoot, 'bash', { command: 'pnpm test' })).toEqual([]);
    expect(extractCodeMapFileTargets(projectRoot, 'unknown', { path: 'src/a.ts' })).toEqual([]);
    expect(extractCodeMapFileTargets(projectRoot, 'constructor', { path: 'src/a.ts' })).toEqual([]);
    expect(extractCodeMapFileTargets(projectRoot, '__proto__', { path: 'src/a.ts' })).toEqual([]);
  });

  it('normalizes deterministic file_changed targets independently of tool name', () => {
    expect(normalizeCodeMapFileTarget(projectRoot, 'src/generated.ts', 'write', 7, 9)).toEqual({
      filePath: path.join(projectRoot, 'src/generated.ts'),
      operation: 'write',
      line: 7,
      endLine: 9,
    });
  });
});
