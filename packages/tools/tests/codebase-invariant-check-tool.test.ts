import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolOutputSerializer } from '../../core/src/utils/tool-output-serializer.js';
import { codebaseInvariantCheckTool } from '../src/codebase-index/index.js';

describe('codebase-invariant-check tool', () => {
  it('keeps unsupported-language guidance and long violation messages complete', async () => {
    const serializer = createToolOutputSerializer();
    const unsupported = await codebaseInvariantCheckTool.execute(
      { originalCode: 'body {}', modifiedCode: 'body { color: red; }', lang: 'css' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(unsupported.verified).toBe(false);
    expect(
      JSON.parse(
        serializer.serialize(unsupported, {
          toolName: codebaseInvariantCheckTool.name,
          tool: codebaseInvariantCheckTool as never,
        }),
      ),
    ).toEqual(unsupported);

    const name = `longDeclaration${'Name'.repeat(400)}`;
    const failed = await codebaseInvariantCheckTool.execute(
      { originalCode: `export function ${name}() {}`, modifiedCode: '', lang: 'ts' },
      { projectRoot: process.cwd() } as never,
      { signal: new AbortController().signal },
    );
    expect(failed.violations).toHaveLength(1);
    const serialized = JSON.parse(
      serializer.serialize(failed, {
        toolName: codebaseInvariantCheckTool.name,
        tool: codebaseInvariantCheckTool as never,
      }),
    );
    expect(serialized.violations).toEqual(failed.violations);
    expect(serialized.violations[0].symbolName).toBe(name);
  });
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
    const text = createToolOutputSerializer().serialize(result, {
      toolName: codebaseInvariantCheckTool.name,
      tool: codebaseInvariantCheckTool as never,
    });
    expect(text.split(result.violations[0]!.message).length - 1).toBe(1);
    const serialized = JSON.parse(text);
    expect(serialized.violations).toEqual(result.violations);
    expect(serialized.valid).toBe(false);
    expect(serialized.verified).toBe(true);
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
