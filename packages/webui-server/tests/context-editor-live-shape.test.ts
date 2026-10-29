import type { Message } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { createContextEvidenceState } from '@wrongstack/core/utils';
import { describe, expect, it } from 'vitest';
import {
  applyContextEditorProposal,
  buildContextEditorSnapshot,
} from '../src/server/context-editor.js';

function mockContext(messages: Message[]): Context {
  return {
    messages,
    systemPrompt: [{ text: 'system' }],
    tools: [],
    state: {
      replaceMessages(next: Message[]) {
        messages.length = 0;
        messages.push(...next);
      },
      deleteMeta() {},
    },
    readFiles: new Set(),
    fileMtimes: new Map(),
    contextEvidence: createContextEvidenceState(),
    meta: {},
    flushConversationJournal: async () => {},
  } as never as Context;
}

/** A user turn as the agent loop stores it. */
function userTurn(content: string): Message {
  return { role: 'user', content, origin: 'user_input', authoredLength: 1 };
}

/** Snapshot, edit as the WebUI does (JSON round-trip), then apply. */
async function applyFromSnapshot(
  ctx: Context,
  edit: (messages: unknown[]) => unknown[],
  removals: unknown[],
) {
  const snapshot = buildContextEditorSnapshot(ctx, undefined);
  const proposed = edit(JSON.parse(JSON.stringify(snapshot.messages)) as unknown[]);
  return applyContextEditorProposal({
    ctx,
    baseRevision: snapshot.revision,
    messages: proposed,
    removals,
    allowRepair: true,
  });
}

describe('context editor on live-shaped messages', () => {
  it('applies a turn removal when user turns carry authoredLength', async () => {
    const messages: Message[] = [
      userTurn('one'),
      { role: 'assistant', content: 'a1' },
      userTurn('two'),
      { role: 'assistant', content: 'a2' },
    ];
    const result = await applyFromSnapshot(mockContext(messages), (proposed) => proposed.slice(2), [
      { messageIndex: 0 },
      { messageIndex: 1 },
    ]);
    expect('ok' in result).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ content: 'two', authoredLength: 1, origin: 'user_input' });
  });

  it('is not blocked by host-only tool block fields elsewhere in history', async () => {
    const messages: Message[] = [
      userTurn('q'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'x', input: {}, _resultFormat: 'data' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'blocked',
            is_error: true,
            _kanbanBoundary: { decision: 'block' } as never,
          },
        ],
      },
      { role: 'assistant', content: 'done' },
      userTurn('drop me'),
      { role: 'assistant', content: 'bye' },
    ];
    const result = await applyFromSnapshot(
      mockContext(messages),
      (proposed) => proposed.slice(0, 4),
      [{ messageIndex: 4 }, { messageIndex: 5 }],
    );
    expect('ok' in result).toBe(false);
    expect(messages).toHaveLength(4);
  });

  it('still rejects an edit the removal plan does not declare', async () => {
    const messages: Message[] = [userTurn('keep'), { role: 'assistant', content: 'a' }];
    const result = await applyFromSnapshot(
      mockContext(messages),
      (proposed) => {
        (proposed[0] as { content: string }).content = 'changed';
        return proposed;
      },
      [],
    );
    expect('ok' in result && result.validationErrors.map((e) => e.code)).toEqual([
      'REMOVAL_PLAN_MISMATCH',
    ]);
    expect(messages[0]?.content).toBe('keep');
  });

  it('applies an edit when history holds an attached PDF document block', async () => {
    const document = {
      type: 'document' as const,
      source: {
        type: 'base64' as const,
        media_type: 'application/pdf' as const,
        data: 'JVBERi0xLjQK',
      },
      name: 'a.pdf',
      text: 'page 1',
      pages: 1,
    };
    const messages: Message[] = [
      userTurn('one'),
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: [document, { type: 'text', text: 'summarize' }] },
      { role: 'assistant', content: 'a2' },
    ];
    const result = await applyFromSnapshot(mockContext(messages), (proposed) => proposed.slice(2), [
      { messageIndex: 0 },
      { messageIndex: 1 },
    ]);
    expect('ok' in result).toBe(false);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toEqual([document, { type: 'text', text: 'summarize' }]);
  });
});

describe('desktop text-range proposals', () => {
  it('are accepted and applied exactly as the desktop model builds them', async () => {
    const { contextEditorSnapshot, editProposal } = await import(
      '../../../apps/desktop-v2/src/context-editor-model.js'
    );
    const messages: Message[] = [
      userTurn('please review the attached log carefully'),
      { role: 'assistant', content: [{ type: 'text', text: 'kept part. noisy part' }] },
      userTurn('next'),
      { role: 'assistant', content: 'a2' },
    ];
    const ctx = mockContext(messages);
    const snapshot = contextEditorSnapshot(
      JSON.parse(JSON.stringify(buildContextEditorSnapshot(ctx, undefined))),
    );
    // Trim the assistant text block, and cut words from the last user turn (its reply goes too).
    const proposal = editProposal(snapshot, new Set(), [
      { messageIndex: 1, blockIndex: 0, start: 10, end: 21 },
      { messageIndex: 2, start: 0, end: 2 },
    ]);
    const result = await applyContextEditorProposal({ ctx, ...proposal });
    // An applied result has no `ok`; a refusal is a validation result with `ok: false`.
    expect('ok' in result).toBe(false);
    expect(messages.map((message) => message.content)).toEqual([
      'please review the attached log carefully',
      [{ type: 'text', text: 'kept part.' }],
      'xt',
    ]);
  });
});
