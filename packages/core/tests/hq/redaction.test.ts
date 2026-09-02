import { describe, expect, it } from 'vitest';
import { createHqEventEnvelope } from '../../src/hq/protocol.js';
import {
  redactHqEvent,
  redactHqValue,
  scrubAndTruncateHqPreview,
  summarizeHqToolArgs,
  resolveHqRedactionPolicy,
  tightenHqRedactionPolicy,
} from '../../src/hq/redaction.js';

describe('HQ redaction', () => {
  it('preserves Kanban user content when telemetry raw content is disabled', () => {
    const event = createHqEventEnvelope({
      id: 'kanban-1',
      type: 'kanban.snapshot',
      timestamp: '2026-07-22T12:00:00Z',
      clientId: 'client-1',
      projectId: 'project-1',
      seq: 1,
      payload: {
        projectId: 'project-1',
        generatedAt: '2026-07-22T12:00:00Z',
        boards: [
          {
            boardId: 'board-1',
            revision: 1,
            updatedAt: '2026-07-22T12:00:00Z',
            board: { id: 'board-1', description: 'Keep this', notes: [{ content: 'Keep note' }] },
          },
        ],
        tombstones: [],
      },
    });
    const result = redactHqEvent(event, { policy: { rawContent: false } });
    const board = result.value.payload.boards[0]!.board as {
      description: string;
      notes: Array<{ content: string }>;
    };
    expect(board.description).toBe('Keep this');
    expect(board.notes[0]?.content).toBe('Keep note');
  });
  it('keeps raw prompt/tool/file content by default', () => {
    const result = redactHqValue({
      prompt: 'implement a secret feature',
      fileContent: 'const value = 1;',
      nested: { stdout: 'very long raw command output' },
      safeSummary: 'tool completed',
    });

    expect(result.redacted).toBe(false);
    expect(result.value).toEqual({
      prompt: 'implement a secret feature',
      fileContent: 'const value = 1;',
      nested: { stdout: 'very long raw command output' },
      safeSummary: 'tool completed',
    });
  });

  // WS-007: docs/configuration.md:1229 — "Raw content publishing defaults on
  // for HQ targets ... Secret scrubbing and sensitive-field masking still
  // apply." `rawContent` governs whether the *body* is collapsed, never whether
  // credentials are stripped. These tests previously asserted the drifted
  // implementation, in which the shipped default disabled both defences.
  it('still masks sensitive fields when raw content is enabled', () => {
    const result = redactHqValue({
      token: 'plain-token-value',
      headers: {
        Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
      },
      rawContent: 'allowed raw text',
    });

    const value = result.value as Record<string, unknown>;
    expect(String(value.token)).toContain('REDACTED');
    expect(String((value.headers as Record<string, unknown>).Authorization)).toContain('REDACTED');
    // Non-sensitive raw text is still carried through in full.
    expect(value.rawContent).toBe('allowed raw text');
  });

  it('redacts sensitive fields when raw content is explicitly disabled', () => {
    const result = redactHqValue(
      {
        token: 'plain-token-value',
        headers: {
          Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz',
        },
        rawContent: 'hidden raw text',
      },
      { policy: { rawContent: false } },
    );

    expect(result.value).toEqual({
      token: '[REDACTED:hq_sensitive_field]',
      headers: {
        Authorization: '[REDACTED:hq_sensitive_field]',
      },
      rawContent: '[REDACTED:hq_raw_content]',
    });
  });

  it('scrubs secrets embedded in non-sensitive strings by default', () => {
    const result = redactHqValue({
      summary: 'using Bearer abcdefghijklmnopqrstuvwxyz for auth',
    });

    expect(String(result.value.summary)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(String(result.value.summary)).toContain('REDACTED');
  });

  it('converts project-local paths to project-relative paths when requested', () => {
    const result = redactHqValue(
      {
        projectRoot: 'D:\\Codebox\\PROJECTS\\WrongStack',
        filePath: 'D:\\Codebox\\PROJECTS\\WrongStack\\packages\\core\\src\\hq\\protocol.ts',
      },
      { policy: { paths: 'project-relative' }, projectRoot: 'D:/Codebox/PROJECTS/WrongStack' },
    );

    expect(result.value).toEqual({
      projectRoot: '.',
      filePath: 'packages/core/src/hq/protocol.ts',
    });
  });

  it('redacts all paths when path policy is redacted', () => {
    const result = redactHqValue(
      { cwd: '/home/user/project', file: '/home/user/project/src/index.ts' },
      { policy: { paths: 'redacted' }, projectRoot: '/home/user/project' },
    );

    expect(result.value).toEqual({
      cwd: '[REDACTED:hq_path]',
      file: '[REDACTED:hq_path]',
    });
  });

  it('redacts event payloads while preserving envelope metadata', () => {
    const event = createHqEventEnvelope({
      id: 'evt_1',
      type: 'tool.completed',
      timestamp: '2026-06-21T12:00:00.000Z',
      clientId: 'client_1',
      projectId: 'project_1',
      sessionId: 'session_1',
      seq: 7,
      payload: {
        toolName: 'bash',
        output: 'SECRET_TOKEN=abcdefghijklmnopqrstuvwxyz123456',
      },
    });

    const result = redactHqEvent(event);

    expect(result.value.id).toBe('evt_1');
    expect(result.value.sessionId).toBe('session_1');
    // Envelope metadata survives; the payload's embedded credential does not.
    const payload = result.value.payload as Record<string, unknown>;
    expect(payload.toolName).toBe('bash');
    expect(String(payload.output)).not.toContain('abcdefghijklmnopqrstuvwxyz123456');
  });

  it('keeps mailbox bodies by default but scrubs credentials inside them', () => {
    const result = redactHqValue(
      {
        message: {
          subject: 'Please review auth flow',
          body: 'The raw mailbox body should not be shipped to HQ by default.',
          bodyPreview: 'Use Bearer abcdefghijklmnopqrstuvwxyz for the repro',
          outcomePreview: 'Fixed in session_1',
        },
      },
      { maxSummaryLength: 80 },
    );

    const message = (result.value as Record<string, unknown>).message as Record<string, unknown>;
    // Body content is still carried in full — rawContent's actual job.
    expect(message.subject).toBe('Please review auth flow');
    expect(message.body).toBe('The raw mailbox body should not be shipped to HQ by default.');
    expect(message.outcomePreview).toBe('Fixed in session_1');
    // ...but a credential inside a preview is stripped.
    expect(String(message.bodyPreview)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('summarizes tool args without exposing nested objects or sensitive values', () => {
    const summary = summarizeHqToolArgs(
      {
        command: 'pnpm test -- --runInBand',
        token: 'secret',
        args: ['--filter', 'core'],
        nested: { raw: 'value' },
      },
      { policy: { toolArgs: 'summary' } },
    );

    expect(summary).toEqual({
      command: 'pnpm test -- --runInBand',
      token: '[REDACTED:hq_sensitive_field]',
      args: '[array:2]',
      nested: '[object]',
    });
  });

  it('can hide tool args entirely', () => {
    expect(summarizeHqToolArgs({ command: 'secret' }, { policy: { toolArgs: 'none' } })).toBe(
      '[REDACTED:hq_tool_args]',
    );
  });

  it('tightens publisher policy without allowing an operator override to loosen it', () => {
    const publisher = resolveHqRedactionPolicy({
      rawContent: true,
      toolArgs: 'redacted',
      paths: 'full',
    });
    expect(
      tightenHqRedactionPolicy(publisher, {
        rawContent: false,
        toolArgs: 'summary',
        paths: 'project-relative',
      }),
    ).toEqual({ rawContent: false, toolArgs: 'summary', paths: 'project-relative' });
    expect(
      tightenHqRedactionPolicy(resolveHqRedactionPolicy(), {
        rawContent: true,
        toolArgs: 'redacted',
        paths: 'full',
      }),
    ).toEqual({ rawContent: true, toolArgs: 'redacted', paths: 'full' });
  });
});

describe('scrubAndTruncateHqPreview', () => {
  it('returns undefined for non-string or empty input', () => {
    expect(scrubAndTruncateHqPreview(undefined)).toBeUndefined();
    expect(scrubAndTruncateHqPreview(null)).toBeUndefined();
    expect(scrubAndTruncateHqPreview(42)).toBeUndefined();
    expect(scrubAndTruncateHqPreview('')).toBeUndefined();
  });

  it('returns the string unchanged when shorter than the max length', () => {
    expect(scrubAndTruncateHqPreview('hello world', 280)).toBe('hello world');
  });

  it('truncates strings longer than the max length and reports dropped chars', () => {
    const long = 'a'.repeat(500);
    const result = scrubAndTruncateHqPreview(long, 50);
    expect(result).not.toBeUndefined();
    expect(result!.startsWith('a'.repeat(50))).toBe(true);
    expect(result).toContain('[truncated:450]');
  });

  it('scrubs embedded secrets before returning the preview', () => {
    // 40-char GitHub-style PAT — DefaultSecretScrubber catches `ghp_` + 36 alnum.
    const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const result = scrubAndTruncateHqPreview(`attached ${secret} please review`, 280);
    expect(result).not.toBeUndefined();
    expect(result!.toLowerCase()).not.toContain(secret.toLowerCase());
  });
});
