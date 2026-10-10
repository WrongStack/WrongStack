/**
 * Sealed agents: host-owned, single-purpose companions that cannot be pulled
 * outside the one job their host gives them.
 *
 * A resident companion (the Skill Companion's judge) sits idle in the fleet
 * between probes, which made it look like any other worker: an unpinned task
 * went to the first idle subagent, the leader could pin work to its id, the
 * supervisor could retarget a starved task onto it, peers could steer it with
 * session notes or mailbox, and the director auto-extended its budget. Each of
 * those is a way out of its task.
 *
 * `SubagentConfig.sealed` closes them at their single choke points:
 *   - coordinator — runs only host-internal tasks pinned to it; never picked
 *     for unpinned work, retargeted onto, or delegated to;
 *   - agent loop — no session-note inbox, mailbox, deliveries, btw notes,
 *     queue awareness or fleet pulse are folded into its context;
 *   - budget — soft limits are hard stops; no extension is ever negotiated.
 *
 * The flag only ever removes reach. Setting it on a config cannot grant
 * anything, so a forged prefix or a copied config is harmless.
 */

/** `ctx.meta` key the subagent factory stamps on a sealed agent's context. */
export const SEALED_AGENT_META_KEY = 'sealedAgent';

export function isSealedAgent(
  ctx: { meta?: Record<string, unknown> | undefined } | null | undefined,
): boolean {
  return ctx?.meta?.[SEALED_AGENT_META_KEY] === true;
}

export function sealedSubagentRefusal(subagentId: string): string {
  return (
    `Subagent "${subagentId}" is a sealed host companion: it runs only the work its host ` +
    'assigns and cannot take other tasks, retargets or delegated messages.'
  );
}
