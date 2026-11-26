/**
 * Shared core of the `ClientTransport` double used by the client-side suites.
 *
 * `acp-session.test.ts` and `security-hardening.test.ts` each install a
 * `vi.mock` factory for `src/agent/stdio-transport.js`. Only the members below
 * were byte-identical between them; each suite keeps its own `respond`
 * (acp-session echoes `method` and also has `respondError`, security-hardening
 * omits both), so the diverging parts deliberately stay at the call site.
 *
 * A suite must load this with a DYNAMIC import from inside its `vi.mock`
 * factory, not a static top-level import: vitest hoists `vi.mock` above the
 * imports, so a statically-imported binding is not yet initialised when the
 * factory body runs.
 */
import { vi } from 'vitest';
import type { ACPMessage } from '../../src/types/acp-messages.js';

export class FakeClientTransport {
  sent: ACPMessage[] = [];
  handlers: Array<(m: ACPMessage) => void> = [];
  start = vi.fn(async () => {});
  stop = vi.fn<() => void>();
  send = vi.fn(async (m: ACPMessage) => {
    this.sent.push(m);
  });
  onMessage(h: (m: ACPMessage) => void): () => void {
    this.handlers.push(h);
    return () => {};
  }
  /**
   * Accepts raw JSON-RPC wire frames too: suites emit `{ jsonrpc: '2.0', id,
   * result }` responses that carry no `method`, which `ACPMessage` does not
   * model. The handlers receive the frame unchanged.
   */
  emit(m: Omit<ACPMessage, 'method'> & { method?: string; jsonrpc?: '2.0' }): void {
    for (const h of [...this.handlers]) h(m as ACPMessage);
  }
}
