import type { Config } from '@wrongstack/core/types';

/**
 * The cross-origin endpoints the WebUI page itself is allowed to reach.
 *
 * The topbar's HQ and WrongProxy status chips are the only part of the app
 * that talks to something other than its own origin: `useIntegrationStatus`
 * polls `<hqUrl>/api/auth/status` and `<wrongProxyUrl>/api/health` straight
 * from the browser. `connect-src` listed only the WebSocket origins, so both
 * probes were blocked by CSP and the chips reported "error" against a healthy
 * HQ — with a console entry that reads like a WS failure and has sent more
 * than one debugging session down the wrong path.
 *
 * Both keys are operator-owned: `hq` and `tools.wrongProxy` are on the
 * in-project config denylist (`in-project-policy.ts`), so a repo-committed
 * config cannot widen this header to an attacker's host.
 */
export function integrationConnectSources(config: Config | undefined): string[] {
  if (!config) return [];
  const out: string[] = [];
  const hqUrl = (config as { hq?: { url?: unknown } }).hq?.url;
  if (typeof hqUrl === 'string' && hqUrl.trim()) out.push(hqUrl);
  const proxyUrl = config.tools?.wrongProxy?.url;
  if (typeof proxyUrl === 'string' && proxyUrl.trim()) out.push(proxyUrl);
  return out;
}
