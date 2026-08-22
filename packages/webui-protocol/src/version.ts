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
  const version = legacyPeer
    ? SURFACE_PROTOCOL_VERSION
    : Math.min(peerVersion, SURFACE_PROTOCOL_VERSION);
  const compatible =
    legacyPeer || (Number.isInteger(peerVersion) && peerVersion >= SURFACE_PROTOCOL_MIN_VERSION);
  const advertised = new Set(peer.protocolCapabilities ?? []);
  return {
    compatible,
    legacyPeer,
    version,
    capabilities: SURFACE_PROTOCOL_CAPABILITIES.filter((item) => advertised.has(item)),
  };
}
