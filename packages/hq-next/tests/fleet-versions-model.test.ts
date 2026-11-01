/**
 * Release drift across the fleet, and whether the HQ address can be handed to
 * another machine.
 */
import type { HqClientRecord, HqSnapshot } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { buildAttentionItems } from '../src/features/attention/model';
import { compareVersions, driftLine, versionDrift } from '../src/features/attention/versions';
import { hubAddressAdvice } from '../src/lib/hub-address';

const client = (id: string, version: string | undefined, connected = true): HqClientRecord =>
  ({
    clientId: id,
    kind: 'tui',
    machineId: `m-${id}`,
    hostname: `host-${id}`,
    connected,
    lastSeenAt: '2026-11-01T12:00:00.000Z',
    projectId: 'p1',
    capabilities: [],
    ...(version !== undefined ? { version } : {}),
  }) as HqClientRecord;

describe('compareVersions', () => {
  it('orders release versions numerically and refuses anything else', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.3.0', '1.3.0')).toBe(0);
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1);
    expect(compareVersions('dev', '1.3.0')).toBeNull();
  });
});

describe('versionDrift', () => {
  it('measures connected clients against the hub', () => {
    const drift = versionDrift(
      [
        client('a', '1.3.0'),
        client('b', '1.2.0'),
        client('c', '1.4.0'),
        client('d', '1.1.0', false),
      ],
      'v1.3.0',
    );
    expect(drift.hub).toBe('1.3.0');
    expect(drift.behind.map((c) => c.clientId)).toEqual(['b']);
    expect(drift.ahead.map((c) => c.clientId)).toEqual(['c']);
    expect(drift.versions).toEqual([
      { version: '1.4.0', count: 1 },
      { version: '1.3.0', count: 1 },
      { version: '1.2.0', count: 1 },
    ]);
    expect(driftLine(drift)).toEqual({ value: '1 behind · 1 ahead of HQ 1.3.0', tone: 'warn' });
  });

  it('falls back to "mixed or not" without a release hub', () => {
    expect(driftLine(versionDrift([client('a', '1.3.0'), client('b', '1.3.0')], 'dev'))).toEqual({
      value: 'All on 1.3.0',
      tone: 'ok',
    });
    expect(
      driftLine(versionDrift([client('a', '1.3.0'), client('b', '1.2.0')], undefined)),
    ).toEqual({ value: '2 versions in use', tone: 'warn' });
    expect(driftLine(versionDrift([client('a', undefined)], '1.3.0')).tone).toBe('muted');
  });

  it('puts one fleet-wide item in the attention queue', () => {
    const snapshot = {
      hqVersion: '1.3.0',
      clients: [client('a', '1.3.0'), client('b', '1.2.0'), client('c', '1.2.0')],
      projects: [],
      sessions: [],
      fleets: [],
      mailboxes: [],
      totals: {},
    } as unknown as HqSnapshot;
    const items = buildAttentionItems({
      snapshot,
      approvals: [],
      questions: [],
      alerts: [],
      commands: [],
    });
    expect(items.map((item) => [item.id, item.title, item.context])).toEqual([
      [
        'version:fleet',
        '2 clients run a different WrongStack than HQ 1.3.0',
        'host-b 1.2.0 · host-c 1.2.0',
      ],
    ]);
  });
});

describe('hubAddressAdvice', () => {
  it('flags loopback origins and keeps the port in the example', () => {
    expect(hubAddressAdvice('http://127.0.0.1:3499')).toEqual({
      kind: 'loopback',
      host: '127.0.0.1',
      example: 'http://<hq-machine-address>:3499',
    });
    expect(hubAddressAdvice('http://localhost:3499').kind).toBe('loopback');
    expect(hubAddressAdvice('http://[::1]:3499').kind).toBe('loopback');
    expect(hubAddressAdvice('https://hq.lan').kind).toBe('reachable');
    expect(hubAddressAdvice('http://192.168.1.20:3499').kind).toBe('reachable');
  });
});
