export const SURFACE_PROTOCOL_VERSION = 1 as const;
export const SURFACE_PROTOCOL_MIN_VERSION = 1 as const;

export const SURFACE_PROTOCOL_CAPABILITIES = [
  'protocol.directional-decoder',
  'protocol.recursive-key-safety',
  'chronicle.query',
  'chronicle.facet',
  'chronicle.facets',
  'chronicle.graph',
  'chronicle.metrics',
  'chronicle.status',
  'connections.health',
  /** Bounded topic-shift advice plus same-session provider-context boundaries. */
  'context.topic-boundary',
  /** Interview resume/discard + lastAgentText/lastRunId continuity. */
  'sdd.interview.continuity',
  /** Launch multi-agent runs from a graph id or resolved spec id. */
  'sdd.run.from_graph',
  /** Host-owned prompt queue per session: queue.add/remove/clear/get, queue.state/drained. */
  'session.prompt-queue',
  /** `queue.add` with `front: true` places the prompt ahead of the queued ones (steer). */
  'session.prompt-queue-front',
  /** Direct user submissions receive a correlated acknowledgement after claiming their turn. */
  'session.user-ack',
  /** `composer.warm`: the user is typing; open the provider connection ahead of the send. */
  'session.provider-warm',
  /**
   * Session frames carry a per-session `seq`; `session.subscribe` may send `cursors` +
   * `eventEpoch` and is answered with the missed frames and `session.frames_resumed`.
   */
  'session.frame-resume',
] as const;

export type SurfaceProtocolCapability = (typeof SURFACE_PROTOCOL_CAPABILITIES)[number];

export interface ProtocolAdvertisement {
  protocolVersion?: number | undefined;
  protocolCapabilities?: readonly string[] | undefined;
}

export interface ProtocolNegotiation {
  compatible: boolean;
  legacyPeer: boolean;
  version: number;
  capabilities: SurfaceProtocolCapability[];
}

export function protocolAdvertisement(): {
  protocolVersion: typeof SURFACE_PROTOCOL_VERSION;
  protocolCapabilities: SurfaceProtocolCapability[];
} {
  return {
    protocolVersion: SURFACE_PROTOCOL_VERSION,
    protocolCapabilities: [...SURFACE_PROTOCOL_CAPABILITIES],
  };
}

export function negotiateProtocol(peer: ProtocolAdvertisement): ProtocolNegotiation {
  const peerVersion = peer.protocolVersion;
  const legacyPeer = peerVersion === undefined;
  const compatible =
    legacyPeer ||
    (typeof peerVersion === 'number' &&
      Number.isInteger(peerVersion) &&
      peerVersion >= SURFACE_PROTOCOL_MIN_VERSION);
  if (!compatible) {
    return {
      compatible: false,
      legacyPeer: false,
      version: SURFACE_PROTOCOL_VERSION,
      capabilities: [],
    };
  }
  const version = legacyPeer
    ? SURFACE_PROTOCOL_VERSION
    : Math.min(peerVersion, SURFACE_PROTOCOL_VERSION);
  const advertised = new Set(peer.protocolCapabilities ?? []);
  return {
    compatible,
    legacyPeer,
    version,
    capabilities: SURFACE_PROTOCOL_CAPABILITIES.filter((item) => advertised.has(item)),
  };
}
