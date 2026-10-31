import type { SubagentRunner } from '@wrongstack/contracts/types';
import { type BuildAcpSubagentRunnerOptions, buildAcpSubagentRunner } from './host-acp.js';
import { setBoundedLruEntry, touchLruKey } from './host-helpers.js';

export class HostAcpRunnerCache {
  private readonly runners = new Map<string, Promise<SubagentRunner>>();
  private readonly accessOrder: string[] = [];

  constructor(
    private readonly maxEntries = 20,
    private readonly resolveOpts?: () => BuildAcpSubagentRunnerOptions | undefined,
  ) {}

  get(subagentId: string): Promise<SubagentRunner> {
    const existingRunner = this.runners.get(subagentId);
    if (existingRunner) {
      touchLruKey(this.accessOrder, subagentId);
      return existingRunner;
    }

    // CLI /spawn and Director fan-out are trusted local agents - grant write/execute access.
    // The session default is read-only for untrusted agents (acp-session.ts:133);
    // buildAcpSubagentRunner passes defaultPermissionPolicy explicitly.
    const runner = buildAcpSubagentRunner(subagentId, this.resolveOpts?.());
    let cached: Promise<SubagentRunner>;
    cached = runner.catch((error: unknown) => {
      // A transient startup failure must not poison every later cache lookup.
      // A stale rejected promise must not evict a replacement for the same id.
      if (this.runners.get(subagentId) === cached) {
        this.runners.delete(subagentId);
        const index = this.accessOrder.indexOf(subagentId);
        if (index >= 0) this.accessOrder.splice(index, 1);
      }
      throw error;
    });
    setBoundedLruEntry(this.runners, this.accessOrder, subagentId, cached, this.maxEntries);
    return cached;
  }
}
