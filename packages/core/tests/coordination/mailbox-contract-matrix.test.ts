/**
 * Cross-surface mailbox contract matrix — core surface.
 *
 * GM-P0.11: Iterates over all (fixture, 'core') pairs and asserts
 * that the canonical input normalizes correctly through the direct
 * SqliteMailbox API.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMailbox } from '../../src/coordination/sqlite-mailbox.js';
import {
  allMatrixFixtures,
  type MatrixFixture,
  type MailboxSurface,
} from './mailbox-contract-fixtures.js';

const TARGET_SURFACE: MailboxSurface = 'core';

let dir: string;
let mb: SqliteMailbox;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-contract-'));
  mb = new SqliteMailbox(dir);
});

afterEach(async () => {
  await mb.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function runFixture(fix: MatrixFixture): Promise<Record<string, unknown>> {
  switch (fix.category) {
    case 'send-valid':
    case 'send-invalid': {
      try {
        const msg = await mb.send({
          from: 'test-agent',
          to: fix.input.to as string,
          subject: fix.input.subject as string,
          body: fix.input.body as string,
          type: fix.input.type as any,
        });
        return { ok: true, messageId: msg.id };
      } catch (err) {
        return { error: (err as Error).message };
      }
    }
    case 'query-valid': {
      const messages = await mb.query({
        to: fix.input.to as string,
        ...(fix.input.replyTo !== undefined ? { replyTo: fix.input.replyTo as string } : {}),
      });
      return { ok: true, count: messages.length };
    }
    case 'ack-valid': {
      const msg = await mb.send({
        from: 'a',
        to: 'b',
        type: 'note',
        subject: 's',
        body: 'b',
      });
      const updated = await mb.ack({
        messageId: msg.id,
        readerId: 'b',
        read: fix.input.read as boolean,
      });
      return { ok: true, completed: updated?.completed };
    }
    default:
      return { error: 'unknown category' };
  }
}

describe('mailbox contract matrix — core surface', () => {
  const all = allMatrixFixtures().filter(
    (f) => f.surfaces.includes(TARGET_SURFACE) && !f.unsupported?.includes(TARGET_SURFACE),
  );

  for (const fix of all) {
    it(fix.label, async () => {
      const result = await runFixture(fix);

      if (fix.category === 'send-invalid') {
        expect(result.error).toBeDefined();
        if (fix.expected.error instanceof RegExp) {
          expect(result.error).toMatch(fix.expected.error);
        }
      } else {
        expect(result.ok).toBe(true);
      }
    });
  }
});
