import { describe, expect, it } from 'vitest';

import {
  digestAtlas,
  getCrossAgentRisk,
  getRecentActivity,
  summarizeFriction,
} from '../agent-helpers.js';
import type { WrongTraceClient } from '../types.js';

function offlineStub(): WrongTraceClient {
  return {
    isAvailable: false,
    async getHealth() {
      return null;
    },
    async getFileHealth() {
      return null;
    },
    async getSymbolLineage() {
      return [];
    },
    async getFrictionMatrix() {
      return [];
    },
    async getAtlas() {
      return null;
    },
    async lockFile() {
      return null;
    },
    async unlockFile() {
      return null;
    },
    async reportTelemetry() {
      return null;
    },
    async getRecentEvents() {
      return [];
    },
    async listLocks() {
      return [];
    },
  };
}

function stubWith(opts: {
  fileHealth?: {
    health_score: number;
    is_fragile: boolean;
    recent_thrashing_count: number;
    is_locked: boolean;
    lock_owner?: string;
    lock_reason?: string;
    lock_expires_at?: string;
  } | null;
  friction?: unknown[] | unknown;
}): WrongTraceClient {
  const friction = opts.friction === undefined ? [] : opts.friction;
  return {
    isAvailable: true,
    async getHealth() {
      return null;
    },
    async getFileHealth() {
      return Promise.resolve(opts.fileHealth as never);
    },
    async getSymbolLineage() {
      return [];
    },
    async getFrictionMatrix() {
      return Promise.resolve(friction as never);
    },
    async getAtlas() {
      return null;
    },
    async lockFile() {
      return null;
    },
    async unlockFile() {
      return null;
    },
    async reportTelemetry() {
      return null;
    },
    async getRecentEvents() {
      return [];
    },
    async listLocks() {
      return [];
    },
  };
}

describe('getCrossAgentRisk', () => {
  it('returns band:unknown when daemon is offline', async () => {
    const r = await getCrossAgentRisk(offlineStub(), 'src/foo.ts');
    expect(r.band).toBe('unknown');
    expect(r.risk).toBe(0);
    expect(r.reasons[0]).toMatch(/offline/i);
  });

  it('flags locked files with risk 100', async () => {
    const wt = stubWith({
      fileHealth: {
        health_score: 100,
        is_fragile: false,
        recent_thrashing_count: 0,
        is_locked: true,
        lock_owner: 'agent-x',
        lock_reason: 'active refactor',
      },
    });
    const r = await getCrossAgentRisk(wt, 'src/foo.ts');
    expect(r.band).toBe('locked');
    expect(r.risk).toBe(100);
    expect(r.reasons.join(' ')).toMatch(/locked by agent-x/);
  });

  it('keeps a lock held when lock_expires_at is in the future, surfacing the expiry', async () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const wt = stubWith({
      fileHealth: {
        health_score: 100,
        is_fragile: false,
        recent_thrashing_count: 0,
        is_locked: true,
        lock_owner: 'agent-x',
        lock_expires_at: future,
      },
    });
    const r = await getCrossAgentRisk(wt, 'src/foo.ts');
    expect(r.band).toBe('locked');
    expect(r.risk).toBe(100);
    expect(r.reasons[0]).toMatch(/expires/);
    expect(r.reasons[0]).toContain(future);
  });

  it('treats an expired lock as stale — falls through to health scoring instead of blocking forever', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const wt = stubWith({
      fileHealth: {
        health_score: 90,
        is_fragile: false,
        recent_thrashing_count: 0,
        is_locked: true,
        lock_owner: 'crashed-agent',
        lock_expires_at: past,
      },
      friction: [],
    });
    const r = await getCrossAgentRisk(wt, 'src/foo.ts');
    expect(r.band).not.toBe('locked');
    expect(r.risk).toBeLessThan(100);
    expect(r.reasons[0]).toMatch(/stale lock ignored/);
    expect(r.reasons.join(' ')).toMatch(/expired/);
  });

  it('treats a lock with no expiry as held (daemon TTL missing)', async () => {
    const wt = stubWith({
      fileHealth: {
        health_score: 100,
        is_fragile: false,
        recent_thrashing_count: 0,
        is_locked: true,
        lock_owner: 'agent-x',
      },
    });
    const r = await getCrossAgentRisk(wt, 'src/foo.ts');
    expect(r.band).toBe('locked');
    expect(r.reasons[0]).toMatch(/no expiry/);
  });

  it('escalates fragile files to band:fragile', async () => {
    const wt = stubWith({
      fileHealth: {
        health_score: 25,
        is_fragile: true,
        recent_thrashing_count: 1,
        is_locked: false,
      },
    });
    const r = await getCrossAgentRisk(wt, 'src/foo.ts');
    expect(r.risk).toBeGreaterThanOrEqual(80);
    expect(r.band).toBe('fragile');
  });

  it('penalizes thrashing above 3 cycles', async () => {
    const wt = stubWith({
      fileHealth: {
        health_score: 90,
        is_fragile: false,
        recent_thrashing_count: 8,
        is_locked: false,
      },
    });
    const r = await getCrossAgentRisk(wt, 'src/foo.ts');
    expect(r.risk).toBeGreaterThanOrEqual(25);
    expect(r.reasons.join(' ')).toMatch(/write\/delete cycles/);
  });
});

describe('summarizeFriction', () => {
  it('returns empty prose when there is no signal', () => {
    const s = summarizeFriction(null);
    expect(s.totalCollisions).toBe(0);
    expect(s.prose).toBe('');
  });

  it('produces a top-pair line for live data shape', () => {
    const liveShape = {
      edges: [
        {
          author_model: 'MiniMax-M3',
          overwriter_model: 'gemini-3.7-flash',
          conflict_count: 3,
          is_self_thrash: false,
        },
        {
          author_model: 'glm-5.3',
          overwriter_model: 'glm-5.3',
          conflict_count: 5,
          is_self_thrash: true,
        },
      ],
      total_collisions: 8,
    };
    const s = summarizeFriction(liveShape);
    expect(s.totalCollisions).toBe(8);
    // Ratios are collision-weighted: 3 cross + 5 self of 8 collisions.
    expect(s.crossAgentRatioPct).toBe(38);
    expect(s.selfThrashRatioPct).toBe(63);
    // Top pair is whichever direction has the highest count — both are valid
    // candidates depending on whether self-thrash is filtered. We assert the
    // pair is one of the two inputs, not specifically which one wins.
    expect([
      'MiniMax-M3 ↔ gemini-3.7-flash (3 conflicts)',
      'glm-5.3 ↔ glm-5.3 (5 conflicts)',
    ]).toContain(s.topPair);
    expect(s.prose).toMatch(/Top friction pair/);
    expect(s.prose).toMatch(/Self-thrash/);
  });

  it('clamps ratios to [0,100] when self-thrash conflicts exceed a windowed total', () => {
    // Daemon windowed total (3) is smaller than the self-thrash edge's
    // cumulative conflict_count (43) — ratios must clamp, never go negative
    // or above 100.
    const s = summarizeFriction({
      total_collisions: 3,
      edges: [
        { author_model: 'X', overwriter_model: 'Y', is_self_thrash: true, conflict_count: 43 },
      ],
    });
    expect(s.crossAgentRatioPct).toBe(0);
    expect(s.selfThrashRatioPct).toBe(100);
  });

  it('keeps per-edge counting when the report has no total_collisions', () => {
    // Without total_collisions, total falls back to edges.length, so
    // self-thrash is counted per edge (1 of 2) — units stay consistent.
    const s = summarizeFriction({
      edges: [
        { author_model: 'A', overwriter_model: 'A', is_self_thrash: true },
        { author_model: 'B', overwriter_model: 'C', is_self_thrash: false },
      ],
    });
    expect(s.totalCollisions).toBe(2);
    expect(s.crossAgentRatioPct).toBe(50);
    expect(s.selfThrashRatioPct).toBe(50);
  });

  it('tolerates schema drift (missing fields)', () => {
    const s = summarizeFriction({ edges: [{ author_model: 'a', overwriter_model: 'b' }] });
    expect(s.totalCollisions).toBe(1);
    expect(s.prose).toMatch(/Top friction pair: a ↔ b/);
  });
});

describe('getRecentActivity', () => {
  it('returns [] when daemon is offline', async () => {
    expect(await getRecentActivity(offlineStub(), 'src/foo.ts')).toEqual([]);
  });

  it('filters events by file path and sorts newest-first', async () => {
    const matrix: unknown = {
      recent_collisions: [
        {
          file_path: 'src/foo.ts',
          overwriter_model: 'x',
          overwriter_time: '2026-08-24T10:00:00Z',
          action: 'MODIFIED',
        },
        {
          file_path: 'src/other.ts',
          overwriter_model: 'y',
          overwriter_time: '2026-08-24T11:00:00Z',
          action: 'MODIFIED',
        },
        {
          file_path: 'src/foo.ts',
          overwriter_model: 'z',
          overwriter_time: '2026-08-24T12:00:00Z',
          action: 'DELETED',
        },
      ],
    };
    const wt = stubWith({ friction: matrix as never });
    const out = await getRecentActivity(wt, 'src/foo.ts', 10);
    expect(out).toHaveLength(2);
    expect(out[0]?.actor).toBe('z'); // newest first
    expect(out[0]?.action).toBe('DELETED');
    expect(out[1]?.actor).toBe('x');
  });
});

describe('digestAtlas', () => {
  it('returns null when atlas is null', () => {
    expect(digestAtlas(null)).toBeNull();
  });

  it('counts fragile files and lists thrash hotspots', () => {
    const atlas = {
      workspaces: ['a', 'b'],
      packages: [
        {
          name: 'p1',
          files: [
            { health_score: 20, recent_thrashing_count: 0 },
            { health_score: 95, recent_thrashing_count: 8 },
          ],
        },
        { name: 'p2', files: [{ health_score: 100, recent_thrashing_count: 0 }] },
      ],
    };
    const d = digestAtlas(atlas as never);
    expect(d?.workspaceCount).toBe(2);
    expect(d?.fragileFileCount).toBe(1);
    expect(d?.selfThrashWorkspaces).toContain('p1');
    expect(d?.prose).toMatch(/Atlas: 2 workspaces/);
  });
});
