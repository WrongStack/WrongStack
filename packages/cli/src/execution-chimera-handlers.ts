import { updateReviewReportEvidence } from '@wrongstack/builtin-plugins';
import { effectiveFallbackChain } from '@wrongstack/core/agent';
import { buildMutatingAgentLadder } from './chimera-reviewer-policy.js';
import { createChimeraWorkRegistry } from './chimera-work-registry.js';
import type { ExecuteDeps } from './execute-deps.js';
import { installChimeraCascadeHandler } from './execution-chimera-cascade.js';
import { installChimeraReviewHandler } from './execution-chimera-review.js';
import { installSpecialistTriggerHandler } from './execution-specialist-trigger.js';

export function installExecutionChimeraHandlers(deps: ExecuteDeps) {
  const {
    core: { events, agent, config, wpaths },
    session: { session, mailbox },
    fleet: { director },
    provider: { statusTracker },
  } = deps;

  const chimeraWork = createChimeraWorkRegistry();

  // Session-scoped disposers for the chimera wildcard listeners — the
  // installers push their `onPattern` disposers here and execution.ts drains
  // them in its finally block at session end (EventBus wildcard-leak board card).
  const chimeraTeardowns: Array<() => void> = [];

  installChimeraReviewHandler({
    events,
    director,
    session,
    mailbox,
    agent,
    config,
    projectDir: wpaths.projectDir,
    teardownHandlers: chimeraTeardowns,
    // Thread the shared tracker so the round-robin Chimera reviewer picks
    // skip (provider, model) pairs currently in the waiting room. Without
    // this, a 429-stricken model is re-spawned on every concurrent reviewer
    // turn and burns the whole chain instead of staying quarantined.
    statusTracker,
    trackWork: (work) => {
      chimeraWork.track(work);
    },
  });

  installSpecialistTriggerHandler({
    events,
    director,
    session,
    teardownHandlers: chimeraTeardowns,
    trackWork: (work) => {
      chimeraWork.track(work);
    },
  });

  installChimeraCascadeHandler({
    events,
    director,
    session,
    projectDir: wpaths.projectDir,
    teardownHandlers: chimeraTeardowns,
    buildLadder: () =>
      buildMutatingAgentLadder({
        profileChain: effectiveFallbackChain(config),
        session: { provider: config.provider, model: config.model },
      }),
    getPendingWork: () => chimeraWork.pending(),
    persistEvidence: async (reportId, status, checks) => {
      await updateReviewReportEvidence(reportId, wpaths.projectDir, status, checks);
    },
    trackWork: (work) => {
      chimeraWork.track(work);
    },
  });
  return { chimeraWork, chimeraTeardowns };
}
