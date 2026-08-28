/**
 * Agent Roster WS Handlers — exposes project-agent-identity.ts functions
 * to the WebUI for monitoring and editing custom roster agents.
 *
 * Message types (client → server):
 *   agent-roster.list        → { roles, stats, catalog }
 *   agent-roster.stats       → { role stats }
 *   agent-roster.llm-improve { role, prompt } → LLM-suggested changes
 *   agent-roster.update-identity  { role, content } → saved path
 *   agent-roster.update-learned   { role, content } → saved path
 *   agent-roster.update-config    { role, config } → saved path
 *   agent-roster.create { name, role?, baseRole?, purpose, taskTypes } → cloned project role
 *   agent-roster.reset            { role } → removed paths
 *   agent-roster.capture          { role, output? } → captured count
 *   agent-roster.consolidate      { role } → consolidation instruction + metadata
 *   agent-roster.save-consolidated { role, content, trigger?, model? } → saved path + stats
 *   agent-roster.read-consolidated { role } → consolidated content + metadata
 *   agent-roster.clear-consolidated { role } → cleared
 */

import {
  applyProjectAgentConfig,
  captureLearnedFromAgentOutputDetailed,
  clearProjectAgentConsolidated,
  clearProjectSkillAugmentation,
  createProjectAgent,
  DEFAULT_EAGER_SKILL_LIMIT,
  detectLearnedConflicts,
  evaluateAutoOptimize,
  FLEET_ROSTER,
  getProjectAgentLearnStats,
  isConsolidated,
  listProjectAgentLearnedEntries,
  listProjectAgentRoles,
  listProjectSkillAugmentations,
  loadConsolidationMetadata,
  loadProjectAgentConfig,
  loadProjectAgentConsolidated,
  loadProjectAgentIdentity,
  loadProjectAgentLearned,
  loadProjectAgentProfile,
  loadProjectSkillAugmentation,
  loadSkillAffinity,
  optimizeProjectAgentLearning,
  rankRoleSkills,
  readQuarantinedDirectives,
  readRawLearnedEntries,
  resetProjectAgentIdentity,
  resolveAutoOptimizePolicy,
  resolveRoleSkillCandidates,
  saveProjectAgentConsolidated,
  saveProjectSkillAugmentation,
  scoreSkillAffinity,
  setSkillPinned,
  slugifyProjectAgentRole,
  updateProjectAgentConfig,
  updateProjectAgentIdentity,
  updateProjectAgentLearned,
  updateProjectAgentLearningPolicy,
} from '@wrongstack/core/coordination';
import type { Provider } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';

/**
 * Resolved LLM handle used for headless (chat-free) consolidation. Both the
 * embedded and standalone routers can supply this from the active agent
 * context (`agent.ctx.provider` / `agent.ctx.model`).
 */
interface AgentRosterLlm {
  provider: Provider;
  model: string;
}

interface AgentRosterHandlerOptions {
  projectRoot: string | (() => string);
  /**
   * Resolves the LLM used to synthesize consolidations directly on the server,
   * without routing the instruction back through the chat loop. When it
   * returns undefined (no active model), the handler degrades gracefully to
   * returning the instruction for a caller-driven consolidation.
   */
  getLlm?: () => AgentRosterLlm | undefined;
  /**
   * Broadcasts a message to every connected client. Used to push
   * `agent-roster.updated` after a headless consolidation so other open
   * clients refresh the affected roster card without a manual reload.
   */
  broadcast?: (msg: WSServerMessage) => void;
  /**
   * Live read of `fleet.learning.autoOptimize`. Optional: without it the
   * status endpoint reports the built-in defaults, which is still the right
   * answer for a host that never overrode them.
   */
  getAutoOptimizeSettings?: (() => Record<string, unknown> | undefined) | undefined;
}

export class AgentRosterWSHandler {
  private readonly getProjectRoot: () => string;
  private readonly getLlm: () => AgentRosterLlm | undefined;
  private readonly broadcast: (msg: WSServerMessage) => void;
  private readonly getAutoOptimizeSettings: (() => Record<string, unknown> | undefined) | undefined;

  constructor(opts: AgentRosterHandlerOptions) {
    this.getProjectRoot =
      typeof opts.projectRoot === 'function' ? opts.projectRoot : () => opts.projectRoot as string;
    this.getLlm = opts.getLlm ?? (() => undefined);
    this.broadcast = opts.broadcast ?? (() => {});
    this.getAutoOptimizeSettings = opts.getAutoOptimizeSettings;
  }

  /** Handle an incoming client message. Returns a response payload. */
  async handleMessage(_ws: WebSocket, type: string, payload: unknown): Promise<WSServerMessage> {
    const p = (payload ?? {}) as Record<string, unknown>;
    const role = typeof p.role === 'string' ? p.role : '';
    const projectRoot = this.getProjectRoot();

    switch (type) {
      // ── List all customized roles ──────────────────────────────────────
      case 'agent-roster.list': {
        const roles = [
          ...new Set([...Object.keys(FLEET_ROSTER), ...listProjectAgentRoles(projectRoot)]),
        ].sort((a, b) => a.localeCompare(b));
        const stats = roles.map((r) => getProjectAgentLearnStats(r, projectRoot));
        const catalog = roles.map((catalogRole) => {
          const profile = loadProjectAgentProfile(catalogRole, projectRoot);
          const baseConfig =
            FLEET_ROSTER[catalogRole] ??
            (profile ? FLEET_ROSTER[profile.baseRole] : FLEET_ROSTER['generic']);
          const projectConfig = loadProjectAgentConfig(catalogRole, projectRoot);
          const config = baseConfig
            ? applyProjectAgentConfig(baseConfig, projectConfig, {
                protectSystemRole: !profile && Boolean(FLEET_ROSTER[catalogRole]),
              })
            : undefined;
          return {
            role: catalogRole,
            name: profile?.name ?? config?.name ?? catalogRole,
            summary:
              profile?.purpose ??
              config?.prompt
                ?.split('\n')
                .find((line) => line.trim().length > 20)
                ?.trim() ??
              '',
            tools: projectConfig?.tools?.length ?? config?.tools?.length ?? 0,
            custom: Boolean(profile),
            systemProtected: !profile && Boolean(FLEET_ROSTER[catalogRole]),
            baseRole: profile?.baseRole,
            taskTypes: profile?.taskTypes ?? [],
            budget: {
              timeoutMs: projectConfig?.budget?.timeoutMs ?? config?.timeoutMs,
              maxIterations: projectConfig?.budget?.maxIterations ?? config?.maxIterations,
              maxToolCalls: projectConfig?.budget?.maxToolCalls ?? config?.maxToolCalls,
            },
          };
        });
        return { type: 'agent-roster.list', payload: { roles, stats, catalog } };
      }

      // ── Stats for one role ─────────────────────────────────────────────
      case 'agent-roster.stats': {
        if (!role) return { type, payload: { error: 'role required' } };
        const stats = getProjectAgentLearnStats(role, projectRoot);
        return { type, payload: stats };
      }

      // ── LLM-driven improvement ─────────────────────────────────────────
      case 'agent-roster.llm-improve': {
        const prompt = typeof p.prompt === 'string' ? p.prompt : '';
        if (!role || !prompt) {
          return { type, payload: { error: 'role and prompt required' } };
        }
        // Read current files
        const currentStats = getProjectAgentLearnStats(role, projectRoot);

        // The CLI/agent will process this via `/agent-improve` flow.
        // Return a structured suggestion request that the frontend submits
        // to the leader agent.
        return {
          type: 'agent-roster.llm-improve',
          payload: {
            role,
            prompt,
            currentStats,
            instruction:
              `Inspect and improve the "${role}" roster agent for this project. Apply safe, focused changes directly to its project-level agent files and verify them.\n\n` +
              `Current state:\n` +
              `  identity length: ${currentStats.hasIdentity ? 'present' : 'none'}\n` +
              `  learned entries: ${currentStats.entryCount}\n` +
              `  total bytes: ${currentStats.totalBytes}\n\n` +
              `User request: ${prompt}\n\n` +
              `Preserve useful existing knowledge, do not reset unrelated agent data, and finish with a concise summary of files changed and verification performed.`,
          },
        };
      }

      // ── Update identity.md ─────────────────────────────────────────────
      case 'agent-roster.update-identity': {
        if (!role || typeof p.content !== 'string') {
          return { type, payload: { error: 'role and content required' } };
        }
        const fp = updateProjectAgentIdentity(role, p.content, projectRoot);
        return { type, payload: { role, path: fp, success: true } };
      }

      // ── Read learned.md raw content ─────────────────────────────────
      case 'agent-roster.read-learned': {
        if (!role) return { type, payload: { error: 'role required' } };
        const content = loadProjectAgentLearned(role, projectRoot) ?? '';
        const entries = listProjectAgentLearnedEntries(role, projectRoot);
        return { type, payload: { role, content, entries, entryCount: entries.length } };
      }

      case 'agent-roster.read-customization': {
        if (!role) return { type, payload: { error: 'role required' } };
        const profile = loadProjectAgentProfile(role, projectRoot);
        return {
          type,
          payload: {
            role,
            identity: loadProjectAgentIdentity(role, projectRoot),
            learned: loadProjectAgentLearned(role, projectRoot),
            config: loadProjectAgentConfig(role, projectRoot) ?? {},
            profile,
            systemProtected: !profile && Boolean(FLEET_ROSTER[role]),
          },
        };
      }

      case 'agent-roster.create':
      case 'agent-roster.create-generic': {
        const name = typeof p.name === 'string' ? p.name : '';
        const requestedRole = typeof p.role === 'string' ? p.role : '';
        const baseRole =
          typeof p.baseRole === 'string' && p.baseRole.trim()
            ? p.baseRole.trim().toLowerCase()
            : 'generic';
        const purpose = typeof p.purpose === 'string' ? p.purpose : '';
        const taskTypes = Array.isArray(p.taskTypes)
          ? p.taskTypes.filter((item): item is string => typeof item === 'string')
          : [];
        if (!name || !purpose || taskTypes.length === 0) {
          return { type, payload: { error: 'name, purpose and at least one task type required' } };
        }
        const newRole = (requestedRole.trim() || slugifyProjectAgentRole(name)).toLowerCase();
        if (FLEET_ROSTER[newRole]) {
          return { type, payload: { error: `built-in roster role "${newRole}" already exists` } };
        }
        const availableBaseRoles = new Set([
          ...Object.keys(FLEET_ROSTER),
          ...listProjectAgentRoles(projectRoot),
        ]);
        if (!availableBaseRoles.has(baseRole) || baseRole === newRole) {
          return { type, payload: { error: `unknown or circular base roster role "${baseRole}"` } };
        }
        const profile = createProjectAgent(
          { role: newRole, name, purpose, taskTypes, baseRole },
          projectRoot,
        );
        return {
          type,
          payload: {
            role: profile.role,
            profile,
            stats: getProjectAgentLearnStats(profile.role, projectRoot),
            success: true,
          },
        };
      }

      // ── Update learned.md ──────────────────────────────────────────────
      case 'agent-roster.update-learned': {
        if (!role || typeof p.content !== 'string') {
          return { type, payload: { error: 'role and content required' } };
        }
        const fp = updateProjectAgentLearned(role, p.content, projectRoot, 'replace');
        return { type, payload: { role, path: fp, success: true } };
      }

      // ── Append to learned.md (teach flow) ──────────────────────────────
      case 'agent-roster.append-learned': {
        const appendix = typeof p.content === 'string' ? p.content : '';
        if (!role || !appendix) {
          return { type, payload: { error: 'role and content required' } };
        }
        const fp = updateProjectAgentLearned(role, appendix, projectRoot, 'append');
        return { type, payload: { role, path: fp, success: true } };
      }

      // ── Update config.json ─────────────────────────────────────────────
      case 'agent-roster.update-config': {
        if (!role || typeof p.config !== 'object' || p.config === null || Array.isArray(p.config)) {
          return { type, payload: { error: 'role and config required' } };
        }
        const fp = updateProjectAgentConfig(
          role,
          p.config as Parameters<typeof updateProjectAgentConfig>[1],
          projectRoot,
        );
        return { type, payload: { role, path: fp, success: true } };
      }

      case 'agent-roster.update-learning': {
        if (!role || typeof p.enabled !== 'boolean') {
          return { type, payload: { error: 'role and boolean enabled required' } };
        }
        const policy = updateProjectAgentLearningPolicy(role, { enabled: p.enabled }, projectRoot);
        return {
          type,
          payload: {
            role,
            policy,
            stats: getProjectAgentLearnStats(role, projectRoot),
            success: true,
          },
        };
      }

      // ── Reset / refresh ────────────────────────────────────────────────
      case 'agent-roster.reset': {
        if (!role) return { type, payload: { error: 'role required; use "*" explicitly for all' } };
        // The underlying `resetProjectAgentIdentity` treats both `undefined` and
        // `'*'` as "reset every role". The CLI's `/agent-improve reset` slash
        // command normalises `'*'` to `undefined` before calling; the WS handler
        // does the same so both entry points agree on the wildcard contract.
        const removed = resetProjectAgentIdentity(role === '*' ? undefined : role, projectRoot);
        return { type, payload: { role, removed, success: removed.length > 0 } };
      }

      // ── Manually trigger capture ───────────────────────────────────────
      case 'agent-roster.capture': {
        const output = typeof p.output === 'string' ? p.output : '';
        if (!role) return { type, payload: { error: 'role required' } };
        // Coerce optional content to a string so the fallback never interpolates
        // the literal token "undefined" into a LEARNED block.
        const fallback = `## LEARNED\n${String(p.content ?? '')}`;
        const result = captureLearnedFromAgentOutputDetailed(
          output || fallback,
          role,
          projectRoot,
          true,
        );
        return { type, payload: result };
      }

      // ── Detect conflicts ───────────────────────────────────────────────
      case 'agent-roster.conflicts': {
        const conflicts = detectLearnedConflicts(projectRoot);
        return { type, payload: { conflicts } };
      }

      // ── Optimize: distil captures into skill addenda + a consolidated doc,
      // then archive and reset the raw buffer. Shared implementation with the
      // CLI (`optimizeProjectAgentLearning`) so both surfaces persist the same
      // artifacts instead of the CLI producing markdown nobody saved.
      case 'agent-roster.consolidate':
      case 'agent-roster.optimize': {
        if (!role) return { type, payload: { error: 'role required' } };
        const hasExistingConsolidation = isConsolidated(role, projectRoot);
        // Resolve the model only when there is something to optimize: pulling
        // the active provider is not free, and a role with no captures must
        // not touch it at all.
        const pending = readRawLearnedEntries(role, projectRoot);
        if (pending.length === 0) {
          return {
            type: 'agent-roster.consolidate',
            payload: {
              role,
              consolidated: false,
              rawEntryCount: 0,
              skills: [],
              hasExistingConsolidation,
              currentStats: getProjectAgentLearnStats(role, projectRoot),
            },
          };
        }
        const llm = this.getLlm();
        const result = await optimizeProjectAgentLearning(role, projectRoot, {
          ...(llm ? { llm } : {}),
          trigger: 'manual',
        });
        const currentStats = getProjectAgentLearnStats(role, projectRoot);
        const metadata = loadConsolidationMetadata(role, projectRoot);
        const basePayload = {
          role,
          rawEntryCount: result.rawEntryCount,
          skills: result.skills,
          hasExistingConsolidation,
          currentStats,
        };

        if (result.status === 'optimized') {
          try {
            this.broadcast({
              type: 'agent-roster.updated',
              payload: { role, reason: 'consolidated', currentStats, metadata },
            });
          } catch (e) {
            // Best-effort notification only; the optimization itself succeeded.
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'agent_roster.broadcast_failed',
                role,
                message: e instanceof Error ? e.message : String(e),
                timestamp: new Date().toISOString(),
              }),
            );
          }
          return {
            type: 'agent-roster.consolidate',
            payload: {
              ...basePayload,
              consolidated: true,
              content: result.content,
              model: result.model,
              pruned: result.pruned,
              metadata,
            },
          };
        }

        return {
          type: 'agent-roster.consolidate',
          payload: {
            ...basePayload,
            consolidated: false,
            ...(result.status === 'empty-synthesis'
              ? { emptySynthesis: true, model: result.model }
              : {}),
            ...(result.status === 'failed' ? { error: result.error } : {}),
            ...(result.status === 'no-llm'
              ? {
                  instruction: result.instruction,
                  leaderInstruction:
                    `Optimize what the "${role}" agent has learned. Read its raw learned entries, ` +
                    `synthesize them into a single narrowly-scoped document preserving every fact, and ` +
                    `save the result. The instruction text contains the full details and raw entries.`,
                }
              : {}),
          },
        };
      }

      // ── Automatic-optimization status ─────────────────────────────────
      // Read-only: says whether the background scheduler considers each role
      // eligible right now, and why not when it does not. Surfacing the reason
      // is what keeps "nothing happened" from looking like a broken feature.
      case 'agent-roster.auto-optimize-status': {
        const policy = resolveAutoOptimizePolicy(this.getAutoOptimizeSettings?.() ?? undefined);
        const roles = role ? [role] : listProjectAgentRoles(projectRoot);
        return {
          type,
          payload: {
            policy,
            roles: roles.map((current) => {
              try {
                const decision = evaluateAutoOptimize(current, projectRoot, policy);
                return { role: current, ...decision };
              } catch {
                return { role: current, eligible: false, reason: 'disabled' as const };
              }
            }),
          },
        };
      }

      // ── Skill layer: what this project has developed for each role skill ──
      case 'agent-roster.skills': {
        if (!role) return { type, payload: { error: 'role required' } };
        const candidates = resolveRoleSkillCandidates(role, projectRoot);
        const developed = listProjectSkillAugmentations(role, projectRoot);
        const affinity = loadSkillAffinity(role, projectRoot);
        // Raw counters do not say which skills actually get loaded — that is the
        // ranking, and it is the only part a user can act on (by pinning).
        const eager = new Set(rankRoleSkills(role, candidates, projectRoot));
        return {
          type,
          payload: {
            role,
            eagerLimit: DEFAULT_EAGER_SKILL_LIMIT,
            skills: candidates.map((skill) => ({
              skill,
              developed: developed.includes(skill),
              affinity: affinity.entries[skill] ?? null,
              score:
                scoreSkillAffinity(affinity.entries[skill]) + (developed.includes(skill) ? 1 : 0),
              eager: eager.has(skill),
            })),
          },
        };
      }

      // ── Directives the loop stopped believing ─────────────────────────────
      case 'agent-roster.quarantine': {
        if (!role) return { type, payload: { error: 'role required' } };
        return {
          type,
          payload: { role, retired: readQuarantinedDirectives(role, projectRoot) },
        };
      }

      case 'agent-roster.read-skill': {
        const skill = typeof p.skill === 'string' ? p.skill : '';
        if (!role || !skill) return { type, payload: { error: 'role and skill required' } };
        return {
          type,
          payload: { role, skill, content: loadProjectSkillAugmentation(role, skill, projectRoot) },
        };
      }

      case 'agent-roster.save-skill': {
        const skill = typeof p.skill === 'string' ? p.skill : '';
        if (!role || !skill || typeof p.content !== 'string') {
          return { type, payload: { error: 'role, skill and content required' } };
        }
        const savedPath = saveProjectSkillAugmentation(role, skill, p.content, projectRoot);
        return { type, payload: { role, skill, path: savedPath, success: true } };
      }

      case 'agent-roster.clear-skill': {
        const skill = typeof p.skill === 'string' ? p.skill : '';
        if (!role) return { type, payload: { error: 'role required' } };
        clearProjectSkillAugmentation(role, skill || undefined, projectRoot);
        return { type, payload: { role, skill: skill || null, success: true } };
      }

      case 'agent-roster.pin-skill': {
        const skill = typeof p.skill === 'string' ? p.skill : '';
        if (!role || !skill || typeof p.pinned !== 'boolean') {
          return { type, payload: { error: 'role, skill and boolean pinned required' } };
        }
        const affinity = setSkillPinned(role, skill, p.pinned, projectRoot);
        return { type, payload: { role, skill, pinned: p.pinned, affinity, success: true } };
      }

      // ── Save consolidated document ────────────────────────────────────
      case 'agent-roster.save-consolidated': {
        if (!role || typeof p.content !== 'string') {
          return { type, payload: { error: 'role and content required' } };
        }
        const trigger =
          typeof p.trigger === 'string' && p.trigger === 'automatic' ? 'automatic' : 'manual';
        const model = typeof p.model === 'string' ? p.model : undefined;
        const fp = saveProjectAgentConsolidated(role, p.content, projectRoot, {
          trigger,
          ...(model ? { model } : {}),
        });
        const stats = getProjectAgentLearnStats(role, projectRoot);
        return {
          type: 'agent-roster.save-consolidated',
          payload: { role, path: fp, success: true, stats },
        };
      }

      // ── Read consolidated document ────────────────────────────────────
      case 'agent-roster.read-consolidated': {
        if (!role) return { type, payload: { error: 'role required' } };
        const content = loadProjectAgentConsolidated(role, projectRoot);
        const metadata = loadConsolidationMetadata(role, projectRoot);
        const consolidated = isConsolidated(role, projectRoot);
        return {
          type: 'agent-roster.read-consolidated',
          payload: { role, content, metadata, isConsolidated: consolidated },
        };
      }

      // ── Clear consolidated document ───────────────────────────────────
      case 'agent-roster.clear-consolidated': {
        if (!role) return { type, payload: { error: 'role required' } };
        clearProjectAgentConsolidated(role, projectRoot);
        return { type, payload: { role, success: true } };
      }

      default:
        return { type, payload: { error: `Unknown agent-roster action: ${type}` } };
    }
  }
}
