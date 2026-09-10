/**
 * Publishing unredacted session content to a REMOTE HQ over cleartext must not
 * be silent.
 *
 * `DEFAULT_HQ_REDACTION_POLICY` is `{rawContent: true, toolArgs: 'full',
 * paths: 'full'}` — the most open setting available. That is defensible when HQ
 * is on the same machine and the console is the product. It is not defensible
 * when the endpoint is remote and the transport is plain `ws:`: the payload
 * then carries prompts, thinking blocks, verbatim tool arguments and absolute
 * paths, in the clear, to anyone on the path.
 *
 * The publisher warns rather than clamping. A clamp is the stronger control but
 * changes what an operator sees in a topology they chose (HQ over a VPN on
 * `ws:` is legitimate), and a console that quietly starts showing `[REDACTED]`
 * reads as a bug. Changing the default is recorded as an owner decision.
 *
 * These tests pin both directions: it fires when it should, and — just as
 * important for a warning nobody must learn to ignore — it stays silent for
 * loopback, for TLS, and for a publisher that already redacts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HqPublisher, type HqSocketLike } from '../../src/hq/publisher.js';

class FakeSocket implements HqSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? new Set();
    existing.add(listener);
    this.listeners.set(type, existing);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get('open') ?? []) listener({});
  }
}

const client = {
  clientId: 'client_1',
  kind: 'cli' as const,
  machineId: 'machine_1',
  startedAt: '2026-07-03T09:00:00.000Z',
};

const project = {
  projectId: 'project_1',
  projectRoot: '/repo',
  projectName: 'repo',
  machineId: 'machine_1',
  workspaceKind: 'git' as const,
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Connect a publisher to `url` and return every warn line it emitted. */
function warningsForEndpoint(
  url: string,
  redactionPolicy?: Parameters<typeof HqPublisher>[0]['redactionPolicy'],
): string[] {
  const warnings: string[] = [];
  const socket = new FakeSocket();
  const publisher = new HqPublisher({
    url,
    client,
    project,
    reconnect: false,
    socketFactory: () => socket,
    logger: { warn: (msg: string) => warnings.push(msg) },
    ...(redactionPolicy !== undefined ? { redactionPolicy } : {}),
  });
  publisher.connect();
  socket.open();
  publisher.close();
  return warnings.filter((line) => line.includes('raw_content_over_cleartext'));
}

describe('HqPublisher warns before shipping raw content over cleartext', () => {
  it('warns for a remote ws:// endpoint on the wide-open default policy', () => {
    const warnings = warningsForEndpoint('ws://hq.example.com:3499');
    expect(warnings).toHaveLength(1);
    const payload = JSON.parse(warnings[0]!);
    expect(payload.event).toBe('hq.publisher.raw_content_over_cleartext');
    expect(payload.endpoint).toBe('ws://hq.example.com:3499');
    expect(payload.rawContent).toBe(true);
    // The message must name the fix, not just the problem.
    expect(payload.message).toContain('wss://');
  });

  it('warns only once per endpoint, so a reconnect loop cannot flood the log', () => {
    const first = warningsForEndpoint('ws://hq.repeat.example:3499');
    const second = warningsForEndpoint('ws://hq.repeat.example:3499');
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it.each([
    ['loopback IPv4', 'ws://127.0.0.1:3499'],
    ['localhost', 'ws://localhost:3499'],
    ['loopback IPv6', 'ws://[::1]:3499'],
  ])('stays silent for %s — the content never leaves the machine', (_label, url) => {
    expect(warningsForEndpoint(url)).toEqual([]);
  });

  it('stays silent over TLS, where the content is not in the clear', () => {
    expect(warningsForEndpoint('wss://hq.secure.example:3499')).toEqual([]);
  });

  it('stays silent when the publisher already redacts', () => {
    expect(
      warningsForEndpoint('ws://hq.redacted.example:3499', {
        rawContent: false,
        toolArgs: 'summary',
        paths: 'relative',
      }),
    ).toEqual([]);
  });

  it('still warns when only tool arguments are disclosed in full', () => {
    // Partial redaction is not safety: verbatim tool args carry command lines
    // and file contents on their own.
    const warnings = warningsForEndpoint('ws://hq.partial.example:3499', {
      rawContent: false,
      toolArgs: 'full',
      paths: 'relative',
    });
    expect(warnings).toHaveLength(1);
  });
});
