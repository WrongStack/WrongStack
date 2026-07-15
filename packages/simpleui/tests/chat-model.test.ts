import { describe, expect, it } from 'vitest';
import { contentToText, replayToMessages, updateSubagents } from '../src/lib/chat-model.js';
import { copyText } from '../src/lib/clipboard.js';
import {
  clearComposerDraft,
  type DraftStorage,
  readComposerDraft,
  writeComposerDraft,
} from '../src/lib/composer-draft.js';
import {
  composePromptWithFileReferences,
  detectFileMention,
  removeFileMention,
} from '../src/lib/file-mention.js';
import { projectAssistantMessage } from '../src/lib/message-projection.js';
import {
  parseSessionSummaries,
  relativeSessionTime,
  sessionDisplayName,
} from '../src/lib/session-model.js';
import { projectStatusNotice } from '../src/lib/status-notice.js';

describe('SimpleUI chat projection', () => {
  it('extracts displayable text without leaking opaque tool blocks', () => {
    expect(
      contentToText([
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', name: 'read', input: { path: 'secret' } },
        { type: 'text', text: 'World' },
      ]),
    ).toBe('Hello\n\nWorld');
  });

  it('restores only useful chat roles from session replay', () => {
    expect(
      replayToMessages([
        { role: 'user', content: 'Fix it' },
        { role: 'tool', content: 'huge output' },
        { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
      ]).map(({ role, text }) => ({ role, text })),
    ).toEqual([
      { role: 'user', text: 'Fix it' },
      { role: 'assistant', text: 'Done' },
    ]);
  });

  it('strips tool_use and tool_result blocks from assistant replay content', () => {
    expect(
      replayToMessages([
        { role: 'user', content: 'Search the code' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I found the issue.' },
            { type: 'tool_use', id: 'call1', name: 'read', input: { path: 'file.ts' } },
            { type: 'tool_result', tool_use_id: 'call1', content: 'file content here' },
            { type: 'text', text: 'The fix is in line 42.' },
          ],
        },
      ]).map(({ role, text }) => ({ role, text })),
    ).toEqual([
      { role: 'user', text: 'Search the code' },
      { role: 'assistant', text: 'I found the issue.\n\nThe fix is in line 42.' },
    ]);
  });

  it('skips assistant messages that contain only non-text blocks', () => {
    expect(
      replayToMessages([
        { role: 'user', content: 'Read the file' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'read', input: { path: 'x.ts' } },
            { type: 'tool_result', tool_use_id: 't1', content: 'data' },
          ],
        },
        { role: 'assistant', content: 'Done reading.' },
      ]).map(({ role, text }) => ({ role, text })),
    ).toEqual([
      { role: 'user', text: 'Read the file' },
      { role: 'assistant', text: 'Done reading.' },
    ]);
  });

  it('preserves string content for user messages without array wrapping', () => {
    expect(
      replayToMessages([
        { role: 'user', content: '  Hello world  ' },
        { role: 'assistant', content: '  Response  ' },
      ]).map(({ role, text }) => ({ role, text })),
    ).toEqual([
      { role: 'user', text: 'Hello world' },
      { role: 'assistant', text: 'Response' },
    ]);
  });
});

describe('SimpleUI subagent projection', () => {
  it('tracks workers but never duplicates the leader', () => {
    let agents = updateSubagents([], {
      kind: 'spawned',
      subagentId: 'leader',
      name: 'LEADER',
    });
    agents = updateSubagents(agents, {
      kind: 'spawned',
      subagentId: 'worker-1',
      name: 'FIXER',
      model: 'gpt-5',
    });
    agents = updateSubagents(agents, {
      kind: 'task_started',
      subagentId: 'worker-1',
      description: 'Fix auth',
    });
    expect(agents).toEqual([
      expect.objectContaining({
        id: 'worker-1',
        name: 'FIXER',
        status: 'running',
        task: 'Fix auth',
      }),
    ]);
  });

  it('removes retired workers', () => {
    const agents = [{ id: 'worker-1', name: 'FIXER', status: 'idle' }];
    expect(updateSubagents(agents, { kind: 'removed', subagentId: 'worker-1' })).toEqual([]);
  });
});

describe('SimpleUI assistant metadata projection', () => {
  it('parses canonical next steps and removes their control block from prose', () => {
    expect(
      projectAssistantMessage(
        `Done.\n\n<nextsteps>\n1. Run tests\n2. Ship it auto="true"\n</nextsteps>`,
      ),
    ).toEqual({
      text: 'Done.',
      nextSteps: [
        { index: 1, text: 'Run tests' },
        { index: 2, text: 'Ship it', auto: true },
      ],
    });
  });

  it('accepts legacy next_steps tags without duplicating parser rules', () => {
    const projected = projectAssistantMessage(
      'Ready.\n<next_steps>\n- Inspect logs\n- Retry\n</next_steps>',
    );
    expect(projected.text).toBe('Ready.');
    expect(projected.nextSteps.map((step) => step.text)).toEqual(['Inspect logs', 'Retry']);
  });

  it('hides incomplete or malformed metadata instead of rendering raw tags', () => {
    expect(projectAssistantMessage('Answer\n\n<nextsteps>\n1. Still streaming')).toEqual({
      text: 'Answer',
      nextSteps: [],
    });
    expect(projectAssistantMessage('Answer\n<nextsteps>\nnot a list\n</nextsteps>').text).toBe(
      'Answer',
    );
  });

  it('leaves ordinary assistant text untouched', () => {
    expect(projectAssistantMessage('Plain answer')).toEqual({
      text: 'Plain answer',
      nextSteps: [],
    });
  });
});

describe('SimpleUI file mentions', () => {
  it('detects the active @ token at the cursor', () => {
    expect(detectFileMention('Fix @src/app', 12)).toEqual({ start: 4, query: 'src/app' });
    expect(detectFileMention('email@example.com', 17)).toBeNull();
    expect(detectFileMention('Done @old token', 15)).toBeNull();
  });

  it('turns a selected mention into a separate reference without stale query text', () => {
    expect(removeFileMention('Inspect @src/app then fix it', { start: 8, query: 'src/app' })).toBe(
      'Inspect then fix it',
    );
  });

  it('appends unique file references using the canonical WebUI prompt convention', () => {
    expect(
      composePromptWithFileReferences('Review these', [
        'src/app.tsx',
        'src/styles.css',
        'src/app.tsx',
      ]),
    ).toBe('Review these\n\n@src/app.tsx\n@src/styles.css');
  });
});

describe('SimpleUI session projection', () => {
  it('keeps only valid compact session fields', () => {
    expect(
      parseSessionSummaries([
        {
          id: '2026-07-14/abc123',
          title: 'Fix login',
          startedAt: '2026-07-14T10:00:00.000Z',
          model: 'gpt-5',
          provider: 'openai',
          isCurrent: true,
          toolBreakdown: { read: 20 },
        },
        { nope: true },
      ]),
    ).toEqual([
      {
        id: '2026-07-14/abc123',
        title: 'Fix login',
        name: undefined,
        startedAt: '2026-07-14T10:00:00.000Z',
        model: 'gpt-5',
        provider: 'openai',
        isCurrent: true,
      },
    ]);
  });

  it('prefers a user name, then title, then a short id', () => {
    const base = {
      id: '2026-07-14/abc123456789',
      title: 'Automatic title',
      startedAt: '',
      model: '',
      provider: '',
      isCurrent: false,
    };
    expect(sessionDisplayName({ ...base, name: 'My work' })).toBe('My work');
    expect(sessionDisplayName(base)).toBe('Automatic title');
    expect(sessionDisplayName({ ...base, title: '' })).toBe('Session abc12345');
  });

  it('formats compact relative timestamps', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    expect(relativeSessionTime('2026-07-14T11:42:00.000Z', now)).toBe('18m');
    expect(relativeSessionTime('2026-07-12T12:00:00.000Z', now)).toBe('2d');
  });
});

describe('SimpleUI transient status notices', () => {
  it('shows failed operations without surfacing successful housekeeping', () => {
    expect(
      projectStatusNotice({
        type: 'key.operation_result',
        payload: { success: false, message: 'Session is no longer available' },
      }),
    ).toEqual({ text: 'Session is no longer available', tone: 'error' });
    expect(
      projectStatusNotice({
        type: 'key.operation_result',
        payload: { success: true, message: 'Saved' },
      }),
    ).toBeNull();
  });

  it('projects session and retryable provider failures onto the compact status line', () => {
    expect(
      projectStatusNotice({
        type: 'sessions.list',
        payload: { sessions: [], error: 'Store unavailable' },
      }),
    ).toEqual({ text: 'Sessions · Store unavailable', tone: 'error' });
    expect(
      projectStatusNotice({
        type: 'provider.error',
        payload: { description: 'Temporarily overloaded', retryable: true },
      }),
    ).toEqual({ text: 'Provider · Temporarily overloaded', tone: 'warning' });
  });
});

describe('SimpleUI clipboard', () => {
  it('copies the projected response through the available clipboard writer', async () => {
    const written: string[] = [];
    await expect(
      copyText('Finished cleanly', {
        writeText: async (text) => {
          written.push(text);
        },
      }),
    ).resolves.toBe(true);
    expect(written).toEqual(['Finished cleanly']);
  });

  it('fails quietly when clipboard access is unavailable or rejected', async () => {
    await expect(copyText('response', null)).resolves.toBe(false);
    await expect(
      copyText('response', { writeText: async () => Promise.reject(new Error('denied')) }),
    ).resolves.toBe(false);
  });
});

describe('SimpleUI composer drafts', () => {
  function memoryStorage(): DraftStorage & { values: Map<string, string> } {
    const values = new Map<string, string>();
    return {
      values,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
  }

  it('round-trips a per-session draft and unique file references', () => {
    const storage = memoryStorage();
    writeComposerDraft(
      '2026-07-14/session-a',
      { text: 'Finish this', fileRefs: ['src/app.tsx', 'src/app.tsx', 'README.md'] },
      storage,
    );
    expect(readComposerDraft('2026-07-14/session-a', storage)).toEqual({
      text: 'Finish this',
      fileRefs: ['src/app.tsx', 'README.md'],
    });
    expect(readComposerDraft('2026-07-14/session-b', storage)).toEqual({
      text: '',
      fileRefs: [],
    });
  });

  it('removes sent or explicitly cleared drafts', () => {
    const storage = memoryStorage();
    writeComposerDraft('session-a', { text: 'draft', fileRefs: [] }, storage);
    clearComposerDraft('session-a', storage);
    expect(storage.values.size).toBe(0);

    writeComposerDraft('session-a', { text: '', fileRefs: [] }, storage);
    expect(storage.values.size).toBe(0);
  });
});
