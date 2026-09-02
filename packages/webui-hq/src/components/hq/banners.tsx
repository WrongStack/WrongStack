/**
 * Full-width notices that sit above every view.
 *
 * Two kinds, and the distinction matters to an operator:
 *  - the browser lost the HQ server (transport), which resolves itself
 *  - a PROJECT lost its leader (peer lifecycle), which may not
 */
import { PlugZap, TriangleAlert, X } from 'lucide-react';
import type * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { HqPeerEnvelope } from '../../data/store/index.js';
import { useHqStore } from '../../data/store/index.js';
import { relativeTime } from '../../domain/control-format.js';
import { Button } from '../ui/button.js';

function peerHeadline(envelope: HqPeerEnvelope): string {
  const { projectId, previousLeaderHandle, reason } = envelope.payload;
  return envelope.kind === 'peer.lost'
    ? `${projectId} lost its leader (${previousLeaderHandle}, ${reason}) and has no survivors.`
    : `${projectId} lost ${previousLeaderHandle} (${reason}); surviving agents are rehydrating.`;
}

export function PeerLifecycleBanner(): React.ReactElement | null {
  const { envelope, dismiss } = useHqStore(
    useShallow((state) => ({
      envelope: state.peerEnvelope,
      dismiss: state.dismissPeerEnvelope,
    })),
  );
  if (envelope === null) return null;

  const lost = envelope.kind === 'peer.lost';
  return (
    <div
      role="status"
      data-testid="peer-banner"
      data-kind={envelope.kind}
      className={
        lost
          ? 'flex items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-destructive'
          : 'flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs text-warning'
      }
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span className="text-foreground">{peerHeadline(envelope)}</span>
      {/* The local receive time answers "is this still current?" — the
          envelope can outlive the incident by a long reconnect. */}
      <span className="text-muted-foreground">{relativeTime(envelope.receivedAt)}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Dismiss peer notice"
        onClick={dismiss}
        className="ml-auto"
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

export function ConnectionBanner(): React.ReactElement | null {
  const connected = useHqStore((state) => state.connected);
  if (connected) return null;
  return (
    <div
      role="status"
      data-testid="connection-banner"
      className="flex items-center gap-2 border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs"
    >
      <PlugZap className="size-3.5 shrink-0 animate-pulse text-warning" />
      <span className="text-foreground">
        Disconnected from the HQ server — retrying with backoff.
      </span>
      <span className="text-muted-foreground">
        Telemetry below is the last state received, not live.
      </span>
    </div>
  );
}
