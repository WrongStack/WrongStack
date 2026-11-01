/**
 * MCP view rules: which servers lead, what the sentence says, and how the
 * Overview row summarises the fleet.
 */
import type { HqClientRecord, HqMcpServerHealth, HqProjectRecord } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import {
  checkValue,
  formatMs,
  latencyLine,
  mcpFigures,
  mcpGroups,
  serverSentence,
} from '../src/features/mcp/model';
import { mcpHealthRow } from '../src/features/overview/model';
import { hrefForView, tabForPath } from '../src/lib/sections';

const latency = { count: 0 };

const server = (name: string, extra: Partial<HqMcpServerHealth> = {}): HqMcpServerHealth => ({
  name,
  projectId: 'p1',
  clientId: 'c1',
  connectionState: 'connected',
  healthState: 'healthy',
  consecutiveFailures: 0,
  failures: { transport: 0, protocol: 0, tool: 0 },
  reconnectCount: 0,
  wakeCount: 0,
  sleepCount: 0,
  restartCount: 0,
  connectionLatency: latency,
  discoveryLatency: latency,
  callLatency: latency,
  inFlightCalls: 0,
  peakInFlightCalls: 0,
  healthChecks: [],
  ...extra,
});

const projects = [
  { projectId: 'p1', projectName: 'alpha' },
  { projectId: 'p2', projectName: 'beta' },
] as unknown as HqProjectRecord[];
const clients = [
  { clientId: 'c1', machineId: 'm1', hostname: 'devbox', pid: 42 },
] as unknown as HqClientRecord[];

describe('mcpGroups', () => {
  it('puts the project with a failing server first, failures at the top', () => {
    const groups = mcpGroups(
      [
        server('github'),
        server('browser', { healthState: 'dormant' }),
        server('db', { projectId: 'p2', healthState: 'failed' }),
        server('search', { healthState: 'degraded' }),
      ],
      projects,
      clients,
    );
    expect(groups.map((group) => group.projectName)).toEqual(['beta', 'alpha']);
    expect(groups[1]?.rows.map((row) => row.server.name)).toEqual(['search', 'github', 'browser']);
    expect(groups[1]?.attention).toBe(1);
  });

  it('names the terminal and keeps a server reported twice by one terminal apart', () => {
    const [group] = mcpGroups([server('github'), server('github')], projects, clients);
    expect(group?.rows.map((row) => row.key)).toEqual(['c1:github', 'c1:github#1']);
    expect(group?.rows[0]?.where).toBe('devbox · pid 42');
    const [unknown] = mcpGroups([server('x', { clientId: 'abcdef123456' })], projects, []);
    expect(unknown?.rows[0]?.where).toBe('terminal abcdef12');
  });
});

describe('serverSentence', () => {
  it('names the last error and the broken limits of a failing server', () => {
    expect(
      serverSentence(
        server('db', {
          healthState: 'failed',
          lastFailureKind: 'transport',
          consecutiveFailures: 3,
          healthChecks: [
            { name: 'call-latency-p95', passed: false, value: 9000, threshold: 2000 },
            { name: 'in-flight-calls', passed: true, value: 1, threshold: 4 },
          ],
        }),
      ),
    ).toBe(
      'Last error: the connection broke (3 times in a row). Over its limit: Tool calls (p95).',
    );
    expect(serverSentence(server('db', { healthState: 'degraded' }))).toBe(
      'No cause was reported.',
    );
  });

  it('says what a healthy, sleeping or reconnecting server is doing', () => {
    expect(serverSentence(server('a'))).toBe('Connected and answering.');
    expect(serverSentence(server('a', { inFlightCalls: 2 }))).toBe('2 calls running now.');
    expect(serverSentence(server('a', { healthState: 'dormant' }))).toMatch(/^Asleep/);
    expect(serverSentence(server('a', { healthState: 'connecting', reconnectCount: 1 }))).toBe(
      'Reconnecting (1 reconnect so far).',
    );
  });
});

describe('number formatting', () => {
  it('reads milliseconds and seconds, and counts for the concurrency check', () => {
    expect(formatMs(120.4)).toBe('120 ms');
    expect(formatMs(2_500)).toBe('2.5 s');
    expect(formatMs(12_000)).toBe('12 s');
    expect(formatMs(undefined)).toBe('—');
    expect(checkValue({ name: 'in-flight-calls', passed: true }, 3)).toBe('3');
    expect(checkValue({ name: 'call-latency-p95', passed: true }, 900)).toBe('900 ms');
  });

  it('summarises latency only once something was measured', () => {
    expect(latencyLine({ count: 0 })).toBeNull();
    expect(latencyLine({ count: 4, p50Ms: 100, p95Ms: 800 })).toBe('p50 100 ms · p95 800 ms');
    expect(latencyLine({ count: 1, lastMs: 50 })).toBe('last 50 ms');
  });
});

describe('fleet figures', () => {
  it('counts trouble, healthy and idle servers', () => {
    expect(
      mcpFigures([
        server('a'),
        server('b', { healthState: 'connecting' }),
        server('c', { healthState: 'failed' }),
        server('d', { healthState: 'disabled' }),
      ]),
    ).toEqual({ total: 4, failed: 1, degraded: 0, healthy: 2, idle: 1 });
  });

  it('feeds the Overview row, warning only on failing or degraded servers', () => {
    expect(mcpHealthRow(undefined)).toEqual({ value: 'None reported', tone: 'muted' });
    expect(mcpHealthRow([server('a'), server('b')])).toEqual({ value: '2 healthy', tone: 'ok' });
    expect(mcpHealthRow([server('a'), server('b', { healthState: 'dormant' })])).toEqual({
      value: '1 healthy · 1 asleep or off',
      tone: 'ok',
    });
    expect(
      mcpHealthRow([
        server('a', { healthState: 'failed' }),
        server('b', { healthState: 'degraded' }),
        server('c'),
      ]),
    ).toEqual({ value: '1 failing · 1 degraded of 3', tone: 'warn' });
  });
});

describe('MCP route', () => {
  it('lives under System at /system/mcp/', () => {
    expect(hrefForView('mcp')).toBe('/system/mcp/');
    expect(tabForPath('/system/mcp/').view).toBe('mcp');
  });
});
