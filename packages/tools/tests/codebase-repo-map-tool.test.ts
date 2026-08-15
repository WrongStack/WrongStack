import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { codebaseRepoMapTool, generateRepoMap } from '../src/codebase-index/index.js';

describe('codebase-repo-map tool & generator', () => {
  it('generates a reference-weighted repository map for a directory structure', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-test-'));

    // Create a mini project layout
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });

    await fs.writeFile(
      path.join(srcDir, 'index.ts'),
      `
import { UserService } from './user-service.js';
import { Config } from './config.js';

export class App {
  private service: UserService;
  constructor(config: Config) {
    this.service = new UserService(config);
  }
  public start(): void {
    console.log('App starting');
  }
}
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(srcDir, 'user-service.ts'),
      `
export interface User {
  id: string;
  name: string;
}

export class UserService {
  public getUser(id: string): User | null {
    return { id, name: 'Alice' };
  }
}
`,
      'utf8',
    );

    await fs.writeFile(
      path.join(srcDir, 'config.ts'),
      `
export interface Config {
  port: number;
  env: string;
}
`,
      'utf8',
    );

    try {
      const result = await generateRepoMap({
        projectRoot: tempDir,
        maxTokens: 1000,
      });

      expect(result.filesCount).toBeGreaterThanOrEqual(2);
      expect(result.map).toContain('src/index.ts');
      expect(result.map).toContain('export class App');
      expect(result.map).toContain('public start(): void');
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.rankedFiles.length).toBeGreaterThanOrEqual(2);

      // Test tool execution
      const toolOutput = await codebaseRepoMapTool.execute({}, { projectRoot: tempDir } as never, {
        signal: new AbortController().signal,
      });
      expect(toolOutput.status).toBe('ok');
      expect(toolOutput.filesCount).toBe(result.filesCount);
      expect(toolOutput.map).toContain('src/index.ts');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('respects token budget and limits output size', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'repomap-budget-test-'));
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(srcDir, { recursive: true });

    // Create 10 files
    for (let i = 0; i < 10; i++) {
      await fs.writeFile(
        path.join(srcDir, `module_${i}.ts`),
        `export function fn_${i}(): number {\n  const x = ${i};\n  return x;\n}`,
        'utf8',
      );
    }

    try {
      const tightResult = await generateRepoMap({
        projectRoot: tempDir,
        maxTokens: 30, // very tight budget
      });

      expect(tightResult.estimatedTokens).toBeLessThanOrEqual(50);
      expect(tightResult.filesCount).toBeLessThan(10);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
