/**
 * The plain REPL's prompt, mirrored to HQ.
 *
 * The REPL is the one surface whose approvals never reach the executor's
 * confirm path — the permission policy asks through its own delegate — so it
 * is mirrored by registering with the approval registry directly. The
 * behaviours worth pinning are the ones that go wrong quietly: the terminal
 * read must be cancelled when HQ answers (otherwise stdin stays in raw mode
 * eating keystrokes), and the mirrored card must expire on a heartbeat rather
 * than linger forever or vanish while the question is still on screen.
 */
import type { ApprovalRegistry, PendingApproval } from '@wrongstack/core/hq';
import type { Tool } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { makeMirroredPromptDelegate, REPL_MIRROR_TTL_MS } from '../src/permission-prompt-mirror.js';

const TOOL = {
  name: 'bash',
  description: 'run a command',
  inputSchema: { type: 'object' },
  permission: 'confirm',
  riskTier: 'destructive',
  mutating: true,
} as unknown as Tool;

/** Minimal registry that records what was registered and lets a test drive it. */
function fakeRegistry(): ApprovalRegistry & {
  entries: PendingApproval[];
  resolvedChanges: Array<string | undefined>;
  renewals: number[];
} {
  const entries: PendingApproval[] = [];
  const resolvedChanges: Array<string | undefined> = [];
  const renewals: number[] = [];
  const live = new Map<string, PendingApproval>();
  return {
    entries,
    resolvedChanges,
    renewals,
    list: () => [...live.values()],
    resolve: (toolUseId, decision) => {
      const entry = live.get(toolUseId);
      if (!entry) return false;
      live.delete(toolUseId);
      entry.resolve(decision);
      return true;
    },
    register: (approval) => {
      entries.push(approval);
      live.set(approval.toolUseId, approval);
      return (decision) => {
        if (!live.has(approval.toolUseId)) return;
        live.delete(approval.toolUseId);
        resolvedChanges.push(decision);
      };
    },
    renew: (toolUseId, deadlineAt) => {
      const entry = live.get(toolUseId);
      if (!entry) return false;
      entry.deadlineAt = deadlineAt;
      renewals.push(deadlineAt);
      return true;
    },
    dispose: () => undefined,
    onChange: () => () => undefined,
  };
}

describe('makeMirroredPromptDelegate', () => {
  it('returns the terminal answer and takes the card down with it', async () => {
    const registry = fakeRegistry();
    const inner = vi.fn().mockResolvedValue('always');
    const delegate = makeMirroredPromptDelegate({
      inner,
      getRegistry: () => registry,
      getSessionId: () => 'sess-1',
    });

    await expect(delegate(TOOL, { command: 'rm -rf dist' }, 'bash:rm')).resolves.toBe('always');
    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]).toMatchObject({
      toolName: 'bash',
      sessionId: 'sess-1',
      destructive: true,
      suggestedPattern: 'bash:rm',
    });
    // The card is retired with the decision that was actually made, so the
    // dashboard does not keep offering buttons for a settled prompt.
    expect(registry.resolvedChanges).toEqual(['always']);
  });

  it('aborts the terminal read when HQ answers first, and returns HQ decision', async () => {
    const registry = fakeRegistry();
    let seenSignal: AbortSignal | undefined;
    // Stands in for `readKey`: resolves with '' only once aborted, which is
    // exactly what the real reader does on abort.
    const inner = vi.fn(
      (_t: Tool, _i: unknown, _p: string, signal: AbortSignal) =>
        new Promise<'yes' | 'no' | 'always' | 'deny'>((resolve) => {
          seenSignal = signal;
          signal.addEventListener('abort', () => resolve('' as never), { once: true });
        }),
    );
    const delegate = makeMirroredPromptDelegate({ inner, getRegistry: () => registry });

    const pending = delegate(TOOL, { command: 'rm -rf dist' }, 'bash:rm');
    await vi.waitFor(() => expect(registry.entries).toHaveLength(1));

    expect(registry.resolve(registry.entries[0]!.toolUseId, 'yes')).toBe(true);

    // The empty string the aborted read returns must NOT be read as a refusal.
    await expect(pending).resolves.toBe('yes');
    expect(seenSignal?.aborted).toBe(true);
  });

  it('treats a cancelled read with no remote answer as a refusal', async () => {
    const registry = fakeRegistry();
    // Ctrl+C / closed stdin: the reader resolves '' with nobody having answered.
    const inner = vi.fn().mockResolvedValue('');
    const delegate = makeMirroredPromptDelegate({ inner, getRegistry: () => registry });

    await expect(delegate(TOOL, {}, 'bash:rm')).resolves.toBe('no');
    expect(registry.resolvedChanges).toEqual(['no']);
  });

  it('publishes a deadline and keeps renewing it while the question is on screen', async () => {
    vi.useFakeTimers();
    try {
      const registry = fakeRegistry();
      const now = vi.fn(() => 1_000_000);
      const inner = vi.fn(() => new Promise<'yes' | 'no' | 'always' | 'deny'>(() => undefined));
      const delegate = makeMirroredPromptDelegate({
        inner,
        getRegistry: () => registry,
        now,
      });

      void delegate(TOOL, {}, 'bash:rm');
      await vi.waitFor(() => expect(registry.entries).toHaveLength(1));
      // A terminal prompt has no timeout, but the CARD must still expire —
      // otherwise a host that dies mid-prompt parks a permanent card.
      expect(registry.entries[0]!.deadlineAt).toBe(1_000_000 + REPL_MIRROR_TTL_MS);

      await vi.advanceTimersByTimeAsync(REPL_MIRROR_TTL_MS);
      expect(registry.renewals.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to the plain terminal prompt when HQ is not connected', async () => {
    const inner = vi.fn().mockResolvedValue('yes');
    const delegate = makeMirroredPromptDelegate({ inner, getRegistry: () => undefined });
    await expect(delegate(TOOL, {}, 'bash:rm')).resolves.toBe('yes');
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
