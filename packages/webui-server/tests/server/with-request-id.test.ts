import { describe, expect, it } from 'vitest';
import { withRequestId } from '../../src/server/ws-utils.js';

/**
 * B-04 (docs/audit/webui-full-review-2026-09-03.md) — inspect-style
 * handlers (`tools.list`, `memory.sage.*`, `skills.list`, `stats.get`,
 * `diag.get`, `context.debug`, `memory.list`) echo the request's
 * `requestId` on the response so the client can correlate the reply
 * with the request and key its `echoToChat: false` suppression exactly
 * one-to-one.
 *
 * `withRequestId` is the single helper the handlers all funnel through.
 * It accepts EITHER the full request message (then it reads
 * `requestPayload.payload.requestId`) OR the request payload object
 * directly (then it reads `requestPayload.requestId`). The tests below
 * pin both calling conventions and the no-op fallbacks.
 */
describe('withRequestId (B-04 requestId echo)', () => {
  it('copies requestId from a request payload object', () => {
    const result = withRequestId({ requestId: 'rid-1' }, { foo: 1 });
    expect(result).toEqual({ foo: 1, requestId: 'rid-1' });
  });

  it('copies requestId from a full request message (payload.requestId)', () => {
    const result = withRequestId(
      { type: 'tools.list', payload: { requestId: 'rid-2' } },
      { tools: [] },
    );
    expect(result).toEqual({ tools: [], requestId: 'rid-2' });
  });

  it('prefers the top-level requestId when both are present', () => {
    // Defensive: a malformed envelope could carry both. Top-level wins
    // because it's the explicit caller-supplied form.
    const result = withRequestId(
      { requestId: 'rid-top', payload: { requestId: 'rid-nested' } },
      {},
    );
    expect(result.requestId).toBe('rid-top');
  });

  it('is a no-op when neither form carries a requestId', () => {
    expect(withRequestId({}, { foo: 1 })).toEqual({ foo: 1 });
    expect(withRequestId({ payload: {} }, { foo: 1 })).toEqual({ foo: 1 });
    expect(withRequestId(undefined, { foo: 1 })).toEqual({ foo: 1 });
    expect(withRequestId(null, { foo: 1 })).toEqual({ foo: 1 });
  });

  it('drops empty-string requestIds (treated as absent)', () => {
    expect(withRequestId({ requestId: '' }, { foo: 1 })).toEqual({ foo: 1 });
    expect(
      withRequestId({ payload: { requestId: '' } }, { foo: 1 }),
    ).toEqual({ foo: 1 });
  });

  it('drops non-string requestIds (treated as absent)', () => {
    expect(withRequestId({ requestId: 42 }, { foo: 1 })).toEqual({ foo: 1 });
    expect(
      withRequestId({ payload: { requestId: null } }, { foo: 1 }),
    ).toEqual({ foo: 1 });
  });

  it('does not mutate the response payload object', () => {
    const payload = { tools: [1, 2, 3] };
    withRequestId({ requestId: 'rid' }, payload);
    expect(payload).toEqual({ tools: [1, 2, 3] });
    expect((payload as { requestId?: string }).requestId).toBeUndefined();
  });
});
