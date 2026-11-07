import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mineTranscript } from '../src/transcript-mine.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bench-transcript-mine-'));
  tempDirs.push(dir);
  return dir;
}

describe('mineTranscript', () => {
  it('copies a real JSONL and emits a curator-ready draft for each edit attempt', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'source.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'sess/source', model: 'x', provider: 'p' },
        { type: 'user_input', content: 'Modernize the legacy handler.' },
        { type: 'tool_use', id: 'read-1', name: 'read', input: { path: 'src/handler.ts' } },
        {
          type: 'tool_result',
          id: 'read-1',
          content: 'export const handler = legacyHandler;',
          isError: false,
        },
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'edit',
          input: {
            path: 'src/handler.ts',
            oldText: 'legacyHandler',
            newText: 'modernHandler',
          },
        },
        { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: false },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const outDir = path.join(dir, 'evals');
    const result = await mineTranscript({ transcriptPath, outDir });

    expect(result.sessionId).toBe('sess/source');
    expect(result.candidates).toHaveLength(1);
    expect(result.copiedTranscriptPath).toContain(path.join('corpus', 'sess-source-'));
    expect(await fs.readFile(result.copiedTranscriptPath, 'utf8')).toBe(raw);
    expect(result.candidates[0]).toMatchObject({
      id: 'sess-source-edit-1',
      prompt: 'Modernize the legacy handler.',
      observed: { toolName: 'edit', toolUseId: 'edit-1', toolApplied: false },
      traceEval: {
        source: {
          sessionId: 'sess/source',
          transcriptPath: expect.stringMatching(/^\.\/corpus\//),
          sha256: createHash('sha256').update(raw).digest('hex'),
          eventStart: 1,
          eventEnd: 5,
        },
        retrieval: [{ toolNames: ['read'], contains: 'export const handler = legacyHandler;' }],
        recall: { toolNames: ['edit'], inputContains: ['src/handler.ts', 'modernHandler'] },
      },
    });
    expect(result.candidates[0]?.needsCuration).toHaveLength(1);

    const draft = JSON.parse(await fs.readFile(result.draftsPath, 'utf8')) as {
      candidates: unknown[];
    };
    expect(draft.candidates).toHaveLength(1);
  });

  it('captures retrieval by the registry-s spelling of index tools (hyphen or underscore)', async () => {
    const dir = await tempDir();
    // The native registry registers 'codebase-search' (builtin.ts, hyphen)
    // while the MCP surface spells it 'codebase_search' (underscore). Both are
    // retrieval evidence; an exact-only compare against the underscore set
    // silently dropped every native-session retrieval and emitted the false
    // curation note 'no successful retrieval result preceded this edit'.
    const writeSession = async (retrievalName: string): Promise<string> => {
      const transcriptPath = path.join(dir, `session-${retrievalName}.jsonl`);
      const raw =
        [
          { type: 'session_start', id: `sess/${retrievalName}` },
          { type: 'user_input', content: 'Find and modernize parseCells.' },
          { type: 'tool_use', id: 'q-1', name: retrievalName, input: { query: 'parseCells' } },
          {
            type: 'tool_result',
            id: 'q-1',
            content: 'src/markdown-table.ts: parseCells() at L42',
            isError: false,
          },
          {
            type: 'tool_use',
            id: 'edit-1',
            name: 'edit',
            input: { path: 'src/markdown-table.ts', newText: 'folded' },
          },
          { type: 'tool_call_end', id: 'edit-1', name: 'edit', ok: true },
        ]
          .map((event) => JSON.stringify(event))
          .join('\n') + '\n';
      await fs.writeFile(transcriptPath, raw, 'utf8');
      return transcriptPath;
    };

    const native = await mineTranscript({
      transcriptPath: await writeSession('codebase-search'),
      outDir: path.join(dir, 'evals-native'),
    });
    expect(native.candidates[0]?.traceEval.retrieval).toEqual([
      { toolNames: ['codebase-search'], contains: 'src/markdown-table.ts: parseCells() at L42' },
    ]);
    expect(
      native.candidates[0]?.needsCuration.some((note) => /no successful retrieval/i.test(note)),
    ).toBe(false);

    const mcp = await mineTranscript({
      transcriptPath: await writeSession('codebase_search'),
      outDir: path.join(dir, 'evals-mcp'),
    });
    expect(mcp.candidates[0]?.traceEval.retrieval).toEqual([
      { toolNames: ['codebase_search'], contains: 'src/markdown-table.ts: parseCells() at L42' },
    ]);
  });

  it('mines hyphenated edit tools (multi-edit, str-replace, apply-patch) into candidates (F90)', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'hyphen-edit.jsonl');
    const raw =
      [
        { type: 'session_start', id: 'sess/hyphen-edit' },
        { type: 'user_input', content: 'Patch the handler.' },
        {
          type: 'tool_use',
          id: 'edit-1',
          name: 'multi-edit',
          input: { path: 'src/handler.ts', newText: 'updated' },
        },
        { type: 'tool_call_end', id: 'edit-1', name: 'multi-edit', ok: true },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n';
    await fs.writeFile(transcriptPath, raw, 'utf8');

    const mined = await mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals-hyphen') });
    expect(mined.candidates).toHaveLength(1);
    expect(mined.candidates[0]?.observed.toolName).toBe('multi-edit');
  });

  it('refuses a non-session JSONL rather than fabricating provenance', async () => {
    const dir = await tempDir();
    const transcriptPath = path.join(dir, 'not-a-session.jsonl');
    await fs.writeFile(
      transcriptPath,
      JSON.stringify({ type: 'tool_use', id: 'x', name: 'edit' }),
      'utf8',
    );

    await expect(
      mineTranscript({ transcriptPath, outDir: path.join(dir, 'evals') }),
    ).rejects.toThrow(/no session_start\/session_resumed id/);
  });
});
