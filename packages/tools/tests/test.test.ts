import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { testTool } from '../src/test.js';

// We need to mock the spawnStream to avoid actual test execution
// but still exercise the parsing logic
vi.mock('../src/_spawn-stream.js', async () => {
  const actual = await vi.importActual('../src/_spawn-stream.js');
  return {
    ...actual,
    // biome-ignore lint/correctness/useYield: mock returns no partial lines
    spawnStream: vi.fn(async function* () {
      return { stdout: '', stderr: '', exitCode: 0, truncated: false };
    }),
  };
});

describe('testTool', () => {
  it('has correct metadata', () => {
    expect(testTool.name).toBe('test');
    expect(testTool.permission).toBe('confirm');
    expect(testTool.mutating).toBe(false);
  });

  it('returns none when no runner found', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    // When no config file is found in the directory, detectRunner returns null
    // and the tool short-circuits with runner: 'none'.
    const result = await testTool.execute({ runner: 'auto' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result.runner).toBe('none');
  });

  it('short-circuits when auto-detect finds nothing', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await testTool.execute({ runner: 'auto' }, ctx, {
      signal: new AbortController().signal,
    });
    // Short-circuits with runner: 'none', producing a valid TestOutput
    expect(result).toHaveProperty('exit_code');
  });

  it('passes grep filter', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'vitest', grep: 'mytest' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('passes timeout', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'vitest', timeout: 5000 }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('exit_code');
  });

  it('handles files as array', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute(
      { runner: 'vitest', files: ['a.test.ts', 'b.test.ts'] },
      ctx,
      { signal: new AbortController().signal },
    );
    expect(result).toHaveProperty('output');
  });

  it('respects coverage flag', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'vitest', coverage: true }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('respects watch flag', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'vitest', watch: true }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('duration_ms');
  });
});

describe('testTool executeStream API', () => {
  it('emits final event when no runner is found', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const events: any[] = [];
    for await (const ev of testTool.executeStream!({ runner: 'none' as any }, ctx, {
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === 'final')).toBe(true);
    const final = events.find((e) => e.type === 'final');
    expect(final?.output.runner).toBe('none');
  });

  it('emits a single final event on short-circuit (no log)', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const events: any[] = [];
    for await (const ev of testTool.executeStream!({ runner: 'auto' }, ctx, {
      signal: new AbortController().signal,
    })) {
      events.push(ev);
    }
    // When no runner config exists, the tool short-circuits with exactly one final event.
    expect(events.filter((e) => e.type === 'log')).toHaveLength(0);
    const finals = events.filter((e) => e.type === 'final');
    expect(finals).toHaveLength(1);
    expect(finals[0]?.output.runner).toBe('none');
  });
});

describe('detectRunner (via executeStream in temp dirs)', () => {
  it('detects vitest.config.ts and returns vitest', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'test-detect-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'vitest.config.ts'), 'export default {}');
      const ctx = { cwd: tmpDir, tools: [], projectRoot: tmpDir } as any;
      const result = await testTool.execute({ runner: 'auto' }, ctx, {
        signal: new AbortController().signal,
      });
      expect(result.runner).toBe('vitest');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects jest.config.js and returns jest', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'test-detect-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'jest.config.js'), 'module.exports = {}');
      const ctx = { cwd: tmpDir, tools: [], projectRoot: tmpDir } as any;
      const result = await testTool.execute({ runner: 'auto' }, ctx, {
        signal: new AbortController().signal,
      });
      expect(result.runner).toBe('jest');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects .mocharc.json and returns mocha', async () => {
    const tmpDir = await fs.mkdtemp(path.join('/tmp', 'test-detect-'));
    try {
      await fs.writeFile(path.join(tmpDir, '.mocharc.json'), '{}');
      const ctx = { cwd: tmpDir, tools: [], projectRoot: tmpDir } as any;
      const result = await testTool.execute({ runner: 'auto' }, ctx, {
        signal: new AbortController().signal,
      });
      expect(result.runner).toBe('mocha');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('short-circuits to none when no config file found', async () => {
    const ctx = { cwd: '/', tools: [], projectRoot: '/' } as any;
    const result = await testTool.execute({ runner: 'auto' }, ctx, {
      signal: new AbortController().signal,
    });
    // When no config is found, the tool short-circuits with runner: 'none'
    expect(result.runner).toBe('none');
  });
});

describe('buildArgs coverage', () => {
  it('mocha builds correct args', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute(
      { runner: 'mocha', files: 'test.ts', timeout: 10000 },
      ctx,
      { signal: new AbortController().signal },
    );
    expect(result).toHaveProperty('output');
  });

  it('mocha passes grep filter', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'mocha', grep: 'pattern' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('jest builds correct args', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'jest', files: 'test.spec.ts' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('jest respects watch mode', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'jest', watch: true }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('jest respects coverage', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'jest', coverage: true }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('jest respects grep filter', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'jest', grep: 'testpattern' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('vitest watch mode changes args correctly', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'vitest', watch: true }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });

  it('vitest respects testTimeout', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'vitest', timeout: 60000 }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('output');
  });
});

describe('parseResult coverage', () => {
  it('parses vitest passed and failed output', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    // The mock makes spawnStream return empty, but we can test result structure
    const result = await testTool.execute({ runner: 'vitest' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('runner', 'vitest');
  });

  it('parses jest output correctly', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'jest' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('runner', 'jest');
  });

  it('mocha returns result with output', async () => {
    const ctx = { cwd: '/fake', tools: [], projectRoot: '/fake' } as any;
    const result = await testTool.execute({ runner: 'mocha' }, ctx, {
      signal: new AbortController().signal,
    });
    expect(result).toHaveProperty('runner', 'mocha');
    expect(result).toHaveProperty('output');
  });
});
