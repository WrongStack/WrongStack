import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codebaseInvariantCheckTool } from '../src/codebase-index/index.js';

describe('codebase-invariant-check tool', () => {
  it('detects violations when comparing raw string codes', async () => {
    const orig = `
export function getUser(id: string): User {
  return { id, name: "Alice" };
}
`;
    const mod = `
export function getUser(id: string, token: string): User {
  return { id, name: "Alice" };
}
`;
    const result = await codebaseInvariantCheckTool.execute(
      { originalCode: orig, modifiedCode: mod, lang: 'ts' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.ruleId).toBe('INV-002');
    expect(result.summary).toContain('AST Invariants FAILED');
  });

  it('validates modifications against on-disk file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-inv-tool-'));
    const filePath = path.join(tempDir, 'service.py');

    await fs.writeFile(filePath, 'def start_server(port=8080):\n    pass\n', 'utf8');

    try {
      // Safe addition (adding default arg)
      const safeResult = await codebaseInvariantCheckTool.execute(
        {
          file: filePath,
          modifiedCode: 'def start_server(port=8080, host="0.0.0.0"):\n    pass\n',
        },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(safeResult.valid).toBe(true);
      expect(safeResult.violations).toHaveLength(0);
      expect(safeResult.summary).toContain('AST Invariants PASSED');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
