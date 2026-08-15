import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codebaseAstReplaceTool, replaceSymbolInFile } from '../src/codebase-index/index.js';

describe('codebase-ast-replace tool & mutator', () => {
  it('surgically replaces a TypeScript function body without breaking signatures', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-mut-ts-'));
    const filePath = path.join(tempDir, 'math.ts');

    const originalCode = `
import { Config } from './config.js';

/**
 * Multiplies two numbers.
 */
export function calculate(a: number, b: number): number {
  const oldVal = a + b;
  return oldVal;
}

export function other(): string {
  return 'untouched';
}
`;
    await fs.writeFile(filePath, originalCode, 'utf8');

    try {
      const res = await replaceSymbolInFile(
        {
          file: filePath,
          symbol: 'calculate',
          newBody: 'return a * b * 100;',
          target: 'body',
        },
        tempDir,
      );

      expect(res.symbol).toBe('calculate');
      expect(res.updatedContent).toContain(
        'export function calculate(a: number, b: number): number {',
      );
      expect(res.updatedContent).toContain('return a * b * 100;');
      expect(res.updatedContent).not.toContain('const oldVal = a + b');
      expect(res.updatedContent).toContain("return 'untouched';");

      // Verify on disk
      const onDisk = await fs.readFile(filePath, 'utf8');
      expect(onDisk).toBe(res.updatedContent);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('surgically replaces a Python function body via Tree-Sitter', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-mut-py-'));
    const filePath = path.join(tempDir, 'service.py');

    const originalPy = `
def process_data(items):
    """Old process."""
    result = []
    for x in items:
        result.append(x * 2)
    return result

def helper():
    return True
`;
    await fs.writeFile(filePath, originalPy, 'utf8');

    try {
      const res = await replaceSymbolInFile(
        {
          file: filePath,
          symbol: 'process_data',
          newBody: 'return [x * 10 for x in items]',
          target: 'body',
        },
        tempDir,
      );

      expect(res.symbol).toBe('process_data');
      expect(res.updatedContent).toContain('def process_data(items):');
      expect(res.updatedContent).toContain('return [x * 10 for x in items]');
      expect(res.updatedContent).not.toContain('result.append');
      expect(res.updatedContent).toContain('def helper():');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('executes codebase-ast-replace tool successfully', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-mut-tool-'));
    const filePath = path.join(tempDir, 'app.ts');

    await fs.writeFile(
      filePath,
      'export function greet(name: string): string {\n  return "Hello " + name;\n}',
      'utf8',
    );

    try {
      const output = await codebaseAstReplaceTool.execute(
        {
          file: filePath,
          symbol: 'greet',
          newBody: 'return `Welcome, ${name.toUpperCase()}!`;',
        },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(output.status).toBe('ok');
      expect(output.symbol).toBe('greet');

      const diskContent = await fs.readFile(filePath, 'utf8');
      expect(diskContent).toContain('Welcome, ${name.toUpperCase()}!');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects breaking changes with target=full unless allowBreakingChanges is set', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-mut-inv-'));
    const filePath = path.join(tempDir, 'payment.ts');

    await fs.writeFile(
      filePath,
      'export function pay(amount: number): boolean {\n  return true;\n}',
      'utf8',
    );

    try {
      // 1. Fails when breaking change (mandatory param addition) is introduced
      const output = await codebaseAstReplaceTool.execute(
        {
          file: filePath,
          symbol: 'pay',
          newBody: 'export function pay(amount: number, fee: number): boolean {\n  return true;\n}',
          target: 'full',
        },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(output.status).toBe('error');
      expect(output.error).toContain('AST Invariant Violation');
      expect(output.error).toContain('INV-002');

      // 2. Succeeds when allowBreakingChanges: true is passed
      const forcedOutput = await codebaseAstReplaceTool.execute(
        {
          file: filePath,
          symbol: 'pay',
          newBody: 'export function pay(amount: number, fee: number): boolean {\n  return true;\n}',
          target: 'full',
          allowBreakingChanges: true,
        },
        { projectRoot: tempDir } as never,
        { signal: new AbortController().signal },
      );

      expect(forcedOutput.status).toBe('ok');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
