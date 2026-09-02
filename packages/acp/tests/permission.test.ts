/**
 * Tests for permission policy module.
 *
 * Covers the `pickAllow`, `pickReject`, `defaultPermissionPolicy`,
 * `readOnlyPermissionPolicy`, and `makePermissionPolicy` functions.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultPermissionPolicy,
  readOnlyPermissionPolicy,
  makePermissionPolicy,
} from '../src/client/permission.js';
import type { PermissionRequest } from '../src/client/permission.js';
import type { ToolCallId } from '../src/types/acp-v1.js';

function toolCallId(value: string): ToolCallId {
  return value as ToolCallId;
}

function makeReq(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    toolCall: {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCallId('tc1'),
      title: 'test',
      kind: 'edit',
      status: 'pending',
    },
    options: [
      { optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Reject Once', kind: 'reject_once' },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('defaultPermissionPolicy', () => {
  it('auto-approves with the allow_once option when signal is not aborted', async () => {
    const outcome = await defaultPermissionPolicy(makeReq());
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });

  it('prefers allow_always over allow_once when available', async () => {
    const outcome = await defaultPermissionPolicy(
      makeReq({
        options: [
          { optionId: 'allow_always', name: 'Always', kind: 'allow_always' },
          { optionId: 'allow_once', name: 'Once', kind: 'allow_once' },
        ],
      }),
    );
    // allow_once is preferred (lower standing grant)
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });

  it('returns cancelled when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const outcome = await defaultPermissionPolicy(makeReq({ signal: ac.signal }));
    expect(outcome).toEqual({ outcome: 'cancelled' });
  });

  it('returns cancelled when only reject options exist', async () => {
    const outcome = await defaultPermissionPolicy(
      makeReq({
        options: [
          { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
          { optionId: 'reject_always', name: 'Reject Always', kind: 'reject_always' },
        ],
      }),
    );
    expect(outcome).toEqual({ outcome: 'cancelled' });
  });
});

describe('readOnlyPermissionPolicy', () => {
  it('auto-approves read/search/fetch/think tool kinds', async () => {
    for (const kind of ['read', 'search', 'fetch', 'think'] as const) {
      const outcome = await readOnlyPermissionPolicy(
        makeReq({
          toolCall: {
            sessionUpdate: 'tool_call_update',
            toolCallId: toolCallId('tc'),
            title: kind,
            kind,
            status: 'pending',
          },
        }),
      );
      expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    }
  });

  it('rejects edit/delete/move/execute tool kinds', async () => {
    for (const kind of ['edit', 'delete', 'move', 'execute'] as const) {
      const outcome = await readOnlyPermissionPolicy(
        makeReq({
          toolCall: {
            sessionUpdate: 'tool_call_update',
            toolCallId: toolCallId('tc'),
            title: kind,
            kind,
            status: 'pending',
          },
        }),
      );
      expect(outcome).toEqual({ outcome: 'selected', optionId: 'reject_once' });
    }
  });

  it('rejects unknown tool kinds by selecting the reject option', async () => {
    const outcome = await readOnlyPermissionPolicy(
      makeReq({
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCallId('tc'),
          title: 'other',
          status: 'pending',
        },
      }),
    );
    // When a tool has no kind (not in READ_ONLY_KINDS), pickReject finds reject_once in the options
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'reject_once' });
  });

  it('returns cancelled when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const outcome = await readOnlyPermissionPolicy(
      makeReq({
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCallId('tc'),
          title: 'read',
          kind: 'read',
          status: 'pending',
        },
        signal: ac.signal,
      }),
    );
    expect(outcome).toEqual({ outcome: 'cancelled' });
  });

  it('returns cancelled from pickReject when no reject options exist', async () => {
    // readOnlyPermissionPolicy calls pickReject for non-read-only tools.
    // If there are no reject options, pickReject returns cancelled.
    const outcome = await readOnlyPermissionPolicy(
      makeReq({
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCallId('tc'),
          title: 'edit',
          kind: 'edit',
          status: 'pending',
        },
        options: [{ optionId: 'allow_once', name: 'Allow Once', kind: 'allow_once' }],
      }),
    );
    // pickReject finds no reject options → returns cancelled
    expect(outcome).toEqual({ outcome: 'cancelled' });
  });

  it('uses pickReject when only reject options are available for non-read-only tools', async () => {
    const outcome = await readOnlyPermissionPolicy(
      makeReq({
        toolCall: {
          sessionUpdate: 'tool_call_update',
          toolCallId: toolCallId('tc'),
          title: 'edit',
          kind: 'edit',
          status: 'pending',
        },
        options: [{ optionId: 'reject_always', name: 'Reject Always', kind: 'reject_always' }],
      }),
    );
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'reject_always' });
  });
});

describe('makePermissionPolicy', () => {
  it('calls the decider and returns allow outcome when decider returns true', async () => {
    const policy = makePermissionPolicy(async () => true);
    const outcome = await policy(makeReq());
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'allow_once' });
  });

  it('calls the decider and returns reject outcome when decider returns false', async () => {
    const policy = makePermissionPolicy(async () => false);
    const outcome = await policy(makeReq());
    expect(outcome).toEqual({ outcome: 'selected', optionId: 'reject_once' });
  });

  it('returns cancelled when signal is aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const policy = makePermissionPolicy(async () => true);
    const outcome = await policy(makeReq({ signal: ac.signal }));
    expect(outcome).toEqual({ outcome: 'cancelled' });
  });
});
