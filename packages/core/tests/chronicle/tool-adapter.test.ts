import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { ToolErrorCategory } from '@wrongstack/contracts/types/tool';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChronicleJournal,
  ChronicleQueryEngine,
  createChronicleContext,
  wireToolsToChronicle,
} from '../../src/chronicle/index.js';

const tempDirs: string[] = [];
const scrubber = {
  scrub: (value: string) => value.replaceAll('SECRET', '[REDACTED]'),
  scrubObject: <T>(obj: T): T => obj,
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * The journal / bus / context trio every test in this file needs.
 *
 * This was six near-identical lines at 19 sites. Beyond the duplicate-code flag,
 * the copies had drifted: some captured the unsubscribe function and some did
 * not, some passed a `sessionId` and some did not — so a fix applied to one was
 * silently absent from the rest. One factory keeps every test on the same shape.
 *
 * `label` is the full temp-dir prefix (trailing dash included) and `file` the
 * journal filename, so a leaked fixture names the test that made it and a test
 * needing its own journal file can still ask for one.
 */
async function makeHarness(
  label: string,
  file: string,
  identity: Parameters<typeof createChronicleContext>[0],
  scope: string,
): Promise<{
  dir: string;
  journal: ChronicleJournal;
  events: EventBus;
  off: () => void;
}> {
  const dir = await mkdtemp(path.join(os.tmpdir(), label));
  tempDirs.push(dir);
  const journal = new ChronicleJournal({ filePath: path.join(dir, file) });
  const events = new EventBus();
  const context = createChronicleContext(identity, scope);
  return {
    dir,
    journal,
    events,
    off: wireToolsToChronicle({ events, journal, context, scrubber }),
  };
}

describe('wireToolsToChronicle', () => {
  it('persists loop diagnostics with the model identity without copying the context', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-loop-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 's' },
      't',
    );
    events.emit('tool.loop_detected', {
      sessionId: 's',
      ctx: {
        agentId: 'a',
        provider: { id: 'p' },
        model: 'm',
        privateField: 'secret-context',
      } as never,
      tools: 'read',
      repeatCount: 3,
      iteration: 4,
      action: 'steer',
    });
    const records = await journal.readAll();
    off();
    expect(records[0]).toMatchObject({
      eventType: 'tool.loop_detected',
      scope: { sessionId: 's', agentId: 'a' },
      runtime: { providerId: 'p', modelId: 'm' },
      attributes: { repeatCount: 3, action: 'steer' },
    });
    expect(JSON.stringify(records)).not.toContain('secret-context');
  });
  it('retains compact read line counts even when the result preview is truncated', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-file-stats-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 's' },
      't',
    );
    events.emit('tool.executed', {
      sessionId: 's',
      agentId: 'a',
      name: 'read',
      id: 'r',
      ok: true,
      durationMs: 20,
      output: JSON.stringify({
        text: Array.from({ length: 100 }, (_, i) => `${i + 1}→${'x'.repeat(40)}`).join('\n'),
        total_lines: 200,
      }),
    });
    const records = await journal.readAll();
    off();
    expect(records[0]?.attributes?.fileStats).toEqual({ readLines: 100, totalLines: 200 });
    // The preview is over budget here, so capPreview returns its summary OBJECT.
    // `String(object)` is always "[object Object]" — a length check on that can
    // never fail, which is exactly what this assertion used to assert. Assert
    // the shape, then the budget on the field that actually carries text.
    const preview = records[0]?.attributes?.outputPreview;
    expect(preview).toMatchObject({ truncated: true });
    const previewText =
      typeof preview === 'string' ? preview : ((preview as { preview?: string }).preview ?? '');
    expect(previewText.length).toBeLessThanOrEqual(2048);
  });
  it('records scrubbed lifecycle data (resource edges are windowed by rollup-adapter.ts, not persisted raw here)', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-tool-',
      'events.jsonl',
      {
        installationId: 'install',
        machineId: 'machine',
        projectId: 'project',
        sessionId: 'session',
      },
      'trace',
    );

    events.emit('tool.started', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      name: 'read',
      id: 'tool-1',
      input: { path: 'src/auth.ts', token: 'SECRET' },
    });
    events.emit('tool.progress', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      name: 'edit',
      id: 'tool-1',
      event: {
        type: 'file_changed',
        path: 'src/auth.ts',
        operation: 'edit',
        line: 72,
        endLine: 91,
      },
    });
    events.emit('tool.executed', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-1',
      name: 'read',
      durationMs: 12.5,
      ok: true,
      output: 'result SECRET',
      outputBytes: 20,
      outputTokens: 5,
      outputLines: 2,
      metadata: {
        toolUseId: 'tool-1',
        toolName: 'read',
        ok: true,
        summary: 'read auth',
        files: ['src/auth.ts'],
        symbols: ['AuthService.login'],
        commands: ['rg SECRET src'],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded.map((event) => event.eventType)).toEqual([
      'tool.started',
      'file.mutation.observed',
      'tool.executed',
    ]);
    expect(recorded[0]?.attributes?.['input']).toContain('[REDACTED]');
    expect(recorded[2]?.attributes?.['outputPreview']).toBe('result [REDACTED]');
    expect(recorded[1]?.resource).toMatchObject({
      kind: 'file',
      path: 'src/auth.ts',
      lineStart: 72,
      lineEnd: 91,
    });
    // tool.executed still carries the raw metadata so rollup-adapter.ts can
    // window it into a bounded tool.resource.observed rollup.
    expect(recorded[2]?.attributes?.['metadata']).toMatchObject({
      files: ['src/auth.ts'],
      symbols: ['AuthService.login'],
      commands: ['rg SECRET src'],
    });
    expect(recorded.every((event) => event.correlation.toolCallId === 'tool-1')).toBe(true);
    await expect(journal.verify()).resolves.toMatchObject({ ok: true, entries: 3 });
  });

  it('records executor failures separately from model-facing tool results', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-tool-failure-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    events.emit('tool.failed', {
      name: 'bash',
      id: 'tool-fail',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 300,
      category: ToolErrorCategory.TRANSIENT,
      retryable: true,
      detail: 'timed out',
    });

    const recorded = await journal.readAll();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'tool.failed',
      outcome: 'failure',
      durationNs: '300000000',
    });
    expect(recorded[0]?.attributes).toMatchObject({
      toolName: 'bash',
      category: 'transient',
      retryable: true,
    });
    off();
  });

  it('persists files a failed call had already changed on disk', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-partial-write-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    // A `patch --merge` that wrote conflict markers and then threw.
    events.emit('tool.failed', {
      name: 'patch',
      id: 'tool-conflict',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 12,
      category: ToolErrorCategory.TRANSIENT,
      retryable: false,
      detail: 'patch failed: conflict',
      modifiedPaths: ['src/a.ts', 'src/b.ts'],
    });

    const recorded = await journal.readAll();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.attributes).toMatchObject({
      toolName: 'patch',
      modifiedPaths: ['src/a.ts', 'src/b.ts'],
    });
    // A failure never carries line evidence, only presence.
    expect(recorded[0]?.attributes?.fileStats).toBeUndefined();
    off();
  });

  it('omits modifiedPaths when a failed call touched nothing', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-no-partial-write-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    events.emit('tool.failed', {
      name: 'patch',
      id: 'tool-clean-fail',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 5,
      category: ToolErrorCategory.TRANSIENT,
      retryable: false,
      detail: 'patch failed',
      modifiedPaths: [],
    });

    const recorded = await journal.readAll();
    expect(recorded).toHaveLength(1);
    expect('modifiedPaths' in (recorded[0]?.attributes ?? {})).toBe(false);
    off();
  });

  it('caps modifiedPaths and flags the truncation instead of dropping silently', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-modified-cap-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    // Far more files than the cap allows: a patch naming hundreds must not be
    // able to dominate one journal record.
    const paths = Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`);
    events.emit('tool.failed', {
      name: 'patch',
      id: 'tool-many',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 9,
      category: ToolErrorCategory.TRANSIENT,
      retryable: false,
      detail: 'patch failed',
      modifiedPaths: paths,
    });

    const recorded = await journal.readAll();
    const modified = recorded[0]?.attributes?.modifiedPaths as string[] | undefined;
    expect(modified).toHaveLength(64);
    expect(modified?.[0]).toBe('src/file-0.ts');
    // Truncation is announced, so no consumer can read the survivors as a
    // complete manifest of what was damaged.
    expect(recorded[0]?.attributes?.modifiedPathsTruncated).toBe(true);
    off();
  });

  it('does not flag truncation at or below the cap, and scrubs the path strings', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-modified-scrub-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    events.emit('tool.failed', {
      name: 'patch',
      id: 'tool-scrub',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 9,
      category: ToolErrorCategory.TRANSIENT,
      retryable: false,
      detail: 'patch failed',
      modifiedPaths: ['src/MY_SECRET_dir/a.ts'],
    });

    const recorded = await journal.readAll();
    // Paths are operator-supplied text entering a durable journal, so they go
    // through the same scrubber as tool output.
    expect(recorded[0]?.attributes?.modifiedPaths).toEqual(['src/MY_[REDACTED]_dir/a.ts']);
    expect('modifiedPathsTruncated' in (recorded[0]?.attributes ?? {})).toBe(false);
    off();
  });

  it('bounds a single very long path by bytes without breaking the scrub step', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-modified-bound-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    // ONE path far past the per-path byte bound. The secret sits inside the
    // retained prefix, so this only proves the scrub ran over the WHOLE string:
    // had the byte cut run first, the pattern would see a partial path and
    // could leave an unredacted fragment behind.
    const longPath = `src/MY_SECRET/${'seg/'.repeat(300)}tail.ts`;
    expect(Buffer.byteLength(longPath, 'utf8')).toBeGreaterThan(512);

    events.emit('tool.failed', {
      name: 'patch',
      id: 'tool-bound',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 9,
      category: ToolErrorCategory.TRANSIENT,
      retryable: false,
      detail: 'patch failed',
      modifiedPaths: [longPath],
    });

    const recorded = await journal.readAll();
    const modified = recorded[0]?.attributes?.modifiedPaths as string[] | undefined;
    expect(modified).toHaveLength(1);
    const only = modified?.[0] ?? '';

    // Bounded in BYTES, and never over budget once the marker is included.
    expect(Buffer.byteLength(only, 'utf8')).toBeLessThanOrEqual(512);
    // A shortened entry must announce itself, or a consumer would resolve the
    // fragment as though it were a real path.
    expect(only.endsWith('…')).toBe(true);
    // The retained prefix is the head of the SCRUBBED path — the scrubber
    // rewrote MY_SECRET before the cut, so it is NOT a prefix of the raw path.
    expect(only.startsWith('src/MY_[REDACTED]/')).toBe(true);
    // The scrub still ran: the secret is gone from the retained prefix.
    expect(only).toContain('MY_[REDACTED]');
    expect(only).not.toContain('MY_SECRET/');
    // No entry was DROPPED, so the count-cap companion flag stays absent — it
    // means "files went missing", a different fact from "one was shortened".
    expect('modifiedPathsTruncated' in (recorded[0]?.attributes ?? {})).toBe(false);
    off();
  });

  it('cuts a multi-byte path on a codepoint boundary, never mid-character', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-modified-utf8-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    // 3 bytes per character: a naive byte slice would land mid-character and
    // decode to U+FFFD, which is neither the original path nor the marker.
    const multibyte = `src/${'界'.repeat(300)}.ts`;

    events.emit('tool.failed', {
      name: 'patch',
      id: 'tool-utf8',
      sessionId: 'session',
      agentId: 'leader',
      durationMs: 9,
      category: ToolErrorCategory.TRANSIENT,
      retryable: false,
      detail: 'patch failed',
      modifiedPaths: [multibyte],
    });

    const recorded = await journal.readAll();
    const modified = recorded[0]?.attributes?.modifiedPaths as string[] | undefined;
    const only = modified?.[0] ?? '';
    expect(Buffer.byteLength(only, 'utf8')).toBeLessThanOrEqual(512);
    expect(only).not.toContain('\uFFFD');
    expect(only.endsWith('…')).toBe(true);
    off();
  });

  it('scrubs paths parsed out of a patch diff before persisting them', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-patchfile-scrub-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    // `patchFiles[].path` is parsed out of the DIFF the model supplied, so it is
    // untrusted text on its way into a durable journal — exactly like
    // `modifiedPaths`, which IS scrubbed. Without this a secret-bearing path
    // would land in the journal verbatim while the failure-side path was
    // redacted, an inconsistency between the two records of the same damage.
    events.emit('tool.executed', {
      sessionId: 's',
      agentId: 'a',
      name: 'patch',
      id: 'pfs',
      ok: true,
      durationMs: 12,
      input: {
        patch: [
          '--- a/src/MY_SECRET_dir/a.ts',
          '+++ b/src/MY_SECRET_dir/a.ts',
          '@@ -1 +1,2 @@',
          '-old',
          '+new',
          '+extra',
          '',
        ].join('\n'),
      },
      output: JSON.stringify({ applied: 1, rejected: 0, files: ['src/MY_SECRET_dir/a.ts'] }),
    });

    const recorded = await journal.readAll();
    const fileStats = recorded[0]?.attributes?.fileStats as
      | { patchFiles?: { path?: string }[] }
      | undefined;
    expect(fileStats?.patchFiles?.[0]?.path).toBe('src/MY_[REDACTED]_dir/a.ts');
    // Line counts are untouched — scrubbing touches the path string only.
    expect(fileStats?.patchFiles?.[0]).toMatchObject({ addedLines: 2, removedLines: 1 });
    off();
  });

  it('records permission provenance without persisting raw tool arguments', async () => {
    const { dir, journal, events, off } = await makeHarness(
      'chronicle-permission-',
      'permission.events.jsonl',
      { installationId: 'i', machineId: 'm', projectId: 'p' },
      'trace',
    );

    events.emit('permission.evaluated', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      name: 'bash',
      id: 'tool-permission',
      inputHash: 'a'.repeat(64),
      policyDecision: 'auto',
      effectiveDecision: 'confirm',
      decisionSource: 'trust',
      reason: 'matched SECRET rule',
      riskTier: 'destructive',
      yoloEnabled: false,
      boundaryDecision: 'confirm',
      boundaryReason: 'SECRET boundary',
      capabilityDowngraded: true,
    });

    const recorded = await journal.readAll();
    const query = await ChronicleQueryEngine.fromDirectory(dir);
    const summary = (await query.query({ eventTypes: ['permission.evaluated'] })).summary;
    off();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      eventType: 'permission.evaluated',
      outcome: 'success',
      correlation: { traceId: 'trace', toolCallId: 'tool-permission' },
      attributes: {
        toolName: 'bash',
        inputHash: 'a'.repeat(64),
        policyDecision: 'auto',
        effectiveDecision: 'confirm',
        decisionSource: 'trust',
        reason: 'matched [REDACTED] rule',
        riskTier: 'destructive',
        yoloEnabled: false,
        boundaryDecision: 'confirm',
        boundaryReason: '[REDACTED] boundary',
        capabilityDowngraded: true,
      },
    });
    expect(JSON.stringify(recorded[0])).not.toContain('SECRET');
    expect(summary.families.decision).toBe(1);
  });

  it('truncates output previews exceeding 2048 bytes', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-tool-trunc-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    // Generate output exceeding the 2048-byte preview cap
    const largeOutput = 'x'.repeat(3000);

    events.emit('tool.executed', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-trunc',
      name: 'read',
      durationMs: 5,
      ok: true,
      output: largeOutput,
      outputBytes: 3000,
      outputTokens: 750,
      outputLines: 1,
      metadata: {
        toolUseId: 'tool-trunc',
        toolName: 'read',
        ok: true,
        summary: 'large read',
        files: [],
        symbols: [],
        commands: [],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    const preview = recorded[0]?.attributes?.['outputPreview'];
    // Should be a truncation object, not the full string
    expect(typeof preview).toBe('object');
    const truncObj = preview as { preview: string; truncated: true; totalBytes: number };
    expect(truncObj.truncated).toBe(true);
    expect(truncObj.totalBytes).toBe(3000);
    expect(Buffer.byteLength(truncObj.preview, 'utf8')).toBeLessThanOrEqual(2048);
  });

  it('preserves short output as-is (no truncation)', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-tool-short-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm' },
      'trace',
    );

    events.emit('tool.executed', {
      sessionId: 'session',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-short',
      name: 'read',
      durationMs: 1,
      ok: true,
      output: 'short output',
      outputBytes: 12,
      outputTokens: 2,
      outputLines: 1,
      metadata: {
        toolUseId: 'tool-short',
        toolName: 'read',
        ok: true,
        summary: 'small read',
        files: [],
        symbols: [],
        commands: [],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    // Short output should be preserved as a plain string
    expect(recorded[0]?.attributes?.['outputPreview']).toBe('short output');
  });

  it('records taskId/boardId in scope and provider/model in runtime on tool.started', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-task-scope-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );

    events.emit('tool.started', {
      sessionId: 'sess',
      traceId: 'trace',
      agentId: 'leader',
      name: 'grep',
      id: 'tool-task',
      input: { pattern: 'TODO' },
      taskId: 'task-42',
      boardId: 'board-7',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({
      sessionId: 'sess',
      agentId: 'leader',
      taskId: 'task-42',
      kanbanBoardId: 'board-7',
    });
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-20250514',
    });
  });

  it('records taskId/boardId in scope and provider/model in runtime on tool.executed', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-task-exec-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );

    events.emit('tool.executed', {
      sessionId: 'sess',
      traceId: 'trace',
      agentId: 'leader',
      id: 'tool-exec-task',
      name: 'edit',
      durationMs: 50,
      ok: true,
      output: 'patched file',
      outputBytes: 12,
      outputTokens: 3,
      outputLines: 2,
      metadata: {
        toolUseId: 'tool-exec-task',
        toolName: 'edit',
        ok: true,
        summary: 'edit file',
        files: [],
        symbols: [],
        commands: [],
        errors: [],
        status: 'seen',
        referenceCount: 0,
        seenAt: 1,
      },
      taskId: 'task-99',
      boardId: 'board-7',
      provider: 'openai',
      model: 'gpt-4o',
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-99', kanbanBoardId: 'board-7' });
    expect(recorded[0]?.runtime).toMatchObject({ providerId: 'openai', modelId: 'gpt-4o' });
  });

  it('records taskId/boardId/provider/model on tool.failed', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-task-fail-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );

    events.emit('tool.failed', {
      name: 'bash',
      id: 'tool-fail-task',
      sessionId: 'sess',
      agentId: 'leader',
      durationMs: 5000,
      category: ToolErrorCategory.TRANSIENT,
      retryable: true,
      detail: 'command timed out',
      taskId: 'task-77',
      boardId: 'board-7',
      provider: 'anthropic',
      model: 'claude-haiku-3',
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-77', kanbanBoardId: 'board-7' });
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-haiku-3',
    });
  });

  it('records taskId/boardId/provider/model on permission.evaluated', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-perm-task-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );

    events.emit('permission.evaluated', {
      sessionId: 'sess',
      agentId: 'leader',
      name: 'bash',
      id: 'perm-task',
      inputHash: 'b'.repeat(64),
      policyDecision: 'auto',
      effectiveDecision: 'auto',
      decisionSource: 'trust',
      yoloEnabled: false,
      capabilityDowngraded: false,
      taskId: 'task-55',
      boardId: 'board-7',
      provider: 'google',
      model: 'gemini-2.0-flash',
    });

    const recorded = await journal.readAll();
    off();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.scope).toMatchObject({ taskId: 'task-55', kanbanBoardId: 'board-7' });
    expect(recorded[0]?.runtime).toMatchObject({
      providerId: 'google',
      modelId: 'gemini-2.0-flash',
    });
  });

  it('records a refused call as denied and an aborted one as cancelled, not failure', async () => {
    const { journal, events, off } = await makeHarness(
      'chronicle-settlement-',
      'events.jsonl',
      { installationId: 'i', machineId: 'm', sessionId: 'sess' },
      'trace',
    );

    const cases = [
      ['denied_by_policy', 'denied'],
      ['blocked_by_hook', 'denied'],
      ['declined', 'denied'],
      ['aborted', 'cancelled'],
      ['invalid_input', 'failure'],
      ['unknown_tool', 'failure'],
      ['failed', 'failure'],
      [undefined, 'failure'],
    ] as const;
    for (const [i, [settlement]] of cases.entries()) {
      events.emit('tool.executed', {
        sessionId: 'sess',
        id: `t-${i}`,
        name: 'bash',
        durationMs: 1,
        ok: false,
        ...(settlement ? { settlement } : {}),
      });
    }

    const recorded = await journal.readAll();
    off();

    expect(recorded.map((e) => e.outcome)).toEqual(cases.map(([, outcome]) => outcome));
    expect(recorded[0]?.attributes).toMatchObject({ settlement: 'denied_by_policy' });
    expect(recorded.at(-1)?.attributes).not.toHaveProperty('settlement');
  });
});
