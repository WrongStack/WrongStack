import { expect, it } from 'vitest';
import { getRecentActivity } from '../agent-helpers.js';
import { createWrongTraceClient } from '../client.js';

const older = '2026-10-09T10:00:00+03:00';
const newer = '2026-10-09T08:00:00Z';
const filePath = 'src/example.ts';

async function readActivity(collisionTimes: string[], limit: number) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input));
    if (pathname === '/api/health') return Response.json({ status: 'ok', socket_path: '' });
    if (pathname === '/api/metrics/friction') {
      return Response.json({
        edges: [],
        recent_collisions: collisionTimes.map((overwriter_time) => ({
          file_path: filePath,
          overwriter_time,
        })),
      });
    }
    if (pathname === '/api/events/recent') {
      return Response.json([{ event_id: 'feed-1', file_path: filePath, event_time: older }]);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  const client = await createWrongTraceClient({
    baseUrl: 'http://127.0.0.1:1',
    socketPath: '',
    fetchImpl,
  });
  expect(client.isAvailable).toBe(true);
  return (await getRecentActivity(client, filePath, limit)).map((event) => event.at);
}

it('returns the newest dated event under a one-result cap, even alongside an undated event', async () => {
  expect(await readActivity(['unknown-time', newer], 1)).toEqual([newer]);
});

it('keeps undated events after all dated events and orders them by their labels', async () => {
  expect(await readActivity(['aaa', newer, 'zzz'], 4)).toEqual([newer, older, 'zzz', 'aaa']);
});

it('orders the two dated events by instant when both timestamps parse', async () => {
  expect(await readActivity([newer], 2)).toEqual([newer, older]);
});
