import type { SubagentRunner } from '@wrongstack/core/types';
import { buildAcpSubagentRunner } from './host-acp.js';
import { setBoundedLruEntry, touchLruKey } from './host-helpers.js';

export class HostAcpRunnerCache {
  private readonly runners = new Map<string, Promise<SubagentRunner>>();
  private readonly accessOrder: string[] = [];

  constructor(private readonly maxEntries = 20) {}

  get(subagentId: string): Promise<SubagentRunner> {
    const cached = this.runners.get(subagentId);
    if (cached) {
      touchLruKey(this.accessOrder, subagentId);
      return cached;
    }

    // CLI /spawn and Director fan-out are trusted local agents - grant write/execute access.
    // The session default is read-only for untrusted agents (acp-session.ts:133);
    // buildAcpSubagentRunner passes defaultPermissionPolicy explicitly.
    const runner = buildAcpSubagentRunner(subagentId);
    setBoundedLruEntry(this.runners, this.accessOrder, subagentId, runner, this.maxEntries);
    return runner;
  }
}
