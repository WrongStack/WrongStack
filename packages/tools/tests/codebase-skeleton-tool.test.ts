import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codebaseSkeletonTool, extractFileSkeleton } from '../src/codebase-index/index.js';

describe('codebase-skeleton tool & extractor', () => {
  const dummyCtx = {
    projectRoot: process.cwd(),
  } as never;
  const dummyOpts = { signal: new AbortController().signal };

  it('strips function bodies in TypeScript while preserving signatures and types and emitting line ranges', async () => {
    const tsCode = `
import { Foo, Bar } from './types.js';

/**
 * Adds two numbers.
 * @param a First number
 * @param b Second number
 */
export function add(a: number, b: number): number {
  const c = a + b;
  console.log('debug sum:', c);
  return c;
}

export interface User {
  id: string;
  name: string;
}

export class Calculator {
  private base: number = 10;

  /** Multiplies value by base */
  public multiply(val: number): number {
    const result = val * this.base;
    return result;
  }
}
`;

    const res = await extractFileSkeleton({
      file: 'math.ts',
      content: tsCode,
      lang: 'ts',
    });

    expect(res.skeleton).toContain(
      'export function add(a: number, b: number): number { /* L9-L13 */ }',
    );
    expect(res.skeleton).toContain('public multiply(val: number): number { /* L24-L27 */ }');
    expect(res.skeleton).toContain('export interface User');
    expect(res.skeleton).toContain('Adds two numbers.');
    expect(res.skeleton).not.toContain('console.log');
    expect(res.skeleton).not.toContain('const c = a + b');
    expect(res.stats.originalLines).toBeGreaterThan(res.stats.skeletonLines);
    expect(res.stats.tokenSavingsPercent).toBeGreaterThan(15);
    expect(res.symbols?.some((s) => s.name === 'add' && s.startLine === 9)).toBe(true);
    expect(res.symbols?.some((s) => s.name === 'Calculator' && s.kind === 'class')).toBe(true);
  });

  it('collapses imports in TypeScript when collapseImports is enabled', async () => {
    const tsCode = `
import { A } from './a.js';
import { B } from './b.js';
import { C } from './c.js';

export function run(): void {
  console.log('running');
}
`;

    const res = await extractFileSkeleton({
      file: 'app.ts',
      content: tsCode,
      lang: 'ts',
      options: { collapseImports: true, includeLineNumbers: false },
    });

    expect(res.skeleton).toContain('[3 import statements collapsed]');
    expect(res.skeleton).toContain('export function run(): void { /* ... */ }');
  });

  it('keeps code after a multi-line import when collapsing (EOF over-consumption)', async () => {
    const tsCode = [
      'import {',
      '  alpha,',
      '  beta,',
      "} from './mod';",
      '',
      'export function gamma(): number {',
      '  return 1;',
      '}',
    ].join('\n');

    const res = await extractFileSkeleton({
      file: 'app.ts',
      content: tsCode,
      lang: 'ts',
      options: { collapseImports: true, includeLineNumbers: false },
    });

    // The import statement collapses to exactly one summary comment...
    expect(res.skeleton).toContain('[1 import statements collapsed]');
    // ...and every statement after it survives (a stale `trimmed` in the
    // consumption loop used to spin the cursor to EOF and drop them all).
    expect(res.skeleton).toContain('export function gamma(): number { /* ... */ }');
    // The collapsed import's specifiers must not leak into the outline.
    expect(res.skeleton).not.toContain('alpha');
    expect(res.skeleton).not.toContain('beta');
  });

  it('strips Python function bodies with Tree-Sitter and line annotations', async () => {
    const pyCode = `
def calculate_metrics(data, threshold=0.5):
    """Calculate accuracy metrics."""
    filtered = [x for x in data if x > threshold]
    count = len(filtered)
    return count * 100

class DataProcessor:
    def process(self, items):
        return [self.transform(x) for x in items]
`;

    const res = await extractFileSkeleton({
      file: 'metrics.py',
      content: pyCode,
      lang: 'py',
    });

    expect(res.skeleton).toContain('def calculate_metrics(data, threshold=0.5):');
    expect(res.skeleton).toContain('... # L3-L6');
    expect(res.skeleton).not.toContain('filtered = [x for x in data if x > threshold]');
    expect(res.symbols?.some((s) => s.name === 'calculate_metrics' && s.kind === 'function')).toBe(
      true,
    );
  });

  it('strips Go function bodies with Tree-Sitter', async () => {
    const goCode = `
package main

import "fmt"

func ProcessOrder(orderId string, amount float64) error {
	fmt.Println("Processing order", orderId)
	if amount <= 0 {
		return fmt.Errorf("invalid amount")
	}
	return nil
}
`;

    const res = await extractFileSkeleton({
      file: 'order.go',
      content: goCode,
      lang: 'go',
    });

    expect(res.skeleton).toContain(
      'func ProcessOrder(orderId string, amount float64) error { /* L6-L12 */ }',
    );
    expect(res.skeleton).not.toContain('fmt.Println("Processing order", orderId)');
  });

  it('strips Rust function bodies with Tree-Sitter', async () => {
    const rsCode = `
pub struct UserConfig {
    pub name: String,
    pub timeout: u64,
}

impl UserConfig {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            timeout: 30,
        }
    }

    pub fn validate(&self) -> bool {
        !self.name.is_empty() && self.timeout > 0
    }
}
`;

    const res = await extractFileSkeleton({
      file: 'config.rs',
      content: rsCode,
      lang: 'rs',
    });

    expect(res.skeleton).toContain('pub struct UserConfig');
    expect(res.skeleton).toContain('pub fn new(name: &str) -> Self { /* L8-L13 */ }');
    expect(res.skeleton).toContain('pub fn validate(&self) -> bool { /* L15-L17 */ }');
    expect(res.skeleton).not.toContain('timeout: 30');
  });

  it('strips C++ and Java method bodies with Tree-Sitter', async () => {
    const cppCode = `
#include <iostream>
#include <string>

class SessionManager {
public:
    SessionManager(const std::string& id) {
        this->sessionId = id;
        std::cout << "Init session: " << id << std::endl;
    }

    bool isValid() {
        return !sessionId.empty();
    }
private:
    std::string sessionId;
};
`;

    const res = await extractFileSkeleton({
      file: 'session.cpp',
      content: cppCode,
      lang: 'cpp',
    });

    expect(res.skeleton).toContain('class SessionManager');
    expect(res.skeleton).toContain('SessionManager(const std::string& id) { /* L7-L10 */ }');
    expect(res.skeleton).toContain('bool isValid() { /* L12-L14 */ }');
    expect(res.skeleton).not.toContain('std::cout');
  });

  it('executes codebase-skeleton tool on single file', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skel-test-'));
    const filePath = path.join(tempDir, 'sample.ts');
    await fs.writeFile(
      filePath,
      'export function hello(): string {\n  const msg = "world";\n  return msg;\n}',
      'utf8',
    );

    try {
      const output = await codebaseSkeletonTool.execute(
        { path: filePath },
        { projectRoot: tempDir } as never,
        dummyOpts,
      );

      expect(output.isDir).toBe(false);
      expect(output.skeleton).toContain('export function hello(): string { /* L1-L4 */ }');
      expect(output.stats.originalLines).toBe(4);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('executes codebase-skeleton tool on a directory recursively', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skel-dir-test-'));
    await fs.writeFile(
      path.join(tempDir, 'a.ts'),
      'export const A = 1;\nexport function fnA() {\n  return 42;\n}',
      'utf8',
    );
    await fs.writeFile(
      path.join(tempDir, 'b.ts'),
      'export function fnB() {\n  const x = "b";\n  return x;\n}',
      'utf8',
    );

    try {
      const output = await codebaseSkeletonTool.execute(
        { path: tempDir },
        { projectRoot: tempDir } as never,
        dummyOpts,
      );

      expect(output.isDir).toBe(true);
      expect(output.stats.fileCount).toBe(2);
      expect(output.skeleton).toContain('a.ts');
      expect(output.skeleton).toContain('b.ts');
      expect(output.skeleton).toContain('fnA() { /* L2-L4 */ }');
      expect(output.skeleton).toContain('fnB() { /* L1-L4 */ }');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws error for non-existent file or directory', async () => {
    await expect(
      codebaseSkeletonTool.execute(
        { path: path.join(process.cwd(), '.nonexistent-skeleton-test.ts') },
        dummyCtx,
        dummyOpts,
      ),
    ).rejects.toThrow(/not found/);
  });
});
