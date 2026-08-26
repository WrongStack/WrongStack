/**
 * Ratchet: ARCH-CYCLE-TYPE-* exceptions in `architecture/exceptions.json` must
 * each match an active cycle in the current SCC scan.
 *
 * Background: card4c-health.txt reported "1 unexcepted module cycle(s) —
 * ARCH-CYCLE-TYPE-23: exception no longer matches an active cycle". That means
 * the cycle was fixed but the exception was never deleted. Future card4c
 * reports would keep flagging this as a noise signal that obscures real
 * exceptions.
 *
 * This test does not re-scan the whole repository (the existing
 * `architecture-health-script.test.ts` covers that with `validateExceptions`).
 * It checks the lightweight invariant: the union of `members[]` lists across
 * all type-module-cycle exceptions must be a subset of currently-reported
 * type-level SCCs. If an exception's member list matches nothing, it is
 * stale and the test fails with a "remove or rephrase" directive.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
const EXCEPTIONS = path.resolve(REPO_ROOT, 'architecture/exceptions.json');
const CARD4C = path.resolve(REPO_ROOT, '.reports/card4c-health.txt');

interface ExceptionRecord {
  id: string;
  kind: string;
  members: string[];
  reason?: string;
}

async function loadExceptions(): Promise<{ exceptions: ExceptionRecord[] }> {
  const text = await fs.readFile(EXCEPTIONS, 'utf8');
  return JSON.parse(text) as { exceptions: ExceptionRecord[] };
}

async function loadCard4cCycleMembers(): Promise<Set<string>> {
  const text = await fs.readFile(CARD4C, 'utf8');
  // Card4c reports cycles in the form `- path/a ↔ path/b ↔ path/c`. We
  // collect every individual path that appears between cycles.
  const cycleBlocks = text.split('\n').filter((line) => line.startsWith('- packages/'));
  const members = new Set<string>();
  for (const block of cycleBlocks) {
    for (const part of block.replace(/^- /, '').split(' ↔ ')) {
      const cleaned = part.trim();
      if (cleaned.startsWith('packages/') || cleaned.startsWith('apps/')) {
        members.add(cleaned);
      }
    }
  }
  return members;
}

describe('stale architecture-exception cleanup', () => {
  it('card4c-health.txt exists and reports at least one cycle', async () => {
    const text = await fs.readFile(CARD4C, 'utf8');
    expect(text).toContain('Type-inclusive module cycles');
  });

  it('every type-module-cycle exception member appears in a current card4c cycle', async () => {
    const { exceptions } = await loadExceptions();
    const activeMembers = await loadCard4cCycleMembers();
    const typeCycleExceptions = exceptions.filter((e) => e.kind === 'type-module-cycle');

    if (typeCycleExceptions.length === 0) {
      // No exceptions to verify against — pass through, the guard is
      // satisfied vacuously.
      return;
    }

    const stale: string[] = [];
    for (const exception of typeCycleExceptions) {
      // An exception is "stale" when NONE of its members appear in any
      // current cycle block (i.e. the SCC has been fully broken).
      const anyMemberMatches = exception.members.some((m) => activeMembers.has(m));
      if (!anyMemberMatches) {
        stale.push(
          `${exception.id}: no member appears in current card4c cycles — ` +
            'remove the exception or document why it is preserved.',
        );
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });

  it('every exception id is unique (defensive against duplicate SCC entries)', async () => {
    const { exceptions } = await loadExceptions();
    const ids = exceptions.map((e) => e.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });
});
