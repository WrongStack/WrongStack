import type { SubagentRunner } from '@wrongstack/contracts/types';
import { type BuildAcpSubagentRunnerOptions, buildAcpSubagentRunner } from './host-acp.js';
import { setBoundedLruEntry, touchLruKey } from './host-helpers.js';

function optsFingerprint(
  subagentId: string,
  opts: BuildAcpSubagentRunnerOptions | undefined,
): string {
  if (!opts) return '';
  return JSON.stringify({
    projectRoot: opts.projectRoot ?? null,
    allowOutsideProjectRoot: opts.allowOutsideProjectRoot ?? false,
    override: opts.overrides?.[subagentId] ?? null,
    bridgeRoot: opts.bridge?.projectRoot ?? null,
    bridge: opts.bridge?.config ?? null,
  });
}

export class HostAcpRunnerCache {
  private readonly runners = new Map<string, Promise<SubagentRunner>>();
  private readonly accessOrder: string[] = [];

  constructor(
    private readonly maxEntries = 20,
    private readonly resolveOpts?: () => BuildAcpSubagentRunnerOptions | undefined,
  ) {}

  get(subagentId: string): Promise<SubagentRunner> {
    const opts = this.resolveOpts?.();
    const cacheKey = `${subagentId}\0${optsFingerprint(subagentId, opts)}`;
    const existingRunner = this.runners.get(cacheKey);
    if (existingRunner) {
      touchLruKey(this.accessOrder, cacheKey);
      return existingRunner;
    }

    // CLI /spawn and Director fan-out are trusted local agents - grant write/execute access.
    // The session default is read-only for untrusted agents (acp-session.ts:133);
    // buildAcpSubagentRunner passes defaultPermissionPolicy explicitly.
    const runner = Promise.resolve().then(() => buildAcpSubagentRunner(subagentId, opts));
    let cached: Promise<SubagentRunner>;
    cached = runner.catch((error: unknown) => {
      // A transient startup failure must not poison every later cache lookup.
      // A stale rejected promise must not evict a replacement for the same id.
      if (this.runners.get(cacheKey) === cached) {
        this.runners.delete(cacheKey);
        const index = this.accessOrder.indexOf(cacheKey);
        if (index >= 0) this.accessOrder.splice(index, 1);
      }
      throw error;
    });
    setBoundedLruEntry(this.runners, this.accessOrder, cacheKey, cached, this.maxEntries);
    return cached;
  }
}
