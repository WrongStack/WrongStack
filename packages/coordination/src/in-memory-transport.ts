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
      for (const [id, handlers] of [...this.subs.entries()]) {
        if (id === msg.from) continue;
        for (const h of [...handlers]) {
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
      for (const h of [...handlers]) {
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
    let handlers = this.subs.get(agentId);
    if (!handlers) {
      handlers = new Set();
      this.subs.set(agentId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0 && this.subs.get(agentId) === handlers) {
        this.subs.delete(agentId);
      }
    };
  }

  close(agentId: string): Promise<void> {
    this.subs.delete(agentId);
    return Promise.resolve();
  }
}
