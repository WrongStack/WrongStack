import type { WebSocket } from 'ws';
import type { CollabRole, WSCollabState } from '../types.js';

/**
 * Session-scoped membership record for one collaboration participant.
 * Moved verbatim from collaboration-ws-handler.ts (6A-1); the shape is
 * wire-visible via `collab.state` payloads, so field names are frozen.
 */
export interface Participant {
  participantId: string;
  ws: WebSocket;
  sessionId: string;
  role: CollabRole;
  joinedAt: string;
}

/** One removal produced by `removeBySocket`, with leave-choreography facts. */
interface SocketRemoval {
  sessionId: string;
  participant: Participant;
  /** True when this removal emptied the session bucket (no broadcast due). */
  sessionEmptied: boolean;
}

/**
 * CollabSessionRegistry — the in-memory membership/state store for the
 * collaboration transport. Pure state: no sockets are written to, no
 * timers run, no messages are sent from here. Send/broadcast orchestration
 * stays in the handler + feature modules so ordering semantics
 * (left-event → remove → broadcast) remain in one visible place.
 *
 * Extracted behavior-preserving from CollaborationWebSocketHandler (6A-1):
 * the maps, lookups, and state projections below are line-for-line the
 * originals; only the surrounding class changed.
 */
export class CollabSessionRegistry {
  /** Sockets attached to the collab endpoint (joined or not). */
  readonly clients = new Set<WebSocket>();
  /** sessionId → participants currently watching it. */
  private readonly bySession = new Map<string, Set<Participant>>();

  /** True while at least one collaboration participant is attached to a session. */
  hasParticipants(sessionId: string): boolean {
    return (this.bySession.get(sessionId)?.size ?? 0) > 0;
  }

  /** True while ANY session still has a participant (hot-path guard for the mirror). */
  hasAnyParticipants(): boolean {
    return this.bySession.size > 0;
  }

  /** Register a participant in its session bucket, creating the bucket on demand. */
  addParticipant(participant: Participant): void {
    let bucket = this.bySession.get(participant.sessionId);
    if (!bucket) {
      bucket = new Set();
      this.bySession.set(participant.sessionId, bucket);
    }
    bucket.add(participant);
  }

  /**
   * Remove every participant riding the given socket (a socket joins at
   * most one session today, but the loop stays future-proof like the
   * original handleDisconnect). Returns the removals in map order with
   * the owning sessionId so the caller can run the ordered leave
   * choreography (confirm → broadcast → state) exactly as before.
   */
  removeBySocket(ws: WebSocket): SocketRemoval[] {
    const removals: SocketRemoval[] = [];
    for (const [sessionId, bucket] of this.bySession) {
      for (const p of bucket) {
        if (p.ws === ws) {
          bucket.delete(p);
          const sessionEmptied = bucket.size === 0;
          if (sessionEmptied) this.bySession.delete(sessionId);
          removals.push({ sessionId, participant: p, sessionEmptied });
          break;
        }
      }
    }
    return removals;
  }

  /**
   * Look up the participant record for a given WS across all sessions.
   * Returns null when the WS hasn't joined (e.g. the client sent a
   * `collab.annotate` before `collab.join`).
   */
  findParticipant(ws: WebSocket): Participant | null {
    for (const bucket of this.bySession.values()) {
      for (const p of bucket) {
        if (p.ws === ws) return p;
      }
    }
    return null;
  }

  findParticipantById(sessionId: string, participantId: string): Participant | null {
    const bucket = this.bySession.get(sessionId);
    if (!bucket) return null;
    for (const p of bucket) {
      if (p.participantId === participantId) return p;
    }
    return null;
  }

  /** Session ids with at least one participant (snapshot for iteration). */
  sessionIds(): string[] {
    return [...this.bySession.keys()];
  }

  /** Live iterator over one session's participants (no copy). */
  participantIterator(sessionId: string): IterableIterator<Participant> | undefined {
    return this.bySession.get(sessionId)?.values();
  }

  stateMessage(sessionId: string): WSCollabState {
    const bucket = this.bySession.get(sessionId);
    return {
      type: 'collab.state',
      payload: {
        sessionId,
        participants: bucket
          ? [...bucket].map((p) => ({
              participantId: p.participantId,
              role: p.role,
              joinedAt: p.joinedAt,
            }))
          : [],
      },
    };
  }

  /**
   * Cheap participant-set identity: participant ids are unique per join and
   * `joinedAt` distinguishes a rejoin, so the fingerprint changes exactly on
   * join/leave — the only events that alter `collab.state`.
   */
  stateFingerprint(sessionId: string): string {
    const bucket = this.bySession.get(sessionId);
    if (!bucket || bucket.size === 0) return '';
    return [...bucket].map((p) => `${p.participantId}:${p.joinedAt}`).join('|');
  }

  /** Resolve the session a participant id currently lives in, if any. */
  sessionIdOfParticipant(participantId: string): string | null {
    for (const [sessionId, bucket] of this.bySession) {
      for (const p of bucket) {
        if (p.participantId === participantId) return sessionId;
      }
    }
    return null;
  }

  clear(): void {
    this.clients.clear();
    this.bySession.clear();
  }
}
