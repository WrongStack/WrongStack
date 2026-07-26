/**
 * GM-P0.12 — Cross-process concurrency and version fence tests.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GlobalMailbox } from '../../src/coordination/global-mailbox.js';
import { assertMailboxNotFenced, checkMailboxVersion, sentinelLine } from '../../src/coordination/mailbox-version-fence.js';
import type { MailboxActorContext } from '../../src/coordination/mailbox-types.js';
import type { EventBus } from '../../src/kernel/events.js';

let dir: string;
let mb: GlobalMailbox;
const events = { emitCustom: () => {} } as unknown as EventBus;

function actor(overrides: Partial<MailboxActorContext> = {}): MailboxActorContext {
  return {
    actorId: 'leader@sess-1',
    projectId: 'test',
    kind: 'agent',
    capabilities: new Set(['mail.send.informational','mail.send.actionable','mail.read.self','mail.ack.self']),
    authMode: 'identity-token',
    recipientAliases: new Set(['leader']),
    sessionId: 'sess-1',
    role: 'leader',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-mp-'));
  mb = new GlobalMailbox(dir, events);
});

afterEach(async () => {
  await mb.close();
  await fs.rm(dir, { recursive: true, force: true });
});

// ── 1. Cross-process send ───────────────────────────────────────────

describe('cross-process send', () => {
  it('two instances interleaving sends preserve all messages', async () => {
    const mbA = new GlobalMailbox(dir, events);
    const mbB = new GlobalMailbox(dir, events);
    const aA = actor({ actorId: 'proc-a', recipientAliases: new Set() });
    const aB = actor({ actorId: 'proc-b', recipientAliases: new Set() });

    await mbA.sendFor(aA, { subject: 'msg-1', body: 'from-a', type: 'note', to: 'proc-a', priority: 'normal' });
    await mbB.sendFor(aB, { subject: 'msg-2', body: 'from-b', type: 'note', to: 'proc-b', priority: 'normal' });
    await mbA.sendFor(aA, { subject: 'msg-3', body: 'from-a-2', type: 'note', to: 'proc-a', priority: 'normal' });
    await mbB.sendFor(aB, { subject: 'msg-4', body: 'from-b-2', type: 'note', to: 'proc-b', priority: 'normal' });

    await mbA.close();
    await mbB.close();

    const mbR = new GlobalMailbox(dir, events);
    const all = await mbR.query({}, actor({ recipientAliases: new Set() }));
    await mbR.close();

    expect(all).toHaveLength(4);
    expect(all.map((m) => m.subject).sort()).toEqual(['msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });
});

// ── 2. Acknowledge ─────────────────────────────────────────────────

describe('ack', () => {
  it('legacy ack works (baseline)', async () => {
    const msg = await mb.send({
      from: 'leader@sess-1', to: 'leader@sess-1', type: 'note', subject: 's', body: 'b', priority: 'normal',
    });
    const acked = await mb.ackFor(actor(), { messageId: msg.id, read: true });
    expect(acked).not.toBeNull();
    expect(acked!.readBy['leader@sess-1']).toBeDefined();
  });

  it('B can ack a broadcast sent by A (cross-process)', async () => {
    // Instance A sends
    const mbA = new GlobalMailbox(dir, events);
    const msg = await mbA.send({
      from: 'sender', to: '*', type: 'broadcast', subject: 'xproc', body: 'ack-me', priority: 'normal',
    });

    // Instance B reads + acks
    const mbB = new GlobalMailbox(dir, events);
    const before = await mbB.query({}, actor({ actorId: 'receiver', recipientAliases: new Set() }));
    expect(before.length).toBeGreaterThanOrEqual(1);
    const result = await mbB.ackFor(actor({ actorId: 'receiver', recipientAliases: new Set() }), { messageId: msg.id, read: true, completed: true });
    expect(result).not.toBeNull();
    expect(Object.keys(result?.readBy||{}).length).toBeGreaterThan(0);
    expect(Object.keys(result?.completedBy||{}).length).toBeGreaterThan(0);

    await mbA.close();
    await mbB.close();
  });
});

// ── 3. Version fence ────────────────────────────────────────────────

describe('version fence', () => {
  it('assertMailboxNotFenced detects a sentinel', async () => {
    const file = path.join(dir, '_mailbox.jsonl');
    await fs.writeFile(file, sentinelLine());
    await expect(assertMailboxNotFenced(dir)).rejects.toThrow();
  });

  it('checkMailboxVersion reads the version marker', async () => {
    const file = path.join(dir, '_mailbox.jsonl');
    await fs.writeFile(file, sentinelLine());
    const version = await checkMailboxVersion(path.join(dir, '_mailbox.jsonl'));
    expect(version).toBe(2);
  });
});

// ── 4. Heavy concurrent sends ───────────────────────────────────────

describe('heavy concurrent sends', () => {
  it('5 instances × 10 messages = 50', async () => {
    const instances = Array.from({ length: 5 }, () => new GlobalMailbox(dir, events));
    const promises = instances.map((mbi, i) => {
      const a = actor({ actorId: `sender-${i}`, recipientAliases: new Set() });
      return Promise.all(
        Array.from({ length: 10 }, (_, j) =>
          mbi.sendFor(a, { subject: `msg-${i}-${j}`, body: `from-${i}`, type: 'note', to: '*', priority: 'normal' }),
        ),
      );
    });
    await Promise.all(promises);
    await Promise.all(instances.map((mbi) => mbi.close()));

    const mbR = new GlobalMailbox(dir, events);
    const all = await mbR.query({}, actor({ recipientAliases: new Set() }));
    await mbR.close();
    expect(all).toHaveLength(50);
  });
});
