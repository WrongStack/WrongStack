/** CLI boot adapter for canonical runtime tool registration and host policies. */

import {
  makeFleetStatusTool,
  makeMailboxTool,
  makeMailInboxTool,
  makeMailSendTool,
  makeSessionNoteTool,
} from '@wrongstack/core/coordination';
import { createContextManagerTool } from '@wrongstack/core/infrastructure';
import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type {
  AutoThinConfig,
  DisabledToolMeta,
  MemoryPort,
  TokenSavingTier,
  ToolDescriptionModeConfig,
  ToolResultRenderModeConfig,
} from '@wrongstack/core/types';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { configureChildEnvGitIdentity } from '@wrongstack/core/utils';
import { registerCanonicalHostTools } from '@wrongstack/runtime/tool-registration';
import { configureDangerBypass, configureExecPolicy } from '@wrongstack/tools';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';
import { configureGoalPolicy } from '../goal-host.js';

interface RegisterBuiltinToolsDeps {
  toolRegistry: ToolRegistry;
  compactor: unknown;
  config: {
    features: { memory: boolean; tokenSavingMode?: TokenSavingTier | boolean | undefined };
    tools?:
      | {
          descriptionMode?: ToolDescriptionModeConfig | undefined;
          resultRenderMode?: ToolResultRenderModeConfig | undefined;
          disabledTools?: string[] | undefined;
          disabledToolMeta?: Record<string, DisabledToolMeta> | undefined;
          autoThin?: AutoThinConfig | undefined;
          nextsteps?: { enabled?: boolean | undefined } | undefined;
          exec?:
            | {
                allow?: string[] | undefined;
                deny?: string[] | undefined;
                danger?: { bypass?: string[] | undefined } | undefined;
              }
            | undefined;
        }
      | undefined;
    git?:
      | { identity?: { name?: string | undefined; email?: string | undefined } | undefined }
      | undefined;
  };
  memoryStore: MemoryPort | null | undefined;
  /**
   * Optional vector memory store. When provided, the four
   * `vector_memory_*` tools are registered alongside the SAGE tools so
   * agents get both lexical and semantic retrieval paths in one surface.
   * Omit (or pass `undefined`) to keep the CLI on the SAGE-only surface.
   */
  vectorMemoryStore?: VectorMemoryStore | undefined;
  events: EventBus;
  wpaths: Pick<WstackPaths, 'projectDir'>;
}

/** Register the canonical tool surface, then apply CLI-only execution policies. */
export function registerBuiltinTools(deps: RegisterBuiltinToolsDeps): void {
  const tier = normalizeTokenSavingTier(deps.config.features.tokenSavingMode);
  registerCanonicalHostTools({
    registry: deps.toolRegistry,
    tier,
    contextTool: createContextManagerTool({ compactor: deps.compactor as never }),
    memory: { enabled: deps.config.features.memory, store: deps.memoryStore },
    vectorMemory: deps.vectorMemoryStore ? { store: deps.vectorMemoryStore } : undefined,
    nextSteps: { enabled: deps.config.tools?.nextsteps?.enabled === true },
    coordinationTools: [
      makeMailboxTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
      makeMailSendTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
      makeMailInboxTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
      makeFleetStatusTool({ projectDir: deps.wpaths.projectDir, events: deps.events }),
      makeSessionNoteTool(),
    ],
    descriptionMode: deps.config.tools?.descriptionMode,
    resultRenderMode: deps.config.tools?.resultRenderMode,
    disabledTools: deps.config.tools?.disabledTools,
    disabledToolMeta: deps.config.tools?.disabledToolMeta,
    autoThin: deps.config.tools?.autoThin,
    events: deps.events,
  });
  // Apply the configured exec command policy (DEFAULT ∪ allow − deny). `allow`
  // is trusted-config-only — the config loader strips `tools.exec.allow` from
  // any in-project repo config before this point.
  configureExecPolicy(deps.config.tools?.exec ?? {});
  configureDangerBypass(deps.config.tools?.exec?.danger ?? {});
  // Autonomous goal verification honors the same trusted exec.allow opt-ins
  // (added to goal's narrower base), so non-JS projects (go/cargo/…) can
  // run their verify command without confirmation when the user allowed it.
  configureGoalPolicy(deps.config.tools?.exec ?? {});
  // Commit identity for every git-touching child process. Trusted-config-only:
  // the loader strips `git` from repo-committed in-project configs.
  configureChildEnvGitIdentity(deps.config.git?.identity ?? null);
}
