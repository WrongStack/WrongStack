import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acpRegistryCachePath,
  parseAcpRegistryCache,
  readCachedAcpRegistry,
} from '../src/registry/acp-registry-cache.js';

describe('ACP registry cache', () => {
  it('keeps valid agents, trims ids and commands, and carries env and quarantine', () => {
    const raw = `﻿${JSON.stringify({
      fetchedAt: '2026-11-26T00:00:00Z',
      agents: [
        {
          id: ' codex ',
          acp: { command: ' codex-acp ', args: ['--stdio'], env: { MODE: 'acp' } },
          registry: { quarantineReason: 'unsigned' },
        },
        { id: 'plain', acp: { command: 'plain-acp' } },
      ],
    })}`;
    const loaded = parseAcpRegistryCache(raw);
    expect(loaded?.fetchedAt).toBe('2026-11-26T00:00:00Z');
    expect(loaded?.byId.codex).toEqual({
      command: 'codex-acp',
      args: ['--stdio'],
      env: { MODE: 'acp' },
      quarantineReason: 'unsigned',
    });
    expect(loaded?.byId.plain).toEqual({ command: 'plain-acp', args: [] });
    expect(loaded?.agents.map((agent) => [agent.id, agent.acp.command])).toEqual([
      ['codex', 'codex-acp'],
      ['plain', 'plain-acp'],
    ]);
  });

  it('drops malformed, unsafe and duplicate entries', () => {
    const loaded = parseAcpRegistryCache(
      JSON.stringify({
        agents: [
          null,
          { id: '', acp: { command: 'x' } },
          { id: 'ctl\u0001', acp: { command: 'x' } },
          { id: 'no-command', acp: {} },
          { id: 'nul-command', acp: { command: 'a\0b' } },
          { id: 'bad-args', acp: { command: 'x', args: ['ok', 1] } },
          { id: 'nul-arg', acp: { command: 'x', args: ['a\0'] } },
          { id: 'env-array', acp: { command: 'x', env: [] } },
          { id: 'env-null', acp: { command: 'x', env: null } },
          { id: 'env-empty-key', acp: { command: 'x', env: { '': 'v' } } },
          { id: 'env-eq-key', acp: { command: 'x', env: { 'A=B': 'v' } } },
          { id: 'env-nul-key', acp: { command: 'x', env: { 'A\0': 'v' } } },
          { id: 'env-number', acp: { command: 'x', env: { A: 1 } } },
          { id: 'env-nul-value', acp: { command: 'x', env: { A: 'v\0' } } },
          { id: 'kept', acp: { command: 'first' } },
          { id: 'kept', acp: { command: 'second' } },
        ],
      }),
    );
    expect(loaded?.fetchedAt).toBe('');
    expect(Object.keys(loaded?.byId ?? {})).toEqual(['kept']);
    expect(loaded?.byId.kept?.command).toBe('first');
  });

  it('answers null for unreadable or non-registry input', () => {
    expect(parseAcpRegistryCache('{not json')).toBeNull();
    expect(parseAcpRegistryCache('null')).toBeNull();
    expect(parseAcpRegistryCache('"text"')).toBeNull();
    expect(parseAcpRegistryCache('{"agents":{}}')).toBeNull();
  });

  it('uses the ID as the label for a legacy cache entry without a display name', () => {
    const loaded = parseAcpRegistryCache(
      JSON.stringify({ agents: [{ id: 'legacy', acp: { command: 'legacy-acp' } }] }),
    );
    expect(loaded?.byId.legacy?.command).toBe('legacy-acp');
    expect(loaded?.agents[0]?.displayName).toBe('legacy');
  });

  it('reads the snapshot from the cache directory and tolerates a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acp-registry-cache-'));
    try {
      expect(acpRegistryCachePath(dir)).toBe(join(dir, 'acp-registry.json'));
      expect(readCachedAcpRegistry(dir)).toBeNull();
      writeFileSync(
        join(dir, 'acp-registry.json'),
        JSON.stringify({ fetchedAt: 'fixed', agents: [{ id: 'a', acp: { command: 'a-acp' } }] }),
      );
      expect(readCachedAcpRegistry(dir)?.byId.a?.command).toBe('a-acp');
      expect(acpRegistryCachePath()).toMatch(/acp-registry\.json$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
