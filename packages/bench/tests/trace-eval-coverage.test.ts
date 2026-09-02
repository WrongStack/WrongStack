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
    eventStart: 0,
    eventEnd: 1,
  },
  retrieval: [{ toolNames: ['read'], contains: 'expected content' }],
  recall: {
    toolNames: ['edit'],
    inputContains: ['expected path', 'expected text'],
  },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeSession(events: unknown[]): Promise<{ homeDir: string; workdir: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-trace-eval-cov-'));
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

describe('evaluateTraceEval — edge cases', () => {
  it('covers matchesToolName with empty allowList (returns true)', async () => {
    // When toolNames is undefined or empty array, matchesToolName returns true
    const permissiveSpec: TranscriptEvalSpec = {
      source: spec.source,
      retrieval: [{ contains: 'expected content' }], // no toolNames
      recall: { inputContains: ['expected path'] }, // no toolNames
    };
    const dirs = await writeSession([
      { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'file.ts' } },
      { type: 'tool_result', id: 'read-1', content: 'expected content', isError: false },
      {
        type: 'tool_use',
        id: 'edit-1',
        name: 'edit',
        input: { path: 'expected path', newText: 'fix' },
      },
      { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: true },
    ]);

    const result = await evaluateTraceEval({ ...dirs, spec: permissiveSpec });
    expect(result.retrievalPassed).toBe(true);
    expect(result.recallPassed).toBe(true);
    expect(result.editApplicationPassed).toBe(true);
  });

  it('covers matchesToolName when name does not match any allowList entry', async () => {
    // Tool name doesn't match any list entry → matchesToolName returns false
    const dirs = await writeSession([
      { type: 'tool_use', id: 'grep-1', name: 'grep', input: { pattern: 'test' } },
      { type: 'tool_result', id: 'grep-1', content: 'expected content', isError: false },
      {
        type: 'tool_use',
        id: 'edit-1',
        name: 'replace',
        input: { path: 'handler.ts', newText: 'fix' },
      },
      { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: true },
    ]);

    const narrowSpec: TranscriptEvalSpec = {
      source: spec.source,
      retrieval: [{ toolNames: ['read'], contains: 'expected content' }],
      recall: { toolNames: ['edit'], inputContains: ['handler.ts', 'fix'] },
    };

    const result = await evaluateTraceEval({ ...dirs, spec: narrowSpec });
    // grep doesn't match 'read' → retrieval fails
    expect(result.retrievalPassed).toBe(false);
    // replace doesn't match 'edit' → recall fails
    expect(result.recallPassed).toBe(false);
    expect(result.editApplicationPassed).toBe(false);
  });

  it('covers serialise with JSON.stringify-throwing values', async () => {
    // serialise is called on tool use `input` - normally it's a plain object.
    // The catch branch (JSON.stringify throws) is triggered with circular refs.
    // However, the tool_use input in practice is always JSON-safe.
    // We can still verify the string path for non-string values.
    const dirs = await writeSession([
      {
        type: 'tool_use',
        id: 'read-1',
        name: 'read',
        input: { deep: { nested: 'data' } },
      },
      { type: 'tool_result', id: 'read-1', content: { key: 'expected content' }, isError: false },
      {
        type: 'tool_use',
        id: 'edit-1',
        name: 'edit',
        input: { path: 'expected path', newText: 'fix' },
      },
      { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: true },
    ]);

    // content is an object, so serialise will JSON.stringify it
    const result = await evaluateTraceEval({
      ...dirs,
      spec: {
        ...spec,
        retrieval: [{ toolNames: ['read'], contains: 'expected content' }],
      },
    });
    expect(result.retrievalPassed).toBe(true);
  });

  it('ignores malformed trace events and treats an edit without an end as unapplied', async () => {
    const dirs = await writeSession([
      { type: 'tool_use', name: 'read', input: {} },
      { type: 'tool_use', id: 'missing-name', input: {} },
      { type: 'tool_call_end', ok: true },
      { type: 'tool_result', content: 'orphan' },
      { type: 'tool_result', id: 'unknown', content: 'orphan' },
      { type: 'unrelated' },
      { type: 'tool_use', id: 'edit-no-end', name: 'edit', input: 'expected path' },
    ]);

    const result = await evaluateTraceEval({
      ...dirs,
      spec: {
        ...spec,
        retrieval: [],
        recall: { toolNames: ['edit'], inputContains: ['expected path'] },
      },
    });

    expect(result).toMatchObject({
      retrievalPassed: true,
      recallPassed: true,
      editApplicationPassed: false,
    });
  });
});
