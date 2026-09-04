import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runWstack } from '../src/runner.js';
import type { ModelCell } from '../src/types.js';

const cell: ModelCell = { label: 'fake', provider: 'anthropic', model: 'claude-opus-4-8' };
let dir: string;
let n = 0;

async function fakeEntry(body: string): Promise<string> {
  const p = path.join(dir, `fake-${n++}.cjs`);
  await fs.writeFile(p, body, 'utf8');
  return p;
}

function run(entry: string, over: Partial<Parameters<typeof runWstack>[0]> = {}) {
  return runWstack({
    nodeBin: process.execPath,
    wstackEntry: entry,
    homeDir: dir,
    workdir: dir,
    cell,
    prompt: 'do it',
    timeoutMs: 10_000,
    ...over,
  });
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-extra-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const realPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});

describe('runWstack error paths', () => {
  it('returns crashed when spawn throws synchronously', async () => {
    const entry = await fakeEntry('process.exit(0);');
    const res = await run(entry, { nodeBin: `bad${String.fromCharCode(0)}node` });
    expect(res.status).toBe('crashed');
    expect(res.exitCode).toBeNull();
  });

  it('returns crashed when the process emits an error event', async () => {
    const entry = await fakeEntry('process.exit(0);');
    const res = await run(entry, { nodeBin: 'definitely-not-a-real-node-binary-xyz' });
    expect(res.status).toBe('crashed');
  });

  it('collects stderr without affecting a valid result', async () => {
    const entry = await fakeEntry(
      'process.stderr.write("a warning\\n");' +
        'console.log(JSON.stringify({status:"completed",finalText:"ok",usage:{iterations:1,input:5,output:2,cost:0.01}}));',
    );
    const res = await run(entry);
    expect(res.status).toBe('completed');
    expect(res.iterations).toBe(1);
  });
});

describe('parseOutputJson via runWstack', () => {
  it('ignores a brace line that is not valid JSON', async () => {
    const entry = await fakeEntry('console.log("{ not valid json"); process.exit(0);');
    const res = await run(entry);
    expect(res.status).toBe('crashed'); // no parseable payload
  });

  it('ignores a JSON line with no string status', async () => {
    const entry = await fakeEntry('console.log(JSON.stringify({foo:1})); process.exit(0);');
    const res = await run(entry);
    expect(res.status).toBe('crashed');
  });

  it('normalizes an unknown status to failed', async () => {
    const entry = await fakeEntry(
      'console.log(JSON.stringify({status:"weird"})); process.exit(0);',
    );
    const res = await run(entry);
    expect(res.status).toBe('failed');
  });

  it('passes through known statuses and defaults missing usage to zero', async () => {
    const entry = await fakeEntry(
      'console.log(JSON.stringify({status:"max_iterations"})); process.exit(0);',
    );
    const res = await run(entry);
    expect(res.status).toBe('max_iterations');
    expect(res.iterations).toBe(0);
    expect(res.costUsd).toBe(0);
  });
});

describe('mapWithConcurrency edge cases', () => {
  it('handles an empty item list', async () => {
    const { mapWithConcurrency } = await import('../src/runner.js');
    expect(await mapWithConcurrency([], 4, async (x) => x)).toEqual([]);
  });
});

describe('treeKill (POSIX branch)', () => {
  it('SIGTERM-kills a hung process when platform is posix', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const entry = await fakeEntry('setTimeout(() => {}, 30000);');
    const res = await run(entry, { timeoutMs: 200 });
    expect(res.status).toBe('timeout');
  });
});
