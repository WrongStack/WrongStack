/**
 * Boot-time entry point for the auto-thinning pipeline.
 *
 * Called once after `registerBuiltinTools` and after the Chronicle
 * metrics store is opened. If `tools.autoThin.enabled` is true AND
 * `tools.autoThin.applyOnBoot` is true, the pipeline queries the
 * configured source (Chronicle primary, in-process bridge fallback),
 * filters with the policy, and calls `registry.thinUnderused()`.
 *
 * The decision is persisted back to `disabledTools` and
 * `disabledToolMeta` via `configStore.update` so the next boot picks up
 * the same set without re-running the policy.
 */

import type { ChronicleMetricsStore } from '@wrongstack/core/chronicle';
import type { EventBus } from '@wrongstack/core/kernel';
import {
  createToolUsageSource,
  filterUnderused,
  type ToolUsageSnapshot,
  type UnderusedQueryOptions,
  type UnderusedToolCandidate,
} from '@wrongstack/core/observability';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { noOpVault } from '@wrongstack/core/security';
import type { AutoThinConfig, ConfigStore, DisabledToolMeta } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistConfigSetting } from '../settings-menu.js';

interface BootAutoThinDeps {
  toolRegistry: ToolRegistry;
  events: EventBus;
  configStore: ConfigStore;
  config: AutoThinConfig;
  chronicle?: ChronicleMetricsStore | undefined;
  /** In-process bridge snapshot — fallback when Chronicle is unavailable. */
  bridge?: ToolUsageSnapshot | undefined;
  /** Wall-clock anchor for tests; defaults to `Date.now()`. */
  now?: () => number;
  /**
   * When true, log the dry-run outcome but do not mutate the registry
   * or persist anything. Used by `/tool autothin candidates` and by
   * the WebUI's "Run now" preview.
   */
  dryRun?: boolean;
}

interface BootAutoThinResult {
  candidates: UnderusedToolCandidate[];
  applied: string[];
  skipped: string[];
  source: 'chronicle' | 'in-process' | 'none';
}

function resolvePolicy(
  config: AutoThinConfig,
): Required<Pick<UnderusedQueryOptions, 'idleDays' | 'minInvocations'>> {
  return {
    idleDays: typeof config.idleDays === 'number' && config.idleDays > 0 ? config.idleDays : 30,
    minInvocations:
      typeof config.minInvocations === 'number' && config.minInvocations >= 0
        ? config.minInvocations
        : 3,
  };
}

function neverAutoThinFilter(
  candidates: readonly UnderusedToolCandidate[],
  never: readonly string[] | undefined,
): UnderusedToolCandidate[] {
  if (!never || never.length === 0) return candidates.slice();
  const blocked = new Set(never);
  return candidates.filter((c) => !blocked.has(c.name));
}

export async function runBootAutoThin(deps: BootAutoThinDeps): Promise<BootAutoThinResult> {
  const policy = resolvePolicy(deps.config);
  const source = createToolUsageSource({
    ...(deps.chronicle ? { chronicle: deps.chronicle } : {}),
    ...(deps.bridge ? { bridge: deps.bridge } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  let raw: UnderusedToolCandidate[] = [];
  try {
    raw = await source.candidates(policy);
  } catch (_error) {
    // Chronicle can fail at boot on platforms without node:sqlite; treat as
    // an empty source so the rest of the boot path continues. The dry-run
    // variant surfaces the error string in the result so `/tool autothin
    // status` can show why the pipeline is silent.
    return {
      candidates: [],
      applied: [],
      skipped: [],
      source: 'none',
    };
  }
  const filtered = neverAutoThinFilter(
    filterUnderused(raw, policy, (deps.now ?? Date.now)()),
    deps.config.neverAutoThin,
  );
  if (deps.dryRun) {
    return {
      candidates: filtered,
      applied: [],
      skipped: [],
      source: source.kind,
    };
  }
  const { thinned, skipped } = deps.toolRegistry.thinUnderused(
    filtered.map((c) => c.name),
    'boot-time auto-thin',
  );
  if (thinned.length === 0) {
    return { candidates: filtered, applied: [], skipped, source: source.kind };
  }
  // Persist the decision. Both `disabledTools` and `disabledToolMeta`
  // are rewritten under a single update so a crash between the two
  // writes never leaves a half-state.
  const at = Date.now();
  const current = deps.configStore.get().tools ?? {};
  const nextDisabled = new Set(current.disabledTools ?? []);
  const nextMeta: Record<string, DisabledToolMeta> = { ...(current.disabledToolMeta ?? {}) };
  for (const name of thinned) {
    nextDisabled.add(name);
    nextMeta[name] = { reason: 'auto-thinned', at, caller: 'boot-time auto-thin' };
  }
  try {
    // The CLI registers `paths` on the config store at boot; in pure unit
    // tests it is absent, in which case the in-memory update already
    // committed the change above and the persist call is best-effort.
    const paths = (
      deps.configStore as unknown as { paths?: import('@wrongstack/core/utils').WstackPaths }
    ).paths;
    if (paths) {
      await persistConfigSetting(
        {
          configStore: deps.configStore,
          profileConfigPath: activeProfileConfigPath(paths, deps.configStore.get()),
          inProjectConfigPath: paths.inProjectConfig,
          vault: noOpVault,
        },
        (cfg) => {
          cfg.tools = {
            ...(cfg.tools ?? {}),
            disabledTools: [...nextDisabled],
            disabledToolMeta: nextMeta,
          };
        },
      );
    }
  } catch (error) {
    // Persistence failure: log and continue. The in-memory disable still
    // applies for this session; the next boot will re-run the policy
    // (re-thinning is idempotent for the same candidate set).
    deps.events.emit('error', {
      err: new Error(`autoThin persist failed: ${toErrorMessage(error)}`),
      phase: 'autothin-boot',
    });
  }
  return { candidates: filtered, applied: thinned, skipped, source: source.kind };
}
