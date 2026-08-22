import type { WebSocket } from 'ws';
import type { CollabContext } from './collab-context.js';

/** A parsed inbound client message off the collaboration wire. */
export interface CollabInboundMessage {
  type: string;
  payload?: unknown | undefined;
}

/**
 * One collaboration protocol feature: owns a single message type and its
 * full handling. Async flows fire-and-forget inside `handle` (the original
 * dispatcher ignored the returned promise with `void`).
 */
export interface CollabFeature {
  readonly type: string;
  handle(ctx: CollabContext, ws: WebSocket, payload: unknown): void;
}

/**
 * CollabDispatcher (6A-3) — maps message types to features. Returns true
 * when the message was recognized and handled; false when the caller should
 * ignore / log, so the upstream router can dispatch non-collab messages.
 */
export class CollabDispatcher {
  private readonly byType = new Map<string, CollabFeature>();

  constructor(features: readonly CollabFeature[]) {
    for (const feature of features) this.byType.set(feature.type, feature);
  }

  dispatch(ctx: CollabContext, ws: WebSocket, msg: CollabInboundMessage): boolean {
    const feature = this.byType.get(msg.type);
    if (!feature) return false;
    void feature.handle(ctx, ws, msg.payload);
    return true;
  }
}
