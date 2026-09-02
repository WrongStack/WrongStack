/**
 * Tests for the HQ mailbox action client (`src/lib/mailbox-actions.ts`) —
 * the thin `fetch` wrappers around `POST /api/mailbox/messages/:id/action`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mailboxActions } from '../src/domain/mailbox-actions.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Error' }),
    ),
  );
}

const BASE_INPUT = { mailId: 'msg-1', projectId: 'proj-demo', readerId: 'reader-1' } as const;

describe('mailboxActions', () => {
  describe('markRead', () => {
    it('sends a mark-read action and returns the result', async () => {
      mockFetch(200, { success: true });
      const result = await mailboxActions.markRead(BASE_INPUT);
      expect(result).toEqual({ success: true });
      const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
      expect(call[0]).toContain('/api/mailbox/messages/msg-1/action');
      expect(JSON.parse(call[1].body as string)).toMatchObject({ mailId: 'msg-1', action: 'mark-read' });
    });
  });

  describe('acknowledge', () => {
    it('sends an acknowledge action', async () => {
      mockFetch(200, { success: true });
      const result = await mailboxActions.acknowledge({ ...BASE_INPUT, sessionId: 'sess-1' });
      expect(result).toEqual({ success: true });
      const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
      expect(body.action).toBe('acknowledge');
    });
  });

  describe('reopen', () => {
    it('sends a reopen action', async () => {
      mockFetch(200, { success: true });
      const result = await mailboxActions.reopen(BASE_INPUT);
      expect(result).toEqual({ success: true });
      const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
      expect(body.action).toBe('reopen');
    });
  });

  describe('softDelete', () => {
    it('sends a soft-delete action', async () => {
      mockFetch(200, { success: true });
      const result = await mailboxActions.softDelete(BASE_INPUT);
      expect(result).toEqual({ success: true });
      const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
      expect(body.action).toBe('soft-delete');
    });
  });

  describe('restore', () => {
    it('sends a restore action', async () => {
      mockFetch(200, { success: true });
      const result = await mailboxActions.restore(BASE_INPUT);
      expect(result).toEqual({ success: true });
      const body = JSON.parse((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]!.body as string);
      expect(body.action).toBe('restore');
    });
  });

  describe('isServerError edge cases (internal helper)', () => {
    // isServerError is not exported, but its branches are exercised through
    // postAction's error-path logic. These tests verify specific input
    // shapes that exercise the uncovered branches.
    it('falls back to status line when response body is null (typeof null !== object → return false)', async () => {
      // A null JSON body → isServerError(null): typeof null !== 'object' is
      // false, null === null is true, so the function returns false early.
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('null', { status: 500, statusText: 'Server Error' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — 500 Server Error',
      );
    });

    it('falls back to status line when body.error is an object without code+message', async () => {
      // body = { error: {} } — isServerError returns false because the
      // nested object lacks string code+message. The detail falls back
      // to the status line.
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: {} }), { status: 422, statusText: 'Unprocessable' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — 422 Unprocessable',
      );
    });

    it('falls back to status line when body.error is a number (not object/string)', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 999 }), { status: 500, statusText: 'Server Error' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — 500 Server Error',
      );
    });

    it('falls back to status line when body.error has code but no message', async () => {
      // error.code is a string but error.message is missing → isServerError returns false.
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { code: 'ERR_X' } }), { status: 403, statusText: 'Forbidden' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — 403 Forbidden',
      );
    });
  });

  describe('error handling (postAction)', () => {
    it('throws with status line when the response is not ok and body is unparseable', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('not json', { status: 400, statusText: 'Bad Request' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow('mailbox action failed — 400 Bad Request');
    });

    it('extracts a string error from the response body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'message not found' }), { status: 404, statusText: 'Not Found' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — message not found',
      );
    });

    it('extracts a structured error (code + message) from the response body', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ error: { code: 'FORBIDDEN', message: 'no access' } }),
          { status: 403, statusText: 'Forbidden' },
        ),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — FORBIDDEN: no access',
      );
    });

    it('calls markAuthRequired on 401', async () => {
      // We need to check that store.markAuthRequired was called.
      // Import the store module's spy.
      const store = await import('../src/data/store/index.js');
      const markAuthRequiredSpy = vi.spyOn(store.useHqStore.getState(), 'markAuthRequired');

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, statusText: 'Unauthorized' }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await expect(mailboxActions.markRead(BASE_INPUT)).rejects.toThrow(
        'mailbox action failed — unauthorized',
      );
      expect(markAuthRequiredSpy).toHaveBeenCalledOnce();
    });
  });
});
