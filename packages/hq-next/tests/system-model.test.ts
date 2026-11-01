import type { HqEventEnvelope } from '@wrongstack/hq';
import { describe, expect, it } from 'vitest';
import { protectionSummary } from '../src/features/security/model';
import { laneSentence, projectTimelines } from '../src/features/worktrees/model';

let seq = 0;
const wt = (projectId: string, at: number, payload: Record<string, unknown>): HqEventEnvelope => {
  seq += 1;
  return {
    id: `w${seq}`,
    type: 'worktree.event',
    schemaVersion: 1,
    timestamp: new Date(at).toISOString(),
    clientId: 'c1',
    projectId,
    payload,
  } as HqEventEnvelope;
};

describe('worktree timelines', () => {
  const T = Date.UTC(2026, 9, 31, 10);
  const events = [
    wt('alpha', T, {
      kind: 'allocated',
      handleId: 'h1',
      branch: 'wt/a-1',
      baseBranch: 'main',
      ownerLabel: 'phase 1',
    }),
    wt('alpha', T + 60_000, { kind: 'conflict', handleId: 'h1', conflictFiles: ['src/a.ts'] }),
    wt('beta', T, { kind: 'allocated', handleId: 'h1', branch: 'wt/b-1', baseBranch: 'develop' }),
    wt('beta', T + 120_000, { kind: 'merged', handleId: 'h1', branch: 'wt/b-1' }),
    wt('beta', T + 1, { kind: 'not-a-kind', handleId: 'x' }),
  ];

  it('keeps projects apart even when handle ids collide', () => {
    const timelines = projectTimelines(events, T + 300_000);
    expect(
      timelines.map((entry) => [
        entry.projectId,
        entry.timeline.baseBranch,
        entry.timeline.lanes.length,
      ]),
    ).toEqual([
      ['alpha', 'main', 1],
      ['beta', 'develop', 1],
    ]);
  });

  it('puts the project that needs a person first and explains the lane', () => {
    const [first] = projectTimelines(events, T + 300_000);
    expect(first?.attention).toHaveLength(1);
    expect(laneSentence(first?.attention[0] as never)).toBe('Conflicts in src/a.ts.');
  });
});

describe('protection summary', () => {
  it('calls an open HQ exposed', () => {
    expect(protectionSummary({ tokenMode: false, passwordMode: false }).level).toBe('exposed');
  });

  it('calls a public tunnel without a password exposed, even with tokens', () => {
    expect(
      protectionSummary({ tokenMode: true, passwordMode: false, publicRelay: true }).level,
    ).toBe('exposed');
  });

  it('asks for two-factor on a public password-only HQ', () => {
    const summary = protectionSummary({ tokenMode: true, passwordMode: true, publicRelay: true });
    expect(summary.level).toBe('weak');
    expect(summary.advice).toMatch(/two-factor/);
  });

  it('flags insecure cookies on a public HQ before anything else weak', () => {
    expect(
      protectionSummary({
        tokenMode: false,
        passwordMode: true,
        totpEnabled: true,
        publicRelay: true,
        secureCookies: false,
      }).headline,
    ).toMatch(/not marked secure/);
  });

  it('accepts tokens alone on a private network, and password + 2FA in public', () => {
    expect(protectionSummary({ tokenMode: true, passwordMode: false }).level).toBe('strong');
    expect(
      protectionSummary({
        tokenMode: false,
        passwordMode: true,
        totpEnabled: true,
        publicRelay: true,
      }).level,
    ).toBe('strong');
  });
});
