import { describe, it, expect } from 'vitest';
import { InMemoryBridgeTransport } from '../../src/coordination/in-memory-transport.js';
import { MailboxEventEmitter } from '../../src/coordination/mailbox-events.js';
import { DEFAULT_HQ_REDACTION_POLICY, HQ_TRANSCRIPT_TEXT_CAP } from '../../src/hq/protocol/tool.js';

// ── InMemoryBridgeTransport ──────────────────────────────────────────────

describe('InMemoryBridgeTransport', () => {
  it('delivers to a specific recipient', async () => {
    const transport = new InMemoryBridgeTransport();
    const received: unknown[] = [];
    transport.subscribe('bob', (msg) => received.push(msg));
    await transport.send(
      { from: 'alice', to: 'bob', type: 'note', subject: 'hi', body: 'hello' } as any,
      'bob',
    );
    expect(received).toHaveLength(1);
  });

  it('broadcast delivers to all except sender', async () => {
    const transport = new InMemoryBridgeTransport();
    const a: unknown[] = [];
    const b: unknown[] = [];
    const c: unknown[] = [];
    transport.subscribe('alice', (msg) => a.push(msg));
    transport.subscribe('bob', (msg) => b.push(msg));
    transport.subscribe('carol', (msg) => c.push(msg));
    await transport.send(
      { from: 'alice', to: '*', type: 'broadcast', subject: 'hey', body: 'all' } as any,
      '*',
    );
    expect(a).toHaveLength(0); // sender excluded
    expect(b).toHaveLength(1);
    expect(c).toHaveLength(1);
  });

  it('unsubscribe stops delivery', async () => {
    const transport = new InMemoryBridgeTransport();
    const received: unknown[] = [];
    const unsub = transport.subscribe('bob', (msg) => received.push(msg));
    unsub();
    await transport.send(
      { from: 'alice', to: 'bob', type: 'note', subject: 'x', body: 'y' } as any,
      'bob',
    );
    expect(received).toHaveLength(0);
  });

  it('close removes all handlers for an agent', async () => {
    const transport = new InMemoryBridgeTransport();
    const received: unknown[] = [];
    transport.subscribe('bob', (msg) => received.push(msg));
    transport.subscribe('bob', (msg) => received.push(msg));
    await transport.close('bob');
    await transport.send(
      { from: 'alice', to: 'bob', type: 'note', subject: 'x', body: 'y' } as any,
      'bob',
    );
    expect(received).toHaveLength(0);
  });

  it('handler errors are swallowed (do not crash the transport)', async () => {
    const transport = new InMemoryBridgeTransport();
    transport.subscribe('bob', () => {
      throw new Error('boom');
    });
    const received: unknown[] = [];
    transport.subscribe('bob', (msg) => received.push(msg));
    await transport.send(
      { from: 'alice', to: 'bob', type: 'note', subject: 'x', body: 'y' } as any,
      'bob',
    );
    expect(received).toHaveLength(1); // second handler still received
  });
});

// ── MailboxEventEmitter ──────────────────────────────────────────────────

describe('MailboxEventEmitter', () => {
  it('delivers events to subscribers', () => {
    const emitter = new MailboxEventEmitter();
    const events: unknown[] = [];
    emitter.subscribe((e) => events.push(e));
    emitter.emit({ type: 'message.sent', messageId: 'm1', timestamp: '2026-01-01T00:00:00Z' });
    expect(events).toHaveLength(1);
  });

  it('unsubscribe stops delivery', () => {
    const emitter = new MailboxEventEmitter();
    const events: unknown[] = [];
    const unsub = emitter.subscribe((e) => events.push(e));
    unsub();
    emitter.emit({ type: 'message.sent', messageId: 'm1', timestamp: '2026-01-01T00:00:00Z' });
    expect(events).toHaveLength(0);
  });

  it('subscriberCount tracks active listeners', () => {
    const emitter = new MailboxEventEmitter();
    expect(emitter.subscriberCount).toBe(0);
    const unsub = emitter.subscribe(() => {});
    expect(emitter.subscriberCount).toBe(1);
    unsub();
    expect(emitter.subscriberCount).toBe(0);
  });

  it('clear removes all listeners', () => {
    const emitter = new MailboxEventEmitter();
    emitter.subscribe(() => {});
    emitter.subscribe(() => {});
    emitter.clear();
    expect(emitter.subscriberCount).toBe(0);
  });

  it('listener errors are swallowed', () => {
    const emitter = new MailboxEventEmitter();
    emitter.subscribe(() => {
      throw new Error('boom');
    });
    const events: unknown[] = [];
    emitter.subscribe((e) => events.push(e));
    emitter.emit({ type: 'message.acked', messageId: 'm1', timestamp: '2026-01-01T00:00:00Z' });
    expect(events).toHaveLength(1);
  });
});

// ── HQ protocol constants ────────────────────────────────────────────────

describe('HQ protocol constants', () => {
  it('DEFAULT_HQ_REDACTION_POLICY has expected defaults', () => {
    expect(DEFAULT_HQ_REDACTION_POLICY.rawContent).toBe(true);
    expect(DEFAULT_HQ_REDACTION_POLICY.toolArgs).toBe('full');
    expect(DEFAULT_HQ_REDACTION_POLICY.paths).toBe('full');
  });

  it('HQ_TRANSCRIPT_TEXT_CAP is 16000', () => {
    expect(HQ_TRANSCRIPT_TEXT_CAP).toBe(16_000);
  });
});
