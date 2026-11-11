import type { SessionTreeSnapshot } from '@wrongstack/contracts/types/session';
import { SessionBranchPill } from '@wrongstack/project-surfaces/session-tree';
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { invokePortableCommand } from '@/lib/portable-command-rpc';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';

function parseTreeSnapshot(raw: unknown): SessionTreeSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (
    typeof candidate['activeBranchId'] === 'string' &&
    candidate['branches'] &&
    typeof candidate['branches'] === 'object'
  ) {
    return candidate as unknown as SessionTreeSnapshot;
  }
  return null;
}

function quoteTreeArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface WebuiSessionBranchControlProps {
  sessionId: string | null;
}

export function WebuiSessionBranchControl({
  sessionId,
}: WebuiSessionBranchControlProps): React.ReactElement | null {
  const wsStatus = useConfigStore((s) => s.wsStatus);
  const [tree, setTree] = useState<SessionTreeSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const latestSessionRef = useRef<string | null>(sessionId);
  latestSessionRef.current = sessionId;

  const refreshTree = useCallback(async () => {
    if (!sessionId) {
      setTree(null);
      return;
    }
    if (wsStatus.state === 'open') {
      const rpc = await invokePortableCommand('tree', 'list --json', {
        sessionId,
        timeoutMs: 4_000,
      });
      if (!rpc.error && rpc.message) {
        try {
          const parsed = JSON.parse(rpc.message) as unknown;
          const snap = parseTreeSnapshot(parsed);
          if (snap && latestSessionRef.current === sessionId) {
            setTree(snap);
            return;
          }
        } catch {
          // Fall through to HTTP snapshot endpoint if non-JSON output returned.
        }
      }
    }

    if (typeof fetch === 'function') {
      try {
        const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/tree`, {
          credentials: 'same-origin',
        });
        if (resp.ok) {
          const body = (await resp.json()) as { tree?: unknown };
          const snap = parseTreeSnapshot(body?.tree);
          if (snap && latestSessionRef.current === sessionId) {
            setTree(snap);
          }
        }
      } catch {
        // Best-effort fallback when running against mock sockets or offline.
      }
    }
  }, [sessionId, wsStatus.state]);

  useEffect(() => {
    if (!sessionId) {
      setTree(null);
      return;
    }
    void refreshTree();
  }, [sessionId, refreshTree]);

  useEffect(() => {
    if (!sessionId) return;
    const client = getWSClient();
    const offStart = client.on('session.start', (msg) => {
      if (msg.payload.sessionId === sessionId) {
        void refreshTree();
      }
    });
    const offCmd = client.on('command.result', (msg) => {
      if (msg.payload.name === 'tree' && !msg.payload.message?.startsWith('{')) {
        void refreshTree();
      }
    });
    return () => {
      offStart();
      offCmd();
    };
  }, [sessionId, refreshTree]);

  if (!sessionId || !tree) return null;

  const runMutation = async (args: string) => {
    setBusy(true);
    try {
      await invokePortableCommand('tree', args, { sessionId });
      getWSClient().listSessions(50);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SessionBranchPill
      tree={tree}
      busy={busy}
      onRefresh={() => {
        void refreshTree();
      }}
      onCreateBranch={async (name) => {
        await runMutation(`branch ${quoteTreeArg(name)}`);
      }}
      onSwitchBranch={async (branchId, opts) => {
        await runMutation(
          `switch ${quoteTreeArg(branchId)}${opts?.keepFiles ? ' --keep-files' : ''}`,
        );
      }}
      onFoldBranch={async (sourceBranchId) => {
        await runMutation(`fold ${quoteTreeArg(sourceBranchId)}`);
      }}
    />
  );
}
