import {
  claimSubagentSlot,
  emptySubagentModelPlan,
  formatSubagentSlot,
  getSessionSubagentModelPlan,
  isSlotConfigured,
  MAX_SUBAGENT_SLOTS,
  normalizeSubagentModelPlan,
  planHasAssignments,
  resetSessionSubagentModelPlan,
  resolveModelMatrixResolution,
  type SessionSubagentModelPlan,
  type SubagentSlot,
  setSessionSubagentModelPlan,
  subagentSlotOccupancy,
} from '@wrongstack/core/coordination';
import type { Config, ProviderConfig, SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/subagent-models` — session-scoped model routing for spawned subagents.
 *
 * Where `/setmodel` edits the PROJECT's role matrix in config.json, this edits
 * only the current session, and it routes by LANE: the Nth worker running at
 * any moment gets lane N's provider/model. See
 * `core/coordination/session-subagent-models.ts` for the resolution contract.
 */

/** A provider is targetable when it has a key, a key list, or a populated env var. */
function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (typeof entry.apiKey === 'string' && entry.apiKey.length > 0) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => k?.apiKey)) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => !!process.env[v])) return true;
  return false;
}

function keyedProviderIds(config: Config): string[] {
  const ids = new Set<string>();
  if (config.provider) ids.add(config.provider);
  for (const [id, entry] of Object.entries(config.providers ?? {})) {
    if (providerHasKey(entry)) ids.add(id);
  }
  return [...ids].sort();
}

/**
 * Parse a lane target. Accepts the same shapes as `/setmodel` plus `tier:<id>`:
 *   `anthropic/claude-opus-5`, `anthropic claude-opus-5`, `claude-opus-5`,
 *   `tier:budget`, `profile:cheap`, or a bare configured profile name.
 */
function parseTarget(tokens: string[], config: Config): SubagentSlot | { error: string } {
  const profiles = config.fallbackProfiles ?? {};
  if (tokens.length === 0) return { error: 'missing <provider>/<model>' };
  if (tokens.length >= 2) {
    return { provider: tokens[0] as string, model: tokens.slice(1).join(' ') };
  }
  const only = tokens[0] as string;
  if (only.startsWith('tier:')) {
    const tier = only.slice(5).trim();
    return tier ? { tier } : { error: 'missing tier id after "tier:"' };
  }
  if (only.startsWith('profile:')) {
    const name = only.slice(8).trim();
    if (!name) return { error: 'missing profile name after "profile:"' };
    if (!profiles[name]) return { error: `unknown fallback profile "${name}"` };
    return { fallbackProfile: name };
  }
  if (profiles[only]) return { fallbackProfile: only };
  if (only.includes('/')) {
    const i = only.indexOf('/');
    return { provider: only.slice(0, i), model: only.slice(i + 1) };
  }
  return { model: only };
}

/**
 * Colourised lane label. The plain text comes from core's
 * {@link formatSubagentSlot} so the terminal, the TUI panel and the browser
 * editors all render a lane the same way.
 */
function formatSlot(slot: SubagentSlot | undefined, config: Config): string {
  if (!slot || !isSlotConfigured(slot)) return color.dim('(inherit — matrix / tier / session)');
  // A lane with no provider inherits the leader's, so show what will actually
  // be used rather than the `*` placeholder the shared formatter emits.
  const text = formatSubagentSlot(
    slot.model && !slot.provider ? { ...slot, provider: config.provider } : slot,
  );
  return color.cyan(text);
}

/** 1-based lane number from user input; returns undefined when out of range. */
function parseLaneNumber(token: string | undefined, laneCount: number): number | undefined {
  if (!token) return undefined;
  const n = Number.parseInt(token, 10);
  if (!Number.isFinite(n) || n < 1 || n > laneCount) return undefined;
  return n - 1;
}

export function buildSubagentModelsCommand(opts: SlashCommandContext): SlashCommand {
  const help = [
    'Usage:',
    '  /subagent-models                         Show this session’s lane plan',
    '  /subagent-models set <n> <provider>/<model>   Pin lane n (1-based)',
    '  /subagent-models set <n> tier:<id>       Pin lane n to a cost tier',
    '  /subagent-models set <n> profile:<name>  Pin lane n to a fallback profile',
    '  /subagent-models clear <n|all>           Unpin a lane (or every lane)',
    '  /subagent-models role <role> <target>    Session-scoped role override',
    '  /subagent-models role <role> clear       Drop that role override',
    '  /subagent-models lanes <count>           Resize the lane list (1–' +
      `${MAX_SUBAGENT_SLOTS})`,
    '  /subagent-models lock on|off             Whether lanes outrank the leader',
    '  /subagent-models session on|off          Run every plain subagent on YOUR model',
    '  /subagent-models on|off                  Enable / disable the whole plan',
    '  /subagent-models reset                   Drop the plan for this session',
    '',
    'Lanes are handed out by occupancy: each live subagent holds one lane and',
    'releases it when it retires, so N workers running at once run on N',
    'different models. A role override wins over the lanes and consumes none.',
    '',
    '`session on` is the coarse version of the same idea: every plain subagent',
    'runs on the model this session is using. It outranks the lanes.',
    '',
    '/setmodel routing is left intact — a role or phase you pinned there keeps',
    'its route, and only a session role override outranks it.',
    '',
    'With lock on (the default) a lane also overrides the provider/model the',
    'leader passes to spawn_subagent / delegate. Precedence at spawn:',
    'session plan → leader pin → /setmodel matrix → tier → session model.',
    '',
    'Scoped to THIS session and stored in the session journal, so /resume',
    'brings it back. It never touches config.json — use /setmodel for that.',
  ].join('\n');

  function planFor(sessionId: string | undefined): SessionSubagentModelPlan {
    return getSessionSubagentModelPlan(sessionId) ?? emptySubagentModelPlan();
  }

  function render(plan: SessionSubagentModelPlan, sessionId: string | undefined): string {
    const config = opts.configStore.get();
    const occupancy = subagentSlotOccupancy(sessionId);
    const lines = [
      `${color.bold('WrongStack')} ${color.dim('— Subagent models (this session)')}`,
      '',
      `  ${color.bold('status')}  ${plan.enabled ? color.green('on') : color.red('off')}   ` +
        `${color.bold('lock')} ${plan.lock ? color.green('on') : color.dim('off')}   ` +
        `${color.bold('session model')} ${plan.followSessionModel ? color.green('on') : color.dim('off')}   ` +
        color.dim(plan.lock ? 'lanes override the leader' : 'leader pins win'),
      '',
      `  ${color.bold('lanes')} ${color.dim('(first free lane wins; ● = busy now)')}`,
    ];
    if (plan.followSessionModel) {
      lines.push(
        `    ${color.green('▸')} every plain subagent runs on ${color.cyan(`${config.provider}/${config.model}`)} ${color.dim('(lanes below are inactive)')}`,
      );
    }
    plan.slots.forEach((slot, i) => {
      const busy = occupancy[i]?.subagentIds.length ?? 0;
      const marker = busy > 0 ? color.green(`●${busy > 1 ? busy : ''}`) : color.dim('○');
      const label = slot.label ? color.dim(` ${slot.label}`) : '';
      lines.push(
        `    ${marker} ${color.amber(String(i + 1).padStart(2))}  ${formatSlot(slot, config)}${label}`,
      );
    });

    const roles = Object.entries(plan.roles ?? {});
    if (roles.length > 0) {
      lines.push('', `  ${color.bold('roles')} ${color.dim('(beat the lanes, consume none)')}`);
      for (const [role, slot] of roles.sort(([a], [b]) => a.localeCompare(b))) {
        lines.push(`    ${color.amber(role.padEnd(22))} → ${formatSlot(slot, config)}`);
      }
    }

    if (!planHasAssignments(plan)) {
      lines.push(
        '',
        color.dim('  no lane pinned — spawns resolve exactly as before'),
        color.dim('  pin one: /subagent-models set 1 anthropic/claude-opus-5'),
      );
    }
    lines.push(
      '',
      color.dim('  /subagent-models set · clear · role · lanes · lock · reset · help'),
    );
    return lines.join('\n');
  }

  return {
    name: 'subagent-models',
    description: 'Per-session provider/model lanes for spawned subagents',
    category: 'Agent',
    argsHint: '[set <n> <provider>/<model> | clear <n|all> | role <role> <target> | lock on|off]',
    help,
    async run(args, ctx) {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const sub = (tokens[0] ?? '').toLowerCase();
      const sessionId = ctx?.session?.id;
      const config = opts.configStore.get();
      const plan = planFor(sessionId);

      // Bare `/subagent-models` opens the interactive lane panel when the
      // surface has one (TUI); every other surface falls through to the text
      // view below, which is also what `list` always renders.
      if (!sub && opts.onPanelOpen?.current) {
        const opened = opts.onPanelOpen.current('subagentModelsOpen');
        if (opened) return { message: '' };
      }
      if (!sub || sub === 'list' || sub === 'show') {
        return { message: render(plan, sessionId), metadata: { subagentModelPlan: plan } };
      }
      // Reading the plan needs no session; writing it does, because the write
      // goes through the session journal that makes /resume work.
      if (!ctx?.session) {
        return { message: color.red('No active session — cannot change the subagent model plan.') };
      }

      const next: SessionSubagentModelPlan = normalizeSubagentModelPlan(plan);
      const save = async (message: string) => {
        await setSessionSubagentModelPlan(ctx, next);
        return { message, metadata: { subagentModelPlan: next } };
      };

      switch (sub) {
        case 'set': {
          const index = parseLaneNumber(tokens[1], next.slots.length);
          if (index === undefined) {
            return {
              message: color.red(`Lane must be a number between 1 and ${next.slots.length}.`),
            };
          }
          const target = parseTarget(tokens.slice(2), config);
          if ('error' in target)
            return { message: color.red(`/subagent-models set: ${target.error}`) };
          next.slots[index] = target;
          const provider = target.provider;
          const warning =
            provider && !keyedProviderIds(config).includes(provider)
              ? `\n${color.amber(`warning: provider "${provider}" has no configured key — spawns on lane ${index + 1} will fall back.`)}`
              : '';
          return save(
            `Lane ${index + 1} → ${formatSlot(target, config)}${warning}\n\n${render(next, sessionId)}`,
          );
        }
        case 'clear': {
          if ((tokens[1] ?? '').toLowerCase() === 'all') {
            next.slots = next.slots.map(() => ({}));
            return save(`Cleared every lane.\n\n${render(next, sessionId)}`);
          }
          const index = parseLaneNumber(tokens[1], next.slots.length);
          if (index === undefined) {
            return {
              message: color.red(
                `Lane must be a number between 1 and ${next.slots.length}, or "all".`,
              ),
            };
          }
          next.slots[index] = {};
          return save(`Cleared lane ${index + 1}.\n\n${render(next, sessionId)}`);
        }
        case 'role': {
          const role = tokens[1];
          if (!role) return { message: color.red('/subagent-models role: missing <role>') };
          const rest = tokens.slice(2);
          const roles = { ...(next.roles ?? {}) };
          if (rest.length === 0 || ['clear', 'none', '-'].includes((rest[0] ?? '').toLowerCase())) {
            delete roles[role];
            next.roles = roles;
            return save(`Dropped the override for role "${role}".\n\n${render(next, sessionId)}`);
          }
          const target = parseTarget(rest, config);
          if ('error' in target)
            return { message: color.red(`/subagent-models role: ${target.error}`) };
          roles[role] = target;
          next.roles = roles;
          return save(
            `Role "${role}" → ${formatSlot(target, config)}\n\n${render(next, sessionId)}`,
          );
        }
        case 'lanes': {
          const count = Number.parseInt(tokens[1] ?? '', 10);
          if (!Number.isFinite(count) || count < 1 || count > MAX_SUBAGENT_SLOTS) {
            return {
              message: color.red(`Lane count must be between 1 and ${MAX_SUBAGENT_SLOTS}.`),
            };
          }
          const dropped = next.slots.slice(count).filter(isSlotConfigured).length;
          next.slots =
            count <= next.slots.length
              ? next.slots.slice(0, count)
              : [...next.slots, ...Array.from({ length: count - next.slots.length }, () => ({}))];
          const note = dropped > 0 ? color.amber(` (${dropped} pinned lane(s) dropped)`) : '';
          return save(`Lane count → ${count}${note}\n\n${render(next, sessionId)}`);
        }
        case 'session': {
          const value = (tokens[1] ?? '').toLowerCase();
          if (value !== 'on' && value !== 'off') {
            return { message: color.red('/subagent-models session: expected "on" or "off".') };
          }
          next.followSessionModel = value === 'on';
          return save(
            `Follow session model ${value} — ${
              next.followSessionModel
                ? 'every plain subagent runs on this session’s model'
                : 'lanes and routing decide again'
            }.

${render(next, sessionId)}`,
          );
        }
        case 'lock': {
          const value = (tokens[1] ?? '').toLowerCase();
          if (value !== 'on' && value !== 'off') {
            return { message: color.red('/subagent-models lock: expected "on" or "off".') };
          }
          next.lock = value === 'on';
          return save(
            `Lock ${value} — ${next.lock ? 'lanes override leader-supplied models' : 'leader pins win, lanes only fill gaps'}.\n\n${render(next, sessionId)}`,
          );
        }
        case 'on':
        case 'off': {
          next.enabled = sub === 'on';
          return save(`Subagent model plan ${sub}.\n\n${render(next, sessionId)}`);
        }
        case 'reset': {
          const fresh = emptySubagentModelPlan();
          await setSessionSubagentModelPlan(ctx, fresh);
          resetSessionSubagentModelPlan(sessionId);
          return {
            message: `Reset the subagent model plan for this session.`,
            metadata: { subagentModelPlan: fresh },
          };
        }
        case 'resolve': {
          // Dry run: what would the NEXT spawn get? Claims and immediately
          // returns the lane so the preview never strands one as busy.
          const role = tokens[1];
          // Mirror the spawn gate: a role `/setmodel` routes explicitly is not
          // a plain spawn, so the preview must not promise it a lane.
          const routeSource = resolveModelMatrixResolution(config.modelMatrix, role)?.source;
          const routed = routeSource === 'role' || routeSource === 'phase';
          const claim = claimSubagentSlot(sessionId, { ...(role ? { role } : {}), routed });
          claim?.abandon();
          if (!claim) {
            return {
              message: color.dim(
                routed
                  ? `Role "${role}" is routed by /setmodel (${routeSource}) — the session plan leaves it alone.`
                  : 'No lane would apply — resolution falls through to the matrix / tier / session model.',
              ),
            };
          }
          const where =
            claim.kind === 'session-model'
              ? 'use my model'
              : claim.slotIndex === undefined
                ? `role "${role}"`
                : `lane ${claim.slotIndex + 1}`;
          const target =
            claim.kind === 'session-model'
              ? { provider: config.provider, model: config.model }
              : claim.target;
          return {
            message: `Next spawn${role ? ` of role "${role}"` : ''} → ${formatSlot(target, config)}  ${color.dim(`(${where}, lock ${claim.lock ? 'on' : 'off'})`)}`,
          };
        }
        default:
          return { message: color.red(`Unknown subcommand "${sub}".\n\n${help}`) };
      }
    },
  };
}
