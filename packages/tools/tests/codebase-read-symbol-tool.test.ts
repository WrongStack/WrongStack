import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codebaseReadSymbolTool, readSymbolInFile } from '../src/codebase-index/index.js';

describe('codebase-read-symbol tool & ast-symbol-reader', () => {
  it('reads a TypeScript function with JSDoc comments and line numbering', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-ts-'));
    const filePath = path.join(tempDir, 'math.ts');

    const source = `// file header
import { Config } from './config.js';

/**
 * Computes the sum of two integers.
 * @param a First number
 * @param b Second number
 */
export function add(a: number, b: number): number {
  const result = a + b;
  return result;
}

export function other(): void {}
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const res = await readSymbolInFile(
        {
          file: filePath,
          symbol: 'add',
          includeDocs: true,
        },
        tempDir,
      );

      expect(res.symbol).toBe('add');
      expect(res.kind).toBe('function');
      expect(res.startLine).toBe(4);
      expect(res.endLine).toBe(12);
      expect(res.totalLines).toBe(9);
      expect(res.text).toContain(' 4→/**');
      expect(res.text).toContain(' 9→export function add(a: number, b: number): number {');
      expect(res.text).toContain('12→}');
      expect(res.rawText).toContain('Computes the sum of two integers.');
      expect(res.rawText).toContain('export function add');
      expect(res.rawText).not.toContain('export function other');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads a TypeScript function without docs when includeDocs is false', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-ts-nodocs-'));
    const filePath = path.join(tempDir, 'math.ts');

    const source = `import { Config } from './config.js';

/**
 * Multiplies two numbers.
 */
export function multiply(a: number, b: number): number {
  return a * b;
}
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const res = await readSymbolInFile(
        {
          file: filePath,
          symbol: 'multiply',
          includeDocs: false,
        },
        tempDir,
      );

      expect(res.symbol).toBe('multiply');
      expect(res.startLine).toBe(6);
      expect(res.endLine).toBe(8);
      expect(res.text).not.toContain('Multiplies two numbers');
      expect(res.text).toContain('6→export function multiply(a: number, b: number): number {');
      expect(res.text).toContain('8→}');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads only the body when target is body', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-ts-body-'));
    const filePath = path.join(tempDir, 'service.ts');

    const source = `export class Service {
  process(): string {
    const data = "ready";
    return data;
  }
}
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const res = await readSymbolInFile(
        {
          file: filePath,
          symbol: 'Service.process',
          target: 'body',
        },
        tempDir,
      );

      expect(res.startLine).toBe(2);
      expect(res.endLine).toBe(5);
      expect(res.rawText).toContain('const data = "ready";');
      expect(res.rawText).toContain('return data;');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads a TypeScript class declaration', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-class-'));
    const filePath = path.join(tempDir, 'user.ts');

    const source = `/** User entity */
export class User {
  id: string = '';

  getId(): string {
    return this.id;
  }
}
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const res = await readSymbolInFile(
        {
          file: filePath,
          symbol: 'User',
          includeDocs: true,
        },
        tempDir,
      );

      expect(res.symbol).toBe('User');
      expect(res.kind).toBe('class');
      expect(res.startLine).toBe(1);
      expect(res.endLine).toBe(8);
      expect(res.text).toContain('1→/** User entity */');
      expect(res.text).toContain('2→export class User {');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads an arrow function variable declaration', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-arrow-'));
    const filePath = path.join(tempDir, 'handlers.ts');

    const source = `/**
 * Greets a user.
 */
export const greet = (name: string): string => {
  return "Hello " + name;
};
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const res = await readSymbolInFile(
        {
          file: filePath,
          symbol: 'greet',
          includeDocs: true,
        },
        tempDir,
      );

      expect(res.symbol).toBe('greet');
      expect(res.kind).toBe('function');
      expect(res.startLine).toBe(1);
      expect(res.endLine).toBe(6);
      expect(res.rawText).toContain('export const greet');
      expect(res.rawText).toContain('return "Hello " + name;');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reads a Python function via Tree-Sitter', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-py-'));
    const filePath = path.join(tempDir, 'app.py');

    const source = `# Module comment

# Leading function comment
def fetch_user(user_id):
    """Fetch user by id."""
    query = f"SELECT * FROM users WHERE id = {user_id}"
    return query

def uncalled():
    pass
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const res = await readSymbolInFile(
        {
          file: filePath,
          symbol: 'fetch_user',
          includeDocs: true,
        },
        tempDir,
      );

      expect(res.symbol).toBe('fetch_user');
      expect(res.kind).toBe('function');
      expect(res.startLine).toBe(3);
      expect(res.endLine).toBe(7);
      expect(res.rawText).toContain('# Leading function comment');
      expect(res.rawText).toContain('def fetch_user(user_id):');
      expect(res.rawText).toContain('Fetch user by id.');
      expect(res.rawText).not.toContain('def uncalled():');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws an ambiguity error when multiple declarations match', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-ambig-'));
    const filePath = path.join(tempDir, 'calc.ts');

    const source = `export class Foo {
  calc(): number { return 1; }
}
export class Bar {
  calc(): number { return 2; }
}
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      await expect(readSymbolInFile({ file: filePath, symbol: 'calc' }, tempDir)).rejects.toThrow(
        /ambiguous/i,
      );

      // Disambiguated by qualified name works
      const disambiguated = await readSymbolInFile({ file: filePath, symbol: 'Foo.calc' }, tempDir);
      expect(disambiguated.symbol).toBe('Foo.calc');
      expect(disambiguated.rawText).toContain('return 1;');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('executes codebase-read-symbol tool successfully through Tool.execute', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ast-read-tool-'));
    const filePath = path.join(tempDir, 'service.ts');

    const source = `export function runJob(): boolean {
  return true;
}
`;
    await fs.writeFile(filePath, source, 'utf8');

    try {
      const out = await codebaseReadSymbolTool.execute(
        {
          file: 'service.ts',
          symbol: 'runJob',
        },
        {
          cwd: tempDir,
          projectRoot: tempDir,
        } as never,
        { signal: new AbortController().signal },
      );

      expect(out.symbol).toBe('runJob');
      expect(out.startLine).toBe(1);
      expect(out.endLine).toBe(3);
      expect(out.totalLines).toBe(3);
      expect(out.text).toBe('1→export function runJob(): boolean {\n2→  return true;\n3→}');
      expect(out).not.toHaveProperty('rawText');
      expect(JSON.stringify(out).match(/return true;/g)).toHaveLength(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('validates tool inputs and throws validation errors on missing fields', async () => {
    await expect(
      codebaseReadSymbolTool.execute(
        { file: '', symbol: 'foo' },
        { projectRoot: process.cwd() } as never,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/file is required/);

    await expect(
      codebaseReadSymbolTool.execute(
        { file: 'foo.ts', symbol: '' },
        { projectRoot: process.cwd() } as never,
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/symbol is required/);
  });
});
