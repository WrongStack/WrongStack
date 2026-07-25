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
  buildConsolidationInstruction,
  captureLearnedFromAgentOutputDetailed,
  clearProjectAgentConsolidated,
  createProjectAgent,
  detectLearnedConflicts,
  FLEET_ROSTER,
  getProjectAgentLearnStats,
  isConsolidated,
  listProjectAgentLearnedEntries,
  listProjectAgentRoles,
  loadConsolidationMetadata,
  loadProjectAgentConfig,
  loadProjectAgentConsolidated,
  loadProjectAgentIdentity,
  loadProjectAgentLearned,
  loadProjectAgentProfile,
  resetProjectAgentIdentity,
  saveProjectAgentConsolidated,
  slugifyProjectAgentRole,
  updateProjectAgentConfig,
  updateProjectAgentIdentity,
  updateProjectAgentLearned,
  updateProjectAgentLearningPolicy,
} from '@wrongstack/core/coordination';
import { isTextBlock } from '@wrongstack/core/types';
import type { Provider, Request } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';

/**
 * Resolved LLM handle used for headless (chat-free) consolidation. Both the
 * embedded and standalone routers can supply this from the active agent
 * context (`agent.ctx.provider` / `agent.ctx.model`).
 */
export interface AgentRosterLlm {
  provider: Provider;
  model: string;
}

export interface AgentRosterHandlerOptions {
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
}

/** Hard cap on synthesized consolidation output. */
const CONSOLIDATION_MAX_TOKENS = 8000;
/** Wall-clock budget for a single headless consolidation LLM call. */
const CONSOLIDATION_TIMEOUT_MS = 120_000;

export class AgentRosterWSHandler {
  private readonly getProjectRoot: () => string;
  private readonly getLlm: () => AgentRosterLlm | undefined;
  private readonly broadcast: (msg: WSServerMessage) => void;

  constructor(opts: AgentRosterHandlerOptions) {
    this.getProjectRoot =
      typeof opts.projectRoot === 'function' ? opts.projectRoot : () => opts.projectRoot as string;
    this.getLlm = opts.getLlm ?? (() => undefined);
    this.broadcast = opts.broadcast ?? (() => {});
  }

  /**
   * Run the consolidation LLM synthesis headlessly and return the cleaned
   * document text. Returns undefined when no LLM is available so the caller
   * can fall back to the instruction-only path.
   */
  private async synthesizeConsolidation(
    instruction: string,
  ): Promise<{ content: string; model: string } | undefined> {
    const llm = this.getLlm();
    if (!llm) return undefined;

    const req: Request = {
      model: llm.model,
      system: [
        {
          type: 'text',
          text:
            'You are a precise technical editor. You consolidate an AI agent role\'s ' +
            'captured learning entries into a single, durable, role-scoped instruction ' +
            'document. Output ONLY the consolidated markdown document — no preamble, no ' +
            'code fences, no commentary about the consolidation process.',
        },
      ],
      messages: [{ role: 'user', content: instruction }],
      maxTokens: CONSOLIDATION_MAX_TOKENS,
    };

    const timer = new AbortController();
    let timedOut = false;
    const to = setTimeout(() => {
      timedOut = true;
      timer.abort(new Error('consolidation timeout'));
    }, CONSOLIDATION_TIMEOUT_MS);
    to.unref();
    try {
      const res = await llm.provider.complete(req, { signal: timer.signal });
      const text = res.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n')
        .trim();
      // Strip an accidental ```markdown / ``` fence wrapper if the model wrapped
      // the WHOLE document in one. Gate on a single wrapper fence that spans the
      // entire output so a doc that legitimately starts or ends with a real code
      // block is not corrupted (that doc has an interior closing/opening fence,
      // so the whole-document pattern below will not match).
      const wholeDocFence = /^```(?:markdown|md)?[^\n]*\n([\s\S]*?)\n?```\s*$/i;
      const wrapped = wholeDocFence.exec(text);
      const inner = wrapped?.[1];
      const unfenced = inner !== undefined ? inner.trim() : text;
      return { content: unfenced, model: llm.model };
    } catch (err) {
      // Providers surface an abort as a generic AbortError; translate the
      // timeout case into a clear, caller-facing message.
      if (timedOut) {
        throw new Error(`consolidation timed out after ${CONSOLIDATION_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      // The AbortController exists solely to cancel the in-flight request on
      // timeout; the timeout path aborts itself. On the success path there is
      // nothing left to cancel, so only clear the pending timer here.
      clearTimeout(to);
    }
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

      // ── Consolidate learned entries (headless LLM synthesis) ──────────
      // Runs the whole optimization on the server: read raw entries →
      // synthesize with the active model → write consolidated.md +
      // consolidation.json. No chat round-trip. When no LLM is available the
      // handler degrades to returning the instruction so a caller (e.g. the
      // chat agent) can still perform the consolidation manually.
      case 'agent-roster.consolidate': {
        if (!role) return { type, payload: { error: 'role required' } };
        const { instruction, rawEntries, hasExistingConsolidation } =
          buildConsolidationInstruction(role, projectRoot);

        // Nothing to optimize — surface a clear, non-error signal.
        if (rawEntries.length === 0) {
          return {
            type: 'agent-roster.consolidate',
            payload: {
              role,
              consolidated: false,
              rawEntryCount: 0,
              hasExistingConsolidation,
              currentStats: getProjectAgentLearnStats(role, projectRoot),
            },
          };
        }

        // Headless path: synthesize + persist directly on the server.
        let synth: { content: string; model: string } | undefined;
        try {
          synth = await this.synthesizeConsolidation(instruction);
        } catch (err) {
          return {
            type: 'agent-roster.consolidate',
            payload: {
              role,
              consolidated: false,
              rawEntryCount: rawEntries.length,
              hasExistingConsolidation,
              currentStats: getProjectAgentLearnStats(role, projectRoot),
              error: err instanceof Error ? err.message : 'consolidation failed',
            },
          };
        }

        if (synth && synth.content.length > 0) {
          let stats: ReturnType<typeof getProjectAgentLearnStats>;
          let metadata: ReturnType<typeof loadConsolidationMetadata>;
          try {
            saveProjectAgentConsolidated(role, synth.content, projectRoot, {
              trigger: 'manual',
              model: synth.model,
            });
            stats = getProjectAgentLearnStats(role, projectRoot);
            metadata = loadConsolidationMetadata(role, projectRoot);
          } catch (err) {
            // Persisting the consolidated document failed (e.g. filesystem
            // error). Surface a structured failure instead of rejecting.
            return {
              type: 'agent-roster.consolidate',
              payload: {
                role,
                consolidated: false,
                rawEntryCount: rawEntries.length,
                hasExistingConsolidation,
                currentStats: getProjectAgentLearnStats(role, projectRoot),
                error: err instanceof Error ? err.message : 'failed to persist consolidation',
              },
            };
          }
          // Push a fresh roster card to every other connected client so they
          // reflect the new consolidated state without a manual reload. The
          // document is already persisted, so a broadcast failure (e.g. a
          // disconnected client iterator) must not reject the handler and
          // swallow the success response below.
          try {
            this.broadcast({
              type: 'agent-roster.updated',
              payload: { role, reason: 'consolidated', currentStats: stats, metadata },
            });
          } catch (e) {
            // Best-effort notification only; the consolidation itself succeeded.
            // Log so a real bug in `broadcast` (TypeError, malformed message) is
            // surfaced instead of silently swallowed alongside dead-client errors.
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
              role,
              consolidated: true,
              rawEntryCount: rawEntries.length,
              content: synth.content,
              model: synth.model,
              currentStats: stats,
              metadata,
            },
          };
        }

        // The model was available and ran, but produced only whitespace /
        // fencing. This is distinct from "no model available": signal it
        // explicitly so a caller can tell an empty synthesis apart from the
        // instruction-fallback path below and avoid corrupting the doc.
        if (synth) {
          return {
            type: 'agent-roster.consolidate',
            payload: {
              role,
              consolidated: false,
              emptySynthesis: true,
              model: synth.model,
              rawEntryCount: rawEntries.length,
              hasExistingConsolidation,
              currentStats: getProjectAgentLearnStats(role, projectRoot),
            },
          };
        }

        // Fallback path (no active model): return the instruction so a
        // caller can drive the consolidation through the chat agent.
        return {
          type: 'agent-roster.consolidate',
          payload: {
            role,
            consolidated: false,
            instruction,
            rawEntryCount: rawEntries.length,
            hasExistingConsolidation,
            currentStats: getProjectAgentLearnStats(role, projectRoot),
            // Instruction for the leader agent to execute the consolidation
            leaderInstruction:
              `Optimize what the "${role}" agent has learned. Read its raw learned entries, ` +
              `synthesize them into a single narrowly-scoped document preserving every fact, and ` +
              `save the result. The instruction text contains the full details and raw entries.`,
          },
        };
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
