import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateTraceEval } from '../src/trace-eval.js';
import type { TranscriptEvalSpec } from '../src/types.js';

const spec: TranscriptEvalSpec = {
  source: {
    sessionId: 'source-session',
    transcriptPath: '/corpus/source-session.jsonl',
    sha256: 'a'.repeat(64),
    eventStart: 3,
    eventEnd: 8,
  },
  retrieval: [{ toolNames: ['read'], contains: 'legacy handler' }],
  recall: {
    toolNames: ['edit'],
    inputContains: ['src/handler.ts', 'modern handler'],
  },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeSession(events: unknown[]): Promise<{ homeDir: string; workdir: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-trace-eval-'));
  tempDirs.push(base);
  const homeDir = path.join(base, 'home');
  const workdir = path.join(base, 'work');
  await fs.mkdir(workdir, { recursive: true });
  const sessionsDir = resolveWstackPaths({
    projectRoot: workdir,
    globalRoot: homeDir,
  }).projectSessions;
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, 'sess_trace.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n'),
    'utf8',
  );
  return { homeDir, workdir };
}

describe('evaluateTraceEval', () => {
  it('attributes a correct intent with a failed application to tooling', async () => {
    const dirs = await writeSession([
      { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'src/handler.ts' } },
      { type: 'tool_result', id: 'read-1', content: 'legacy handler', isError: false },
      {
        type: 'tool_use',
        id: 'correct-edit',
        name: 'edit',
        input: { path: 'src/handler.ts', newText: 'modern handler' },
      },
      { type: 'tool_call_end', id: 'correct-edit', name: 'edit', ok: false },
      { type: 'tool_use', id: 'wrong-edit', name: 'edit', input: { path: 'other.ts' } },
      { type: 'tool_call_end', id: 'wrong-edit', name: 'edit', ok: true },
    ]);

    await expect(evaluateTraceEval({ ...dirs, spec })).resolves.toEqual({
      sourceSessionId: 'source-session',
      retrievalPassed: true,
      recallPassed: true,
      editApplicationPassed: false,
    });
  });

  it('requires successful retrieval before the case advances through the funnel', async () => {
    const dirs = await writeSession([
      { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'src/handler.ts' } },
      { type: 'tool_result', id: 'read-1', content: 'unrelated content', isError: false },
      {
        type: 'tool_use',
        id: 'correct-edit',
        name: 'edit',
        input: { path: 'src/handler.ts', newText: 'modern handler' },
      },
      { type: 'tool_call_end', id: 'correct-edit', name: 'edit', ok: true },
    ]);

    await expect(evaluateTraceEval({ ...dirs, spec })).resolves.toMatchObject({
      retrievalPassed: false,
      recallPassed: true,
      editApplicationPassed: true,
    });
  });
});
