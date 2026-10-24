import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import { ToolCapabilities } from '../security/capabilities.js';
import { snapshotConversationEffort } from '../utils/leader-effort-override.js';
import type { DispatchLogEntry } from './agents/dispatch-log.js';
import type * as Host from './director-host-contracts.js';
import { instantiateRosterConfig } from './director-input-helpers.js';
import {
  LEADER_EFFORT_SCHEMA,
  readLeaderEffort,
  readSpawnSkills,
  SPAWN_SKILLS_SCHEMA,
} from './director-spawn-model.js';

import { dispatchAgent, rosterDispatchCatalog } from './dispatcher.js';

import { callerSessionId } from './origin-session.js';

// ---------------------------------------------------------------------------
// Director-facing tool factories.
//
// Each tool's input schema is intentionally minimal — the director model
// reads the descriptions and gets clean structured shapes. We avoid deep
// nested schemas because they confuse smaller models.

export function makeSpawnTool(
  director: Host.DirectorAdmissionPort,
  roster?: Record<string, SubagentConfig>,
): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'What the subagent has to do, in free form. PREFER THIS over `role`: the dispatcher scores it against the capability metadata of every agent in the roster and picks the specialist, which is more reliable than recalling a role id from a list of 77. Only reach for `role` when you are certain which one you want.',
      },
      role: {
        type: 'string',
        description:
          'Roster role id. When set, the spawn uses the matching config from the roster, ignores other fields, and SKIPS DISPATCH ENTIRELY — so a half-remembered id silently costs you the specialist. Prefer `description` unless the id is certain.',
      },
      name: {
        type: 'string',
        description:
          'Display name for the subagent. Used as a fallback when description-based dispatch does not resolve a role.',
      },
      provider: {
        type: 'string',
        description:
          'Provider id — one of the configured providers listed in the Delegation section; pass it together with `model`. Defaults to the leader provider when omitted. The user may have pinned per-session models for spawned workers, in which case that pin wins over this field — the returned `provider`/`model` report what the worker actually runs on.',
      },
      model: {
        type: 'string',
        description:
          'Model id within the provider. Defaults to the leader model when omitted, and may be overridden by per-session worker-model pins the user set; read the returned `model` for what actually runs.',
      },
      tier: {
        type: 'string',
        description:
          "Cost/capability level for this worker: 'budget' (cheap + fast, for mechanical or well-specified work), 'standard' (the default), or 'premium' (expensive + most capable, for work where being wrong is costly). Resolved deterministically into a model, a failover chain, and a spend budget from `modelTiers` config, so you do NOT need to know any model id. Omit to let the routing table decide by role. An explicit `model` always wins over the tier.\n\nThis is the RIGHT place to spend a cheap tier. Because this spawn is non-blocking, a budget-tier worker being slower costs you nothing — you keep working while it runs. The same tier on `delegate` would just make you wait longer.",
      },
      effort: LEADER_EFFORT_SCHEMA,
      skills: SPAWN_SKILLS_SCHEMA,
      systemPromptOverride: {
        type: 'string',
        description: 'Extra prompt text appended after the role-base prompt.',
      },
      maxIterations: { type: 'number', minimum: 1 },
      maxToolCalls: { type: 'number', minimum: 1 },
      maxCostUsd: { type: 'number', minimum: 0 },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Hard wall-clock cap in milliseconds. Defaults to none (idle timeout is the default reaper).',
      },
      idleTimeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Idle timeout in ms: reap the subagent after this long with no activity. Resets on every iteration/tool call. Default is role/coordinator-specific.',
      },
      maxTokens: {
        type: 'number',
        minimum: 1,
        description: 'Maximum total tokens (input + output) the subagent may use.',
      },
      worktree: {
        anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
        description:
          'Git-worktree isolation override. true/"required" requires an isolated worktree; false/"off" disables it; "auto" follows fleet policy.',
      },
      system_prompt: {
        type: 'string',
        description: 'Complete custom system prompt for an ad-hoc subagent.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Explicit list of tools granted to this subagent.',
      },
      enable_write_tools: {
        type: 'boolean',
        description:
          'Adds file write/edit to a role whose grant is read-only. Most workers already write, run shell and reach the network; this never narrows them.',
      },
      enable_mcp_tools: {
        type: 'boolean',
        description:
          'Asks for MCP capabilities on a role with a narrowed grant. The CLI fleet host withholds MCP from workers, so it has no effect there.',
      },
      enable_network_tools: {
        type: 'boolean',
        description:
          'Adds outbound network (read_url_content) to a role whose grant leaves it out. Most workers already have it; this never narrows them.',
      },
    },
    required: [],
  };
  return {
    name: 'spawn_subagent',
    description:
      'Create a new subagent under this director (own LLM context, own budget). NON-BLOCKING: returns a `subagentId` immediately without triggering any model call. Pair with `assign_task` to send work and `await_tasks` to retrieve the result later — this is the async-delegation pattern that lets the leader keep working while the subagent runs in its own context.',
    usageHint:
      'Pass `description` (what the work is — dispatched to the best-matching specialist), or `role` when you are certain of the id, or `name` + `provider`/`model`. Returns `{ subagentId }`. The roster is deep and specialised: there is very likely an agent built for this exact job, so describe the work rather than defaulting to a generalist. Use this instead of `delegate` when you want to fan out to multiple subagents or keep the leader unblocked while work runs in parallel.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema,
    async execute(input: unknown, ctx?: unknown) {
      const i = (input ?? {}) as Record<string, unknown>;
      const role = typeof i.role === 'string' ? i.role : undefined;
      const description = typeof i.description === 'string' ? i.description : undefined;

      // Resolve base config from roster, explicit role, or dispatch-by-description
      let cfg: SubagentConfig | undefined;

      // How this spawn chose its role, recorded once below. Filled in by
      // whichever branch resolves — the branch that runs IS the finding.
      let routing: DispatchLogEntry | undefined;

      if (role && roster) {
        const base = roster[role];
        if (!base) {
          throw new ToolValidationError({
            message: `unknown role "${role}". roster has: ${Object.keys(roster).join(', ')}`,
            field: 'role',
          });
        }
        cfg = instantiateRosterConfig(role, base);
        routing = {
          at: new Date().toISOString(),
          role,
          source: 'explicit-role',
          tool: 'spawn_subagent',
        };
      } else if (description && !role) {
        // Smart dispatch: route description to best catalog agent using dispatcher
        const dispatchResult = await dispatchAgent(description, {
          classifier: director.dispatchClassifier,
          catalog: roster ? rosterDispatchCatalog(roster) : undefined,
        });
        const dispatchRole = dispatchResult.role;
        routing = {
          at: new Date().toISOString(),
          role: dispatchRole,
          source: 'description',
          tool: 'spawn_subagent',
          method: dispatchResult.method,
          confidence: dispatchResult.confidence,
          alternatives: (dispatchResult.alternatives ?? []).map((candidate) => candidate.role),
          matched: dispatchResult.matched ?? [],
          rosterMiss: !roster?.[dispatchRole],
        };
        // If we have a matching roster entry for the dispatched role, use it
        if (roster?.[dispatchRole]) {
          cfg = instantiateRosterConfig(dispatchRole, roster[dispatchRole] ?? {});
        } else {
          // Dispatch found a catalog agent but there's no roster entry — use the
          // catalog definition's config as a base template (role name + defaults).
          // We must not mutate the original definition, so spread it.
          const def = dispatchResult.definition;
          cfg = {
            name: def.config.name ?? dispatchRole,
            role: dispatchRole,
            provider: def.config.provider,
            model: def.config.model,
          };
        }
      }

      // Fall back to name-only config when neither role nor description dispatch resolved
      if (!cfg) {
        cfg = { name: (i.name as string) ?? 'subagent' };
        // No role at all: the roster contributed nothing to this spawn. Worth
        // counting on its own — it is the shape a leader produces when it is
        // hand-rolling a worker instead of reaching for a specialist.
        routing = {
          at: new Date().toISOString(),
          role: cfg.name,
          source: 'name-only',
          tool: 'spawn_subagent',
        };
      }

      if (typeof i.name === 'string') cfg.name = i.name;
      // A model the LEADER picked, not a human — the session plan's lock is
      // allowed to override exactly this (see `modelChosenByLeader`).
      if (typeof i.provider === 'string') {
        cfg.provider = i.provider;
        cfg.modelChosenByLeader = true;
      }
      if (typeof i.model === 'string') {
        cfg.model = i.model;
        cfg.modelChosenByLeader = true;
      }
      // Effort rides apart from the pin: a locked lane takes the model back but
      // leaves this decision with the leader (see `leaderEffort`).
      const effort = readLeaderEffort(i.effort);
      if (effort) cfg.leaderEffort = effort;
      const skills = readSpawnSkills(i.skills);
      if (skills) cfg.requestedSkills = skills;
      // What the leader runs at, for a worker nothing else picks an effort for.
      const ownEffort = snapshotConversationEffort(
        (ctx as { meta?: Record<string, unknown> } | undefined)?.meta,
      );
      if (ownEffort) cfg.leaderConversationEffort = ownEffort;
      if (typeof i.system_prompt === 'string') cfg.prompt = i.system_prompt;
      if (typeof i.systemPrompt === 'string') cfg.prompt = i.systemPrompt;
      if (typeof i.systemPromptOverride === 'string')
        cfg.systemPromptOverride = i.systemPromptOverride;
      if (Array.isArray(i.tools) && i.tools.every((t) => typeof t === 'string')) {
        cfg.tools = i.tools as string[];
      }
      // The `enable_*` toggles only reopen what a role's own narrow grant
      // withholds. A worker without a grant already runs on the host's wide
      // default (write, shell and network included); seeding a list here used
      // to replace that default with `fs.read` + the flag, so "enable writes"
      // silently cost the worker its shell — it could edit but not test.
      if (cfg.allowedCapabilities) {
        const extra: string[] = [];
        if (i.enable_write_tools === true) extra.push(ToolCapabilities.FS_WRITE);
        if (i.enable_mcp_tools === true) extra.push(ToolCapabilities.MCP_PROXY);
        if (i.enable_network_tools === true) extra.push(ToolCapabilities.NET_OUTBOUND);
        if (extra.length > 0) {
          cfg.allowedCapabilities = [...new Set([...cfg.allowedCapabilities, ...extra])];
        }
      }
      if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
      if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
      if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;
      if (typeof i.timeoutMs === 'number') cfg.timeoutMs = i.timeoutMs;
      if (typeof i.idleTimeoutMs === 'number') cfg.idleTimeoutMs = i.idleTimeoutMs;
      if (typeof i.maxTokens === 'number') cfg.maxTokens = i.maxTokens;

      // Tier + the caller's explicit budget pins. The spawn-time tier layer may
      // tighten a roster default but must never override a number typed here.
      if (typeof i.tier === 'string' && i.tier) cfg.tier = i.tier;
      const budgetPins: string[] = [];
      if (typeof i.maxIterations === 'number') budgetPins.push('maxIterations');
      if (typeof i.maxToolCalls === 'number') budgetPins.push('maxToolCalls');
      if (typeof i.maxCostUsd === 'number') budgetPins.push('maxCostUsd');
      if (typeof i.maxTokens === 'number') budgetPins.push('maxTokens');
      if (typeof i.timeoutMs === 'number') budgetPins.push('timeoutMs');
      if (budgetPins.length) cfg.budgetPins = budgetPins;
      if (
        typeof i.worktree === 'boolean' ||
        i.worktree === 'auto' ||
        i.worktree === 'required' ||
        i.worktree === 'off'
      ) {
        cfg.worktree = i.worktree;
      }
      // The worker belongs to the conversation that asked for it, which the
      // coordinator cannot read for itself once several tabs share one
      // process — its own session names the boot tab. See
      // `SubagentConfig.originSessionId`.
      const origin = callerSessionId(ctx);
      // A refused spawn (budget/cost/token cap, or any other failure) throws:
      // the cap errors' messages already carry the limit and observed values.
      const subagentId = await director.spawn(origin ? { ...cfg, originSessionId: origin } : cfg);
      // Recorded only once the spawn is admitted: a worker rejected by a
      // budget cap never ran, and counting it would overstate exactly the
      // routing volume this telemetry exists to measure.
      if (routing && director.onSpawnRouted) {
        director.onSpawnRouted({
          ...routing,
          subagentId,
          ...(origin ? { sessionId: origin } : {}),
        });
      }
      // Report what the worker ACTUALLY got. The session model plan, the
      // routing matrix and the tier layer all resolve inside `spawn()` on a
      // copy of this config, so `cfg.provider` / `cfg.model` still hold the
      // leader's own request — echoing that back would describe a worker
      // that does not exist.
      const resolved = director.resolvedModelFor?.(subagentId);
      return {
        subagentId,
        provider: resolved?.provider ?? cfg.provider,
        model: resolved?.model ?? cfg.model,
        // Absent = the worker inherits the leader's session effort.
        ...(resolved?.effort ? { effort: resolved.effort } : {}),
        name: cfg.name,
        role: cfg.role,
      };
    },
  };
}
