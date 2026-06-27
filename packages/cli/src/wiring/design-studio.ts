/**
 * Design Studio wiring (CLI host).
 *
 * Thin wrapper over the shared core installer so the CLI/TUI host and both
 * WebUI servers use one code path. The `design` tool ships in the builtin pack
 * and `/design` is registered with the slash registry; this only installs the
 * per-turn detection + kit-menu-injection middleware, which needs a live Context.
 */

import type { AgentPipelines, Context } from '@wrongstack/core';
import { installDesignStudioMiddleware } from '@wrongstack/core';

export interface InstallDesignStudioDeps {
  pipelines: AgentPipelines;
  context: Context;
  /** When false, no middleware is installed (the tool + /design stay manual). */
  enabled?: boolean | undefined;
}

export function installDesignStudio(deps: InstallDesignStudioDeps): void {
  installDesignStudioMiddleware({
    pipelines: deps.pipelines,
    ctx: deps.context,
    enabled: deps.enabled,
  });
}
