/**
 * Host-only WrongMemory calls that sit outside SAGE retrieval: the HQ
 * projection sync (version, list, apply) and the audit log. Split out of
 * wrongmemory-sage-ops.ts; the SAGE operations extend this class.
 */
import { METHODS } from '@wrongstack/wrongmemory-client';
import type { SageAuditRecord } from './types.js';
import { SLOW_OP_TIMEOUT_MS } from './wrongmemory-errors.js';
import { WrongMemoryTransport } from './wrongmemory-transport.js';
import { compact, type WireHqSageRecord } from './wrongmemory-wire.js';

export abstract class WrongMemorySageSync extends WrongMemoryTransport {
  /** `memory.hqSyncVersion` (host-only): `<epoch>:<clock revision>` of the HQ projection. */
  async hqSyncVersion(): Promise<string> {
    const r = await this.scoped<{ version: string }>(
      METHODS.MEMORY_HQ_SYNC_VERSION,
      {},
      this.session(undefined),
    );
    return r.version;
  }

  /** `memory.hqSyncList` (host-only): one page of projection records after `after`. */
  async hqSyncList(after = ''): Promise<WireHqSageRecord[]> {
    const r = await this.scoped<{ records: WireHqSageRecord[] }>(
      METHODS.MEMORY_HQ_SYNC_LIST,
      { after },
      this.session(undefined),
    );
    return r.records;
  }

  /** `memory.hqSyncApply` (host-only): apply remote records; returns the changed ids. */
  async hqSyncApply(records: WireHqSageRecord[]): Promise<string[]> {
    const r = await this.scoped<{ changed: string[] }>(
      METHODS.MEMORY_HQ_SYNC_APPLY,
      { records },
      this.session(undefined),
      { timeoutMs: SLOW_OP_TIMEOUT_MS },
    );
    return r.changed;
  }

  /** `memory.audit` (host-only): the most recent audit events, newest first. */
  async readAudit(limit?: number): Promise<SageAuditRecord[]> {
    const result = await this.scoped<{ records: SageAuditRecord[] }>(
      METHODS.MEMORY_AUDIT,
      compact({ limit }),
      this.session(undefined),
    );
    return result.records;
  }
}
