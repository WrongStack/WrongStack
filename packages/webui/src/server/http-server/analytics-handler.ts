/**
 * HTTP /api/analytics handler for the WebUI server.
 *
 * Accepts a batch of analytics events from the frontend, validates them,
 * and stores them for later aggregation. Events are kept in a small
 * in-memory ring buffer (last 1000) and can be retrieved via GET for
 * debugging or exported to an external system.
 *
 * The endpoint is intentionally simple: no persistent storage, no external
 * dependencies. If you need durable analytics, poll the GET endpoint
 * and ship the events to your own aggregation pipeline (PostHog,
 * Segment, etc.).
 */
import type * as http from 'node:http';

export interface AnalyticsEvent {
  event: string;
  category: string;
  label?: string | undefined;
  value?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  timestamp: string;
  sessionId?: string | undefined;
  userAgent?: string | undefined;
}

const EVENT_BUFFER: AnalyticsEvent[] = [];
const MAX_BUFFER_SIZE = 1000;

// Running counters so /summary is O(1) instead of O(n). Maintained alongside
// the ring buffer; reset together with the buffer (see clearAnalyticsBuffer).
const EVENT_COUNTS = new Map<string, number>();
const CATEGORY_COUNTS = new Map<string, number>();

function incCount(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function decCount(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next <= 0) {
    map.delete(key);
  } else {
    map.set(key, next);
  }
}

function pushEvent(event: AnalyticsEvent): void {
  EVENT_BUFFER.push(event);
  incCount(EVENT_COUNTS, event.event);
  incCount(CATEGORY_COUNTS, event.category);
  // Cap the ring buffer; decrement the counter for the evicted event.
  if (EVENT_BUFFER.length > MAX_BUFFER_SIZE) {
    const evicted = EVENT_BUFFER.shift();
    if (evicted) {
      decCount(EVENT_COUNTS, evicted.event);
      decCount(CATEGORY_COUNTS, evicted.category);
    }
  }
}

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf-8');
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isValidEvent(obj: unknown): obj is AnalyticsEvent {
  if (typeof obj !== 'object' || obj === null) return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e.event === 'string' &&
    typeof e.category === 'string' &&
    typeof e.timestamp === 'string'
  );
}

/** POST /api/analytics — ingest a batch of events from the frontend. */
export async function handleApiAnalyticsPost(
  res: http.ServerResponse,
  req: http.IncomingMessage,
): Promise<void> {
  try {
    const body = await parseBody(req);
    const events = Array.isArray(body) ? body : [body];
    const validEvents: AnalyticsEvent[] = [];
    const rejected: number[] = [];

    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (isValidEvent(evt)) {
        // Enrich with server-side metadata
        const enriched: AnalyticsEvent = {
          ...evt,
          userAgent: req.headers['user-agent'] ?? undefined,
        };
        pushEvent(enriched);
        validEvents.push(enriched);
      } else {
        rejected.push(i);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        accepted: validEvents.length,
        rejected: rejected.length,
        rejectedIndices: rejected,
      }),
    );
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

/** GET /api/analytics — retrieve the last N events (debug/export). */
export async function handleApiAnalyticsGet(
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
  const limit = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
  const events = EVENT_BUFFER.slice(-limit);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events, total: EVENT_BUFFER.length }));
}

/** GET /api/analytics/summary — aggregated stats for quick inspection. */
export async function handleApiAnalyticsSummary(
  res: http.ServerResponse,
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      totalEvents: EVENT_BUFFER.length,
      uniqueEvents: EVENT_COUNTS.size,
      uniqueCategories: CATEGORY_COUNTS.size,
      eventBreakdown: Object.fromEntries(EVENT_COUNTS),
      categoryBreakdown: Object.fromEntries(CATEGORY_COUNTS),
      oldestTimestamp: EVENT_BUFFER[0]?.timestamp ?? null,
      newestTimestamp: EVENT_BUFFER[EVENT_BUFFER.length - 1]?.timestamp ?? null,
    }),
  );
}

/** Clear the in-memory buffer (useful for testing). */
export function clearAnalyticsBuffer(): void {
  EVENT_BUFFER.length = 0;
  EVENT_COUNTS.clear();
  CATEGORY_COUNTS.clear();
}

/** Get a snapshot of the buffer (useful for testing). */
export function getAnalyticsBuffer(): readonly AnalyticsEvent[] {
  return [...EVENT_BUFFER];
}