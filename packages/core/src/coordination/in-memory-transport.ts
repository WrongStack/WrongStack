import type { BridgeMessage, BridgeTransport } from '@wrongstack/contracts/types/agent-bridge';

/**
 * In-memory pub/sub transport for agent-to-agent messaging.
 * Subscribers register by agentId and receive messages via callback.
 */
export class InMemoryBridgeTransport implements BridgeTransport {
  private readonly subs = new Map<string, Set<(msg: BridgeMessage) => void>>();

  send(msg: BridgeMessage, to: string): Promise<void> {
    // Broadcast: deliver to every subscriber except the sender.
    if (to === '*') {
      for (const [id, handlers] of this.subs) {
        if (id === msg.from) continue;
        for (const h of handlers) {
          try {
            void Promise.resolve(h(msg)).catch(() => {
              /* ignore subscriber rejection */
            });
          } catch {
            /* ignore */
          }
        }
      }
      return Promise.resolve();
    }
    const handlers = this.subs.get(to);
    if (handlers) {
      for (const h of handlers) {
        try {
          void Promise.resolve(h(msg)).catch(() => {
            /* ignore subscriber rejection */
          });
        } catch {
          /* ignore */
        }
      }
    }
    return Promise.resolve();
  }

  subscribe(agentId: string, handler: (msg: BridgeMessage) => void): () => void {
    if (!this.subs.has(agentId)) this.subs.set(agentId, new Set());
    this.subs.get(agentId)?.add(handler);
    return () => this.subs.get(agentId)?.delete(handler);
  }

  close(agentId: string): Promise<void> {
    this.subs.delete(agentId);
    return Promise.resolve();
  }
}
