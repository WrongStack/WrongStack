/**
 * Tests for the shared ACP helpers consumed by `wstack acp` and `/acp`:
 *   - resolveAcpAgentCommand — override > legacy map > catalog precedence
 *   - probeAcpAgent          — handshake test via ACPSession (mocked)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const startMock = vi.fn();
const closeMock = vi.fn(async () => {});
const getAgentInfoMock = vi.fn(() => ({ name: 'fake', version: '1.0.0' }));

// Mock the client session so probe never spawns a real process.
vi.mock('../src/client/acp-session.js', () => ({
  ACPSession: {
    start: (...a: unknown[]) => startMock(...a),
  },
  ACPSessionError: class extends Error {},
  textContent: (text: string) => ({ type: 'text', text }),
}));

import {
  AGENTS_CATALOG,
  probeAcpAgent,
  probeAcpAgents,
  resolveAcpAgentCommand,
} from '../src/index.js';

afterEach(() => {
  startMock.mockReset();
  closeMock.mockClear();
  getAgentInfoMock.mockClear();
});

describe('resolveAcpAgentCommand', () => {
  it('falls back to the catalog for a known id with no override', () => {
    const cmd = resolveAcpAgentCommand('opencode');
    expect(cmd).not.toBeNull();
    expect(cmd?.command).toBe('opencode');
    expect(cmd?.role).toBe('opencode');
  });

  it('returns null for an unknown id', () => {
    expect(resolveAcpAgentCommand('does-not-exist')).toBeNull();
  });

  it('user override wins over the catalog', () => {
    const cmd = resolveAcpAgentCommand('claude-code', {
      'claude-code': { command: 'my-claude', args: ['--acp'], env: { X: '1' } },
    });
    expect(cmd?.command).toBe('my-claude');
    expect(cmd?.args).toEqual(['--acp']);
    expect(cmd?.env).toEqual({ X: '1' });
    expect(cmd?.role).toBe('claude-code');
  });

  it('ignores an override with an empty command and uses the catalog', () => {
    const fromCatalog = AGENTS_CATALOG.find((a) => a.id === 'gemini-cli');
    const cmd = resolveAcpAgentCommand('gemini-cli', {
      'gemini-cli': { command: '' },
    });
    expect(cmd?.command).toBe(fromCatalog?.acp.command);
  });
});

describe('probeAcpAgent', () => {
  it('reports ok=true with agentInfo when the handshake succeeds', async () => {
    startMock.mockResolvedValueOnce({
      getAgentInfo: getAgentInfoMock,
      close: closeMock,
    });
    const res = await probeAcpAgent('opencode', { timeoutMs: 1000 });
    expect(res.ok).toBe(true);
    expect(res.id).toBe('opencode');
    expect(res.agentInfo?.name).toBe('fake');
    expect(closeMock).toHaveBeenCalled();
  });

  it('reports ok=false with the error when start rejects (no real spawn)', async () => {
    startMock.mockRejectedValueOnce(new Error('initialize timed out after 1000ms'));
    const res = await probeAcpAgent('gemini-cli', { timeoutMs: 1000 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('timed out');
  });

  it('reports ok=false for an unknown agent without spawning', async () => {
    const res = await probeAcpAgent('nope-not-real');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('unknown agent');
    expect(startMock).not.toHaveBeenCalled();
  });
});

describe('probeAcpAgents (bounded, phased)', () => {
  it('probes a set, preserves input order, and marks unknown ids', async () => {
    startMock.mockResolvedValue({ getAgentInfo: getAgentInfoMock, close: closeMock });
    const results = await probeAcpAgents({
      agentIds: ['opencode', 'nope', 'gemini-cli'],
      resolveCmd: (id) => (id === 'nope' ? null : { command: id, args: [], role: id }),
      timeoutMs: 1000,
    });
    expect(results.map((r) => r.id)).toEqual(['opencode', 'nope', 'gemini-cli']);
    expect(results.find((r) => r.id === 'nope')).toMatchObject({
      ok: false,
      error: 'unknown agent',
    });
    expect(results.find((r) => r.id === 'opencode')?.ok).toBe(true);
  });

  it('runs local agents before npx/uvx package agents (phasing)', async () => {
    const order: string[] = [];
    startMock.mockImplementation(async () => {
      // record the command at start time via the most recent call args
      return { getAgentInfo: getAgentInfoMock, close: closeMock };
    });
    await probeAcpAgents({
      agentIds: ['pkg', 'local'],
      resolveCmd: (id) =>
        id === 'pkg'
          ? { command: 'npx', args: ['-y', 'x'], role: 'pkg' }
          : { command: 'local-bin', args: ['acp'], role: 'local' },
      timeoutMs: 1000,
      packageTimeoutMs: 1000,
      onProgress: (id) => order.push(id),
    });
    // local completes before the npx package agent (locals run first).
    expect(order).toEqual(['local', 'pkg']);
  });
});
