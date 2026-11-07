/**
 * @vitest-environment node
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAnalyticsBuffer,
  getAnalyticsBuffer,
  handleApiAnalyticsGet,
  handleApiAnalyticsPost,
  handleApiAnalyticsSummary,
} from '../src/server/http-server/analytics-handler.js';

function createMockReq(body: unknown, method = 'POST'): IncomingMessage {
  const req = {
    method,
    headers: { 'user-agent': 'test-agent' },
    on: (event: string, handler: (data?: Buffer) => void) => {
      if (event === 'data') {
        const data = Buffer.from(JSON.stringify(body), 'utf-8');
        handler(data);
      }
      if (event === 'end') {
        handler();
      }
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

function createMockRes(): ServerResponse & { body?: string | undefined } {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number | string[]>,
    writeHead: (code: number, headers: Record<string, string | number | string[]>) => {
      res.statusCode = code;
      res.headers = headers;
      return res;
    },
    end: (data?: string) => {
      res.body = data;
      return res;
    },
    body: undefined as string | undefined,
  } as unknown as ServerResponse & {
    body?: string | undefined;
    headers: Record<string, string | number | string[]>;
  };
  return res;
}

describe('handleApiAnalyticsPost', () => {
  beforeEach(() => {
    clearAnalyticsBuffer();
  });

  it('accepts a single valid event', async () => {
    const event = {
      event: 'test_event',
      category: 'test',
      timestamp: new Date().toISOString(),
    };
    const req = createMockReq(event);
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.accepted).toBe(1);
    expect(body.rejected).toBe(0);
    expect(getAnalyticsBuffer()).toHaveLength(1);
  });

  it('accepts a batch of events', async () => {
    const events = [
      { event: 'event1', category: 'cat1', timestamp: new Date().toISOString() },
      { event: 'event2', category: 'cat2', timestamp: new Date().toISOString() },
      { event: 'event3', category: 'cat3', timestamp: new Date().toISOString() },
    ];
    const req = createMockReq(events);
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.accepted).toBe(3);
    expect(body.rejected).toBe(0);
    expect(getAnalyticsBuffer()).toHaveLength(3);
  });

  it('rejects invalid events and accepts valid ones', async () => {
    const events = [
      { event: 'valid', category: 'test', timestamp: new Date().toISOString() },
      { invalid: 'no event field' },
      { event: 'also_valid', category: 'test', timestamp: new Date().toISOString() },
    ];
    const req = createMockReq(events);
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(1);
    expect(body.rejectedIndices).toEqual([1]);
    expect(getAnalyticsBuffer()).toHaveLength(2);
  });

  it('enriches events with user-agent', async () => {
    const event = {
      event: 'test_event',
      category: 'test',
      timestamp: new Date().toISOString(),
    };
    const req = createMockReq(event);
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    const buffer = getAnalyticsBuffer();
    expect(buffer[0]?.userAgent).toBe('test-agent');
  });

  it('returns 400 for invalid JSON', async () => {
    const req = {
      method: 'POST',
      headers: {},
      on: (event: string, handler: (data?: Buffer) => void) => {
        if (event === 'data') {
          handler(Buffer.from('not-json', 'utf-8'));
        }
        if (event === 'end') {
          handler();
        }
        return req;
      },
    } as unknown as IncomingMessage;
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body!);
    expect(body.error).toBe('Invalid JSON body');
  });

  it('returns 413 before retaining an oversized request body', async () => {
    const req = createMockReq({
      event: 'oversized',
      category: 'test',
      timestamp: new Date().toISOString(),
      metadata: { payload: 'x'.repeat(300_000) },
    });
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(res.statusCode).toBe(413);
    expect(getAnalyticsBuffer()).toHaveLength(0);
  });

  it('rejects a single event that exceeds the retained-event budget', async () => {
    const req = createMockReq({
      event: 'large_event',
      category: 'test',
      timestamp: new Date().toISOString(),
      metadata: { payload: 'x'.repeat(40_000) },
    });
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body!).rejected).toBe(1);
    expect(getAnalyticsBuffer()).toHaveLength(0);
  });
});

describe('handleApiAnalyticsGet', () => {
  beforeEach(() => {
    clearAnalyticsBuffer();
  });

  it('returns empty buffer initially', async () => {
    const res = createMockRes();
    const url = new URL('http://localhost/api/analytics');

    await handleApiAnalyticsGet(res, url);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.events).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns recent events', async () => {
    // Seed the buffer
    const events = Array.from({ length: 10 }, (_, i) => ({
      event: `event_${i}`,
      category: 'test',
      timestamp: new Date().toISOString(),
    }));
    const req = createMockReq(events);
    const res1 = createMockRes();
    await handleApiAnalyticsPost(res1, req);

    const res2 = createMockRes();
    const url = new URL('http://localhost/api/analytics?limit=5');
    await handleApiAnalyticsGet(res2, url);

    expect(res2.statusCode).toBe(200);
    const body = JSON.parse(res2.body!);
    expect(body.events).toHaveLength(5);
    expect(body.total).toBe(10);
  });

  it('caps limit at 1000', async () => {
    const res = createMockRes();
    const url = new URL('http://localhost/api/analytics?limit=9999');

    await handleApiAnalyticsGet(res, url);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    // Should not error, just cap the limit
    expect(body.events).toEqual([]);
  });
});

describe('handleApiAnalyticsSummary', () => {
  beforeEach(() => {
    clearAnalyticsBuffer();
  });

  it('returns empty summary', async () => {
    const res = createMockRes();

    await handleApiAnalyticsSummary(res);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.totalEvents).toBe(0);
    expect(body.uniqueEvents).toBe(0);
    expect(body.uniqueCategories).toBe(0);
    expect(body.eventBreakdown).toEqual({});
    expect(body.categoryBreakdown).toEqual({});
    expect(body.oldestTimestamp).toBeNull();
    expect(body.newestTimestamp).toBeNull();
  });

  it('returns aggregated stats', async () => {
    const events = [
      { event: 'click', category: 'engagement', timestamp: '2026-01-01T00:00:00Z' },
      { event: 'click', category: 'engagement', timestamp: '2026-01-01T00:01:00Z' },
      { event: 'view', category: 'page', timestamp: '2026-01-01T00:02:00Z' },
      { event: 'error', category: 'system', timestamp: '2026-01-01T00:03:00Z' },
    ];
    const req = createMockReq(events);
    const res1 = createMockRes();
    await handleApiAnalyticsPost(res1, req);

    const res2 = createMockRes();
    await handleApiAnalyticsSummary(res2);

    expect(res2.statusCode).toBe(200);
    const body = JSON.parse(res2.body!);
    expect(body.totalEvents).toBe(4);
    expect(body.uniqueEvents).toBe(3); // click, view, error
    expect(body.uniqueCategories).toBe(3); // engagement, page, system
    expect(body.eventBreakdown).toEqual({ click: 2, view: 1, error: 1 });
    expect(body.categoryBreakdown).toEqual({ engagement: 2, page: 1, system: 1 });
    expect(body.oldestTimestamp).toBe('2026-01-01T00:00:00Z');
    expect(body.newestTimestamp).toBe('2026-01-01T00:03:00Z');
  });
});

describe('buffer eviction', () => {
  beforeEach(() => {
    clearAnalyticsBuffer();
  });

  it('evicts oldest events when buffer exceeds 1000', async () => {
    const events = Array.from({ length: 1005 }, (_, i) => ({
      event: `event_${i}`,
      category: 'test',
      timestamp: new Date().toISOString(),
    }));
    const req = createMockReq(events);
    const res = createMockRes();

    await handleApiAnalyticsPost(res, req);

    expect(getAnalyticsBuffer()).toHaveLength(1000);
    // First 5 should have been evicted
    const buffer = getAnalyticsBuffer();
    expect(buffer[0]?.event).toBe('event_5');
    expect(buffer[buffer.length - 1]?.event).toBe('event_1004');
  });
});
