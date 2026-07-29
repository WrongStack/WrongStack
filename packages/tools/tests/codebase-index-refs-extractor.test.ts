import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileBehavior, execFileMock, mkdtempMock, writeFileMock } = vi.hoisted(() => {
  const behavior = vi.fn();
  const execFile = vi.fn(
    (
      command: string,
      args: string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      try {
        callback(null, behavior(command, args, options), '');
      } catch (error) {
        callback(error as Error, '', '');
      }
      return {};
    },
  );
  return {
    execFileBehavior: behavior,
    execFileMock: execFile,
    mkdtempMock: vi.fn(async () => '/tmp/ws-refs-test'),
    writeFileMock: vi.fn(async () => undefined),
  };
});

vi.mock('node:child_process', async (orig) => ({
  ...(await orig<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

vi.mock('node:fs/promises', async (orig) => ({
  ...(await orig<typeof import('node:fs/promises')>()),
  mkdtemp: mkdtempMock,
  writeFile: writeFileMock,
}));

import { extractRefs } from '../src/codebase-index/refs-extractor.js';

beforeEach(() => {
  execFileBehavior.mockReset();
  execFileMock.mockClear();
  mkdtempMock.mockReset().mockResolvedValue('/tmp/ws-refs-test');
  writeFileMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('extractRefs language dispatch', () => {
  it('returns [] for TS/JS-family languages (handled by ts-parser)', async () => {
    for (const lang of ['ts', 'tsx', 'js', 'jsx'] as const) {
      expect(await extractRefs({ file: 'a.ts', content: 'x', lang })).toEqual([]);
    }
    expect(execFileBehavior).not.toHaveBeenCalled();
  });

  it('returns [] for unsupported languages', async () => {
    expect(await extractRefs({ file: 'a.json', content: '{}', lang: 'json' })).toEqual([]);
  });
});

describe('extractRefs go', () => {
  it('parses go runner JSON output into Ref[]', async () => {
    execFileBehavior.mockReturnValue(
      JSON.stringify([{ toName: 'fmt.Println', callType: 'call', line: 3 }]),
    );
    const refs = await extractRefs({ file: 'main.go', content: '', lang: 'go' });
    expect(refs).toEqual([{ fromId: 0, toName: 'fmt.Println', callType: 'call', line: 3 }]);
    expect(execFileBehavior).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('refs.exe'),
      ['main.go'],
      expect.any(Object),
    );
  });

  it('returns [] when the runner emits empty output', async () => {
    execFileBehavior.mockReturnValue('   ');
    expect(await extractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
  });

  it('returns [] when the runner output is not valid JSON', async () => {
    execFileBehavior.mockReturnValue('not json');
    expect(await extractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
  });

  it('returns [] when the runner throws', async () => {
    execFileBehavior.mockImplementation(() => {
      throw new Error('go not installed');
    });
    expect(await extractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
  });

  it('caches a failed compilation while retaining the go run fallback', async () => {
    vi.resetModules();
    const { extractRefs: freshExtractRefs } = await import('../src/codebase-index/refs-extractor.js');
    execFileBehavior.mockImplementation((command: string, args: string[]) => {
      if (command === 'go' && args[0] === 'build') throw new Error('compiler unavailable');
      return '[]';
    });

    await freshExtractRefs({ file: 'first.go', content: '', lang: 'go' });
    await freshExtractRefs({ file: 'second.go', content: '', lang: 'go' });

    const buildCalls = execFileBehavior.mock.calls.filter(
      ([command, args]) => command === 'go' && (args as string[])[0] === 'build',
    );
    expect(buildCalls).toHaveLength(1);
    expect(execFileBehavior).toHaveBeenNthCalledWith(
      2,
      'go',
      ['run', expect.stringContaining('refs.go'), 'first.go'],
      expect.any(Object),
    );
    expect(execFileBehavior).toHaveBeenNthCalledWith(
      3,
      'go',
      ['run', expect.stringContaining('refs.go'), 'second.go'],
      expect.any(Object),
    );
  });

  it('returns [] when Go helper initialization fails', async () => {
    vi.resetModules();
    const { extractRefs: freshExtractRefs } = await import('../src/codebase-index/refs-extractor.js');
    mkdtempMock.mockRejectedValue(new Error('temp directory unavailable'));

    expect(await freshExtractRefs({ file: 'main.go', content: '', lang: 'go' })).toEqual([]);
    expect(execFileBehavior).not.toHaveBeenCalled();
  });
});

describe('extractRefs python', () => {
  it('parses python runner JSON output into Ref[]', async () => {
    execFileBehavior.mockReturnValue(
      JSON.stringify([{ toName: 'os.path', callType: 'import', line: 1 }]),
    );
    const refs = await extractRefs({ file: 'a.py', content: '', lang: 'py' });
    expect(refs).toEqual([{ fromId: 0, toName: 'os.path', callType: 'import', line: 1 }]);
  });

  it('returns [] on empty python output', async () => {
    execFileBehavior.mockReturnValue('');
    expect(await extractRefs({ file: 'a.py', content: '', lang: 'py' })).toEqual([]);
  });

  it('returns [] when the python runner throws', async () => {
    execFileBehavior.mockImplementation(() => {
      throw new Error('python missing');
    });
    expect(await extractRefs({ file: 'a.py', content: '', lang: 'py' })).toEqual([]);
  });

  it('returns [] when Python helper initialization fails', async () => {
    vi.resetModules();
    const { extractRefs: freshExtractRefs } = await import('../src/codebase-index/refs-extractor.js');
    writeFileMock.mockRejectedValue(new Error('temp script unavailable'));

    expect(await freshExtractRefs({ file: 'a.py', content: '', lang: 'py' })).toEqual([]);
    // resolvePythonCommand() runs before initializePythonRunner(), so one
    // execFile call for `python3 --version` is expected even when the runner
    // script initialization fails afterward.
    expect(execFileBehavior).toHaveBeenCalledTimes(1);
    expect(execFileBehavior).toHaveBeenCalledWith(
      'python3',
      ['--version'],
      expect.any(Object),
    );
  });
});
