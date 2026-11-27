/**
 * Durable project-wide Kanban Companion policy.
 *
 * The companion is the agentic board manager (`board.management`): it claims a
 * lease, reviews cards, writes management-fenced card changes, renews and
 * finishes. This module is the project-wide switch for that loop.
 *
 * Durability and ownership:
 *   - The policy lives in project Kanban metadata under
 *     `KANBAN_COMPANION_METADATA_KEY` as `{ enabled, epoch }` — the same
 *     owner-serialized metadata store that keeps HQ sync state
 *     (`hq-sync-state-v1`). It survives daemon restarts and is shared by every
 *     host in the project.
 *   - `setKanbanCompanionEnabled` runs inside a critical section of the project
 *     owner (the single daemon that owns all board mutations serializes policy
 *     writes through one promise chain), so the flag+epoch read-modify-write is
 *     one authoritative transaction per caller.
 *
 * Fencing model (monotonic epoch, no sweep required for correctness):
 *   - Transitioning to disabled increments `epoch`. Claims stamp the current
 *     epoch onto the lease and the board's management state; every token path
 *     (`renewBoardManagement`, `finishBoardManagement`, and the management
 *     write fence in `management-fence.ts`) refuses a lease whose epoch is not
 *     the current one — even after a quick disable→re-enable, because
 *     enabling never touches the epoch.
 *   - Enabling is therefore purely a flag write and is idempotent: it cannot
 *     resurrect a stale token and cannot fence a freshly claimed manager.
 *   - Disabling additionally PROJECTS the fenced lease state (marks a running
 *     manager failed, promotes its uncommitted reviews into the committed set,
 *     stamps the new epoch, removes the lease). If that projection fails for a
 *     board it is announced with `WRONGSTACK_KANBAN_COMPANION_FENCE_FAILED`
 *     and correctness still holds: resume paths are refused by epoch, and the
 *     leftover lease cannot outlive its TTL.
 *
 * Unset metadata defaults to enabled. A corrupt stored record is treated as
 * disabled: a broken kill switch must not fail open.
 */
import { listBoardIds, mutateBoard, readKanbanMetadata, writeKanbanMetadata } from '../storage.js';
import type { KanbanManagementState } from '../types.js';

export const KANBAN_COMPANION_METADATA_KEY = 'kanban-companion-policy-v1';

interface KanbanCompanionPolicyRecord {
  enabled: boolean;
  epoch: number;
}

/** Read the durable companion policy record. Unset metadata defaults to enabled. */
export async function readKanbanCompanionPolicy(
  projectRoot: string,
): Promise<KanbanCompanionPolicyRecord> {
  const raw = await readKanbanMetadata(projectRoot, KANBAN_COMPANION_METADATA_KEY);
  if (raw === null) return { enabled: true, epoch: 0 };
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown; epoch?: unknown };
    if (
      typeof parsed?.enabled === 'boolean' &&
      typeof parsed?.epoch === 'number' &&
      Number.isSafeInteger(parsed.epoch) &&
      parsed.epoch >= 0
    ) {
      return { enabled: parsed.enabled, epoch: parsed.epoch };
    }
  } catch {
    // Corrupt JSON falls through to the fail-closed record below.
  }
  return { enabled: false, epoch: 0 };
}

/** Read the durable companion policy. Unset metadata defaults to enabled. */
export async function getKanbanCompanionEnabled(projectRoot: string): Promise<boolean> {
  return (await readKanbanCompanionPolicy(projectRoot)).enabled;
}

// The project owner is the single authoritative writer of kanban metadata
// (every public policy call routes through it), so one promise chain per
// project root is a complete critical section for the flag+epoch
// read-modify-write. Keyed per root — never globally — so concurrent tests or
// hosts spanning multiple projects neither serialize against each other nor
// observe each other's ordering.
const companionPolicyWrites = new Map<string, Promise<unknown>>();

function serializeWithOwner<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  const prior = companionPolicyWrites.get(projectRoot) ?? Promise.resolve();
  const settled = prior.then(operation, operation);
  const tail = settled.then(
    () => undefined,
    () => undefined,
  );
  companionPolicyWrites.set(projectRoot, tail);
  void tail.finally(() => {
    if (companionPolicyWrites.get(projectRoot) === tail) {
      companionPolicyWrites.delete(projectRoot);
    }
  });
  return settled;
}

/**
 * Persist the companion policy and, when disabling, fence every active
 * manager lease.
 *
 * Validates `enabled` strictly: the policy is a boolean switch, and a truthy
 * non-boolean (for example `'false'`, arriving from an untyped IPC caller)
 * must never disable or enable anything by accident.
 *
 * Enabling never increments the epoch and never touches boards, so calling it
 * repeatedly — or racing a disable — can never fence a freshly claimed
 * manager. Disabling increments the epoch exactly once per enabled→disabled
 * transition and projects the fence onto boards. Returns the effective state
 * as the owner sees it after the write.
 */
export async function setKanbanCompanionEnabled(
  projectRoot: string,
  enabled: boolean,
): Promise<boolean> {
  if (typeof enabled !== 'boolean') {
    throw new TypeError(
      `Kanban companion policy requires a boolean; received ${describeValue(enabled)}.`,
    );
  }
  return serializeWithOwner(projectRoot, async () => {
    const current = await readKanbanCompanionPolicy(projectRoot);
    const epoch = !enabled && current.enabled ? current.epoch + 1 : current.epoch;
    if (current.enabled !== enabled || epoch !== current.epoch) {
      await writeKanbanMetadata(
        projectRoot,
        KANBAN_COMPANION_METADATA_KEY,
        JSON.stringify({ enabled, epoch } satisfies KanbanCompanionPolicyRecord),
      );
    }
    if (!enabled) await projectFencedManagementLeases(projectRoot);
    return getKanbanCompanionEnabled(projectRoot);
  });
}

/**
 * Project a policy fence onto every board with a live management lease, under
 * each board's own mutation lock.
 *
 * Correctness does not depend on this pass: renew/finish refuse on the
 * metadata epoch and the write fence refuses epoch-mismatched leases. This is
 * the stale-lease-state projection — demote a `running` manager to `failed`
 * with the fence reason, promote its uncommitted reviews into the committed
 * review set so the run's work product survives (the next claim merges them
 * back by task version), stamp the new epoch, and remove the lease. Completed
 * coverage (`reviewedFingerprint`/`reviewCoverageVersion`) and prior reviews
 * are left untouched, so deterministic and manual board behavior is unchanged.
 */
async function projectFencedManagementLeases(projectRoot: string): Promise<void> {
  const failures: string[] = [];
  for (const boardId of await listBoardIds(projectRoot)) {
    try {
      await mutateBoard(projectRoot, boardId, (board) => {
        const state = board.management;
        const lease = state?.lease;
        if (!lease) return false;
        const next: KanbanManagementState = { ...state };
        if (lease.reviews) next.reviews = { ...state?.reviews, ...lease.reviews };
        next.lease = undefined;
        if (state?.status === 'running') {
          next.status = 'failed';
          next.error =
            'Kanban companion policy change fenced the active management lease; ' +
            'the worker must not resume.';
        }
        board.management = next;
        return true;
      });
    } catch (error) {
      failures.push(`${boardId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    process.emitWarning(
      `Kanban companion lease fence failed for ${failures.length} board(s): ` +
        failures.slice(0, 5).join('; '),
      { code: 'WRONGSTACK_KANBAN_COMPANION_FENCE_FAILED' },
    );
  }
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return `string "${value}"`;
  if (typeof value === 'bigint') return `bigint ${value}`;
  if (typeof value === 'object' && value !== null) return 'object';
  return String(value);
}
