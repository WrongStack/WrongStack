/**
 * /brain — inspect and steer the session's global Brain.
 *
 * The Brain is the decision layer between the agents and the human:
 * policy arbiter first, LLM decision support second (within a live risk
 * ceiling), human escalation last. The BrainMonitor also engages it
 * proactively on tool-failure streaks and error storms.
 *
 * Every setter applies LIVE and persists to the active profile config
 * (config.brain is denied in project scope by design).
 */
import { randomUUID } from 'node:crypto';
import type {
  BrainAutoRisk,
  BrainConfigPatch,
  BrainConfigSnapshot,
} from '@wrongstack/core/execution';
import type { SlashCommand } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { compactEntry, handleBrainCouncilSubcommand, parseRefEntry } from './brain-council.js';
import { formatBrainStats, formatBrainStatus, readLedgerEntries } from './brain-status.js';
import type { SlashCommandContext } from './command-context.js';

const RISK_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'all']);
const HEURISTIC_FIELDS: Record<string, string> = {
  lowrisk: 'lowRiskAutoAnswer',
  blocked: 'blockedResolved',
  deadlock: 'deadlockSkip',
  retry: 'retryExhausted',
  continue: 'continuePing',
};
const DENY_TERMINAL_VALUES = ['never', 'when-decided', 'always'];
const TRACE_CONTENT_VALUES = ['none', 'redacted', 'full'];
const TERMINAL_POLICY_VALUES = ['conservative', 'deny-all', 'continue-on-recommended'];
const MONITOR_POLICY_VALUES = ['llm', 'steer', 'observe'];

export function buildBrainCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'brain',
    category: 'Agent',
    argsHint:
      '[status|stats|risk|mode|model|models|strategy|timeout|human-timeout|council|ledger|rules|heuristics|llm|trace|cache|escalation|monitor|ask|save]',
    description:
      'Inspect and configure the Brain: risk ceiling, escalation mode, LLM pool, council, timeouts, ledger. Setters apply live and persist globally.',
    help: [
      'Usage:',
      '  /brain                 Show Brain status (mode, risk ceiling, LLM pool, recent decisions)',
      '  /brain status          Same as /brain',
      '  /brain risk <level>    Set autonomy ceiling: off | low | medium | high | all',
      '  /brain mode <m>        headless (never block on a human) | interactive',
      '  /brain model <ref>     Use ONE decision model (provider/model), or "session" for the session model',
      '  /brain models <ref> [<ref> ...]   Replace the ordered LLM pool',
      '  /brain models add <ref> | remove <n|ref> | clear',
      '  /brain strategy <s>    Pool strategy: fallback | round-robin',
      '  /brain timeout <ms|default>       Per-LLM-call decision timeout',
      '  /brain human-timeout <ms|off>     Interactive escalation wait before terminal policy',
      '  /brain council on|off             Enable/disable the multi-LLM council',
      '  /brain council minrisk <medium|high|critical>',
      '  /brain council voters <seat> [<seat> ...]   seat = <ref>[:<persona>][:veto][:w=N]',
      '  /brain council personas           List the built-in decision lenses',
      '  /brain council judge <ref|auto> | quorum <0..1> | approval <0..1>',
      '  /brain council distinctness <none|model|provider>   warn on a non-diverse panel',
      '  /brain council timeout|concurrency|votertokens|judgetokens <n|default>',
      '  /brain ledger [n]      Show the last n rows (default 15) of the persistent decision ledger',
      '  /brain ledger on|off | autodeny <n>',
      '  /brain stats           Per-tier decision counts: how often the Brain actually calls a model',
      '  /brain rules           List the deterministic rule table and any compile errors',
      '  /brain rules clear     Remove all deterministic rules',
      '  /brain heuristics                 Show the built-in pattern heuristics',
      '  /brain heuristics <name> on|off   lowrisk|blocked|deadlock|retry|continue',
      '  /brain llm                        Show the single-LLM quality gate',
      '  /brain llm maxtokens <n|default> | uncertain on|off | confidence <0..1>',
      '  /brain llm deny <never|when-decided|always>',
      '  /brain llm breaker <n|off> [cooldownMs]   Skip a dead pool after n failures',
      '  /brain trace on|off               Record a replayable per-decision JSONL trace',
      '  /brain trace content <none|redacted|full>',
      '  /brain cache on|off | ttl <ms> | max <n>   Replay repeated council/LLM verdicts',
      '  /brain escalation <conservative|deny-all|continue-on-recommended>',
      '  /brain monitor <on|off> | policy <llm|steer|observe>',
      '  /brain ask <question>  Consult the Brain directly for decision support',
      '  /brain save            Re-persist the current Brain settings',
      '',
      'The Brain decides in tiers: deterministic policy → LLM pool / multi-LLM',
      'council (within the risk ceiling) → escalation. In headless mode the',
      'escalation tier resolves via the terminal policy instead of prompting',
      'you, so the Brain never blocks on a human. Model refs use the',
      '"provider/model" grammar (bare "model" = session provider). Every',
      'setter applies live AND persists to the active profile config. The',
      'Brain also self-activates on tool failure streaks and error storms,',
      'steering agents via mailbox.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);
      const subcommand = (sub ?? '').toLowerCase();

      const applyPatch = async (
        patch: BrainConfigPatch,
        describe: (snapshot: BrainConfigSnapshot) => string,
      ): Promise<{ message: string }> => {
        if (!opts.brainRuntime) {
          const msg = 'The Brain runtime is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        try {
          const { snapshot, persisted } = opts.brainRuntime.apply(patch);
          const result = await persisted;
          const note = result.ok
            ? color.dim(' — saved to the active profile config')
            : ` — applied live but NOT saved: ${result.error ?? 'unknown error'}`;
          const msg = `${describe(snapshot)}${note}`;
          if (result.ok) opts.renderer.write(msg);
          else opts.renderer.writeWarning(msg);
          return { message: msg };
        } catch (err) {
          const msg = `Invalid Brain setting: ${err instanceof Error ? err.message : String(err)}`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      };

      const poolSummary = (snapshot: BrainConfigSnapshot): string =>
        snapshot.poolLabels.length > 0 ? snapshot.poolLabels.join(' → ') : 'session model';

      if ((subcommand === '' || subcommand === 'status') && opts.onPanelOpen?.current) {
        const opened = opts.onPanelOpen.current('brainOpen');
        if (opened) return { message: '' };
      }

      if (subcommand === 'risk') {
        if (!opts.brainSettings) {
          const msg = 'Brain settings are not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const level = (rest[0] ?? '').toLowerCase();
        if (!level) {
          const msg = `Brain autonomy ceiling: ${color.cyan(opts.brainSettings.maxAutoRisk)} ${color.dim('(set with /brain risk <off|low|medium|high|all>)')}`;
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (!RISK_LEVELS.has(level)) {
          const msg = `Unknown risk level: ${level}. Use off, low, medium, high, or all.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        opts.brainSettings.maxAutoRisk = level as BrainAutoRisk;
        const explain =
          level === 'off'
            ? 'LLM layer disabled — everything the policy cannot answer escalates to you'
            : level === 'all'
              ? 'the Brain auto-decides everything, including critical-risk questions'
              : `the Brain auto-decides questions up to ${level} risk; above that it asks you`;
        const msg = `Brain autonomy ceiling set to ${color.cyan(level)} — ${explain}.`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'mode') {
        if (!opts.brainSettings) {
          const msg = 'Brain settings are not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const mode = (rest[0] ?? '').toLowerCase();
        if (!mode) {
          const msg = `Brain escalation mode: ${color.cyan(opts.brainSettings.mode ?? 'interactive')} ${color.dim('(set with /brain mode <headless|interactive>)')}`;
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (mode !== 'headless' && mode !== 'interactive') {
          const msg = `Unknown mode: ${mode}. Use headless or interactive.`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        opts.brainSettings.mode = mode;
        const explain =
          mode === 'headless'
            ? 'the Brain never blocks on you — escalations resolve via the terminal policy (safe default or deny)'
            : 'escalations above the risk ceiling prompt you in the TUI/WebUI';
        const msg = `Brain escalation mode set to ${color.cyan(mode)} — ${explain}.`;
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'model') {
        const ref = rest[0] ?? '';
        if (!ref) {
          const msg = 'Usage: /brain model <provider/model | session>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        if (ref.toLowerCase() === 'session') {
          return applyPatch(
            { models: null },
            (s) =>
              `Brain decision model: ${color.cyan('session model')} (pool cleared)${s.councilLabels.length === 0 ? '' : ' — council dissolved'}`,
          );
        }
        return applyPatch({ models: [ref] }, (s) =>
          s.poolLabels.length > 0
            ? `Brain decision model set to ${color.cyan(s.poolLabels.join(', '))}`
            : `Brain decision model set to ${color.cyan(ref)} (WARNING: unresolved provider — falling back to the session model)`,
        );
      }

      if (subcommand === 'models') {
        const op = (rest[0] ?? '').toLowerCase();
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (!rest.length || op === 'list') {
          const msg = snapshot
            ? `Brain LLM pool: ${snapshot.poolLabels.length > 0 ? color.cyan(snapshot.poolLabels.join(' → ')) : color.dim('session model')} ${color.dim(`(strategy: ${snapshot.strategy})`)}`
            : 'The Brain runtime is not available in this session.';
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (op === 'clear') {
          return applyPatch(
            { models: null },
            () => `Brain LLM pool cleared — using the ${color.cyan('session model')}`,
          );
        }
        if (op === 'add') {
          const ref = rest[1];
          if (!ref) {
            const msg = 'Usage: /brain models add <provider/model>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const current = (snapshot?.models ?? []).map(compactEntry);
          return applyPatch(
            { models: [...current, ref] },
            (s) => `Brain LLM pool: ${color.cyan(poolSummary(s))}`,
          );
        }
        if (op === 'remove') {
          const target = rest[1];
          if (!target || !snapshot) {
            const msg = 'Usage: /brain models remove <index|provider/model>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const current = snapshot.models.map(compactEntry);
          const idx = /^\d+$/.test(target)
            ? Number.parseInt(target, 10) - 1
            : current.findIndex(
                (c) =>
                  c === target || c.endsWith(`/${target}`) || c === parseRefEntry(target)?.model,
              );
          if (idx < 0 || idx >= current.length) {
            const msg = `No pool entry matches "${target}". Current pool: ${current.join(', ') || '(empty)'}`;
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const next = current.filter((_, i) => i !== idx);
          return applyPatch(
            { models: next.length > 0 ? next : null },
            (s) => `Brain LLM pool: ${color.cyan(poolSummary(s))}`,
          );
        }
        return applyPatch(
          { models: rest },
          (s) =>
            `Brain LLM pool: ${color.cyan(poolSummary(s))} ${color.dim(`(${s.poolLabels.length}/${rest.length} resolved)`)}`,
        );
      }

      if (subcommand === 'strategy') {
        const strategy = (rest[0] ?? '').toLowerCase();
        if (strategy !== 'fallback' && strategy !== 'round-robin') {
          const msg = 'Usage: /brain strategy <fallback|round-robin>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        return applyPatch(
          { strategy },
          () =>
            `Brain pool strategy set to ${color.cyan(strategy)} — ${strategy === 'fallback' ? 'first model is primary, the rest are tried in order on failure' : 'decisions rotate across the pool'}`,
        );
      }

      if (subcommand === 'timeout') {
        const raw = (rest[0] ?? '').toLowerCase();
        if (!raw) {
          const msg = 'Usage: /brain timeout <ms|default>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const patch: BrainConfigPatch =
          raw === 'default' ? { decisionTimeoutMs: null } : { decisionTimeoutMs: Number(raw) };
        return applyPatch(
          patch,
          (s) =>
            `Brain decision timeout: ${color.cyan(s.decisionTimeoutMs ? `${s.decisionTimeoutMs}ms` : 'default (15000ms)')}`,
        );
      }

      if (subcommand === 'human-timeout') {
        const raw = (rest[0] ?? '').toLowerCase();
        if (!raw) {
          const msg = 'Usage: /brain human-timeout <ms|off>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const patch: BrainConfigPatch =
          raw === 'off' ? { humanTimeoutMs: null } : { humanTimeoutMs: Number(raw) };
        return applyPatch(
          patch,
          (s) =>
            `Brain human-escalation timeout: ${color.cyan(s.humanTimeoutMs ? `${s.humanTimeoutMs}ms — unanswered prompts then resolve via the terminal policy` : 'off (wait indefinitely)')}`,
        );
      }

      if (subcommand === 'council') {
        return handleBrainCouncilSubcommand(rest, opts, applyPatch);
      }

      if (subcommand === 'save') {
        return applyPatch({}, () => 'Brain settings re-persisted');
      }

      if (subcommand === 'ledger') {
        const ledgerOp = (rest[0] ?? '').toLowerCase();
        if (ledgerOp === 'on' || ledgerOp === 'off') {
          return applyPatch(
            { ledger: { enabled: ledgerOp === 'on' } },
            (s) =>
              `Brain decision ledger ${color.cyan(s.ledger.enabled ? 'enabled' : 'disabled')}${s.ledger.enabled && s.ledger.path ? ` — ${s.ledger.path}` : ''}`,
          );
        }
        if (ledgerOp === 'autodeny') {
          const n = Number.parseInt(rest[1] ?? '', 10);
          if (!Number.isInteger(n) || n < 0) {
            const msg =
              'Usage: /brain ledger autodeny <n>  (0 disables the deterministic deny guard)';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch({ ledger: { autoDenyAfterFailures: n } }, () =>
            n === 0
              ? 'Brain ledger auto-deny guard disabled'
              : `Brain ledger auto-deny guard: deny after ${color.cyan(String(n))} consecutive observed failures`,
          );
        }
        const ledgerPath = opts.brainSettings?.ledgerPath;
        if (!ledgerPath) {
          const msg = 'The Brain decision ledger is disabled in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const n = Math.max(1, Math.min(100, Number.parseInt(rest[0] ?? '15', 10) || 15));
        const msg = await readLedgerEntries(ledgerPath, n);
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'ask') {
        const question = rest.join(' ').trim();
        if (!question) {
          const msg = 'Usage: /brain ask <question>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        if (!opts.brain) {
          const msg = 'The Brain is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        try {
          const decision = await opts.brain.decide({
            id: `brain-ask-${randomUUID()}`,
            sessionId: opts.context?.session.id,
            source: 'user',
            question,
            risk: 'medium',
            fallback: 'ask_human',
          });
          let msg: string;
          if (decision.type === 'answer') {
            msg = `🧠 ${decision.text}${decision.rationale && decision.rationale !== decision.text ? `\n${color.dim(decision.rationale)}` : ''}`;
          } else if (decision.type === 'deny') {
            msg = `🧠 Denied: ${decision.reason}`;
          } else {
            msg = '🧠 The Brain escalated this question back to you — it needs human judgement.';
          }
          opts.renderer.write(msg);
          return { message: msg };
        } catch (err) {
          const msg = `Brain consultation failed: ${err instanceof Error ? err.message : String(err)}`;
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
      }

      if (subcommand === '' || subcommand === 'status') {
        const msg = formatBrainStatus(opts);
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'rules') {
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (!snapshot) {
          const msg = 'The Brain runtime is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        if ((rest[0] ?? '').toLowerCase() === 'clear') {
          return applyPatch({ rules: null }, () => 'Brain deterministic rules cleared');
        }
        const lines = [color.bold('Brain deterministic rules')];
        if (snapshot.rules.length === 0) {
          lines.push(color.dim('  (none - every question goes to the policy/LLM ladder)'));
          lines.push(color.dim('  Add rules under brain.rules in the active profile config.'));
        } else {
          for (const rule of snapshot.rules) {
            const state = rule.enabled === false ? color.dim(' [disabled]') : '';
            lines.push(`  ${color.cyan(rule.id)} -> ${rule.then.action}${state}`);
            if (rule.description) lines.push(color.dim(`    ${rule.description}`));
          }
        }
        for (const err of snapshot.ruleErrors) {
          lines.push(color.dim(`  ! ${err}`));
        }
        const msg = lines.join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'heuristics') {
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (!snapshot) {
          const msg = 'The Brain runtime is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const name = (rest[0] ?? '').toLowerCase();
        if (!name) {
          const h = snapshot.heuristics;
          const row = (label: string, on: boolean): string =>
            `  ${label.padEnd(12)} ${on ? color.cyan('on') : color.dim('off')}`;
          const lines = [
            color.bold('Brain heuristics'),
            row('lowrisk', h.lowRiskAutoAnswer),
            row('blocked', h.blockedResolved),
            row('deadlock', h.deadlockSkip),
            row('retry', h.retryExhausted),
            row('continue', h.continuePing),
          ];
          if (h.blockedResolvedMarkers?.length) {
            lines.push(color.dim(`  markers: ${h.blockedResolvedMarkers.join(', ')}`));
          }
          const msg = lines.join('\n');
          opts.renderer.write(msg);
          return { message: msg };
        }
        const field = HEURISTIC_FIELDS[name];
        const value = (rest[1] ?? '').toLowerCase();
        if (!field || (value !== 'on' && value !== 'off')) {
          const msg = 'Usage: /brain heuristics <lowrisk|blocked|deadlock|retry|continue> <on|off>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        return applyPatch(
          { heuristics: { [field]: value === 'on' } },
          () => `Brain heuristic ${color.cyan(name)} set to ${color.cyan(value)}`,
        );
      }

      if (subcommand === 'llm') {
        const op = (rest[0] ?? '').toLowerCase();
        if (!op) {
          const snapshot = opts.brainRuntime?.getSnapshot();
          if (!snapshot) {
            const msg = 'The Brain runtime is not available in this session.';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const l = snapshot.llm;
          const msg = [
            color.bold('Brain LLM quality gate'),
            `  maxTokens       ${color.cyan(String(l.maxTokens))}`,
            `  rejectUncertain ${l.rejectUncertain ? color.cyan('on') : color.dim('off')}`,
            `  minConfidence   ${color.cyan(String(l.minConfidence))}${l.minConfidence === 0 ? color.dim(' (off)') : ''}`,
            `  denyIsTerminal  ${color.cyan(l.denyIsTerminal)}`,
            snapshot.circuit
              ? `  circuit         ${color.cyan(snapshot.circuit.state)} (${snapshot.circuit.consecutiveFailures} consecutive failures)`
              : color.dim('  circuit         disabled'),
          ].join('\n');
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (op === 'maxtokens') {
          const raw = (rest[1] ?? '').toLowerCase();
          if (!raw) {
            const msg = 'Usage: /brain llm maxtokens <n|default>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch(
            { llm: raw === 'default' ? { maxTokens: undefined } : { maxTokens: Number(raw) } },
            (s2) => `Brain LLM maxTokens set to ${color.cyan(String(s2.llm.maxTokens))}`,
          );
        }
        if (op === 'uncertain') {
          const value = (rest[1] ?? '').toLowerCase();
          if (value !== 'on' && value !== 'off') {
            const msg = 'Usage: /brain llm uncertain <on|off>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch(
            { llm: { rejectUncertain: value === 'on' } },
            () => `Brain LLM uncertainty rejection ${color.cyan(value)}`,
          );
        }
        if (op === 'confidence') {
          return applyPatch(
            { llm: { minConfidence: Number(rest[1]) } },
            (s2) => `Brain LLM minConfidence set to ${color.cyan(String(s2.llm.minConfidence))}`,
          );
        }
        if (op === 'deny') {
          const value = (rest[1] ?? '').toLowerCase();
          if (!DENY_TERMINAL_VALUES.includes(value)) {
            const msg = 'Usage: /brain llm deny <never|when-decided|always>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch(
            { llm: { denyIsTerminal: value as 'never' | 'when-decided' | 'always' } },
            () => `Brain LLM denyIsTerminal set to ${color.cyan(value)}`,
          );
        }
        if (op === 'breaker') {
          const raw = (rest[1] ?? '').toLowerCase();
          if (!raw) {
            const msg = 'Usage: /brain llm breaker <n|off> [cooldownMs]';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const threshold = raw === 'off' ? 0 : Number(raw);
          const cooldown = rest[2] ? Number(rest[2]) : undefined;
          return applyPatch(
            {
              llm: {
                circuitBreaker: {
                  failureThreshold: threshold,
                  ...(cooldown !== undefined ? { cooldownMs: cooldown } : {}),
                },
              },
            },
            () =>
              threshold === 0
                ? 'Brain LLM circuit breaker disabled'
                : `Brain LLM circuit breaker opens after ${color.cyan(String(threshold))} consecutive failures`,
          );
        }
        const msg = 'Usage: /brain llm [maxtokens|uncertain|confidence|deny|breaker] ...';
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      if (subcommand === 'trace') {
        const op = (rest[0] ?? '').toLowerCase();
        if (op === 'on' || op === 'off') {
          return applyPatch({ trace: { enabled: op === 'on' } }, (s2) =>
            op === 'on'
              ? `Brain replay trace ${color.cyan('on')}${s2.trace.path ? color.dim(` -> ${s2.trace.path}`) : ''} - records decision content to disk`
              : `Brain replay trace ${color.cyan('off')}`,
          );
        }
        if (op === 'content') {
          const value = (rest[1] ?? '').toLowerCase();
          if (!TRACE_CONTENT_VALUES.includes(value)) {
            const msg = 'Usage: /brain trace content <none|redacted|full>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch(
            { trace: { content: value as 'none' | 'redacted' | 'full' } },
            () => `Brain trace content set to ${color.cyan(value)}`,
          );
        }
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (!snapshot) {
          const msg = 'The Brain runtime is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const msg = [
          color.bold('Brain replay trace'),
          `  enabled  ${snapshot.trace.enabled ? color.cyan('yes') : color.dim('no')}`,
          `  content  ${color.cyan(snapshot.trace.content)}`,
          snapshot.trace.path ? `  path     ${color.dim(snapshot.trace.path)}` : '',
          color.dim(
            '  Records tiers, every pool target (incl. failures), council votes and tokens.',
          ),
        ]
          .filter(Boolean)
          .join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'cache') {
        const op = (rest[0] ?? '').toLowerCase();
        if (op === 'on' || op === 'off') {
          return applyPatch(
            { cache: { enabled: op === 'on' } },
            () => `Brain decision cache ${color.cyan(op)}`,
          );
        }
        if (op === 'ttl') {
          return applyPatch(
            { cache: { ttlMs: Number(rest[1]) } },
            (s2) => `Brain cache TTL set to ${color.cyan(String(s2.cache.ttlMs))}ms`,
          );
        }
        if (op === 'max') {
          return applyPatch(
            { cache: { maxEntries: Number(rest[1]) } },
            (s2) => `Brain cache max entries set to ${color.cyan(String(s2.cache.maxEntries))}`,
          );
        }
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (!snapshot) {
          const msg = 'The Brain runtime is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const c = snapshot.cache;
        const total = c.hits + c.misses;
        const rate =
          total > 0 ? color.dim(` (${Math.round((c.hits / total) * 100)}% hit rate)`) : '';
        const msg = [
          color.bold('Brain decision cache'),
          `  enabled  ${c.enabled ? color.cyan('yes') : color.dim('no')}`,
          `  ttl      ${color.cyan(String(c.ttlMs))}ms   max ${color.cyan(String(c.maxEntries))}`,
          `  live     ${color.cyan(String(c.size))} entries, ${color.cyan(String(c.hits))} hit / ${String(c.misses)} miss${rate}`,
          color.dim('  Only council/LLM verdicts are cached; a failed outcome evicts its entry.'),
        ].join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'escalation') {
        const value = (rest[0] ?? '').toLowerCase();
        if (!TERMINAL_POLICY_VALUES.includes(value)) {
          const snapshot = opts.brainRuntime?.getSnapshot();
          const current = snapshot ? color.cyan(snapshot.terminalPolicy) : color.dim('unknown');
          const msg = `Brain escalation policy: ${current}\nUsage: /brain escalation <conservative|deny-all|continue-on-recommended>`;
          opts.renderer.write(msg);
          return { message: msg };
        }
        return applyPatch(
          { terminalPolicy: value as 'conservative' | 'deny-all' | 'continue-on-recommended' },
          () => `Brain escalation policy set to ${color.cyan(value)}`,
        );
      }

      if (subcommand === 'monitor') {
        const op = (rest[0] ?? '').toLowerCase();
        const live = color.dim('(applied live - accumulating signal counters reset)');
        if (op === 'on' || op === 'off') {
          return applyPatch(
            { monitor: { enabled: op === 'on' } },
            () => `Brain monitor ${color.cyan(op)} ${live}`,
          );
        }
        if (op === 'policy') {
          const value = (rest[1] ?? '').toLowerCase();
          if (!MONITOR_POLICY_VALUES.includes(value)) {
            const msg = 'Usage: /brain monitor policy <llm|steer|observe>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch(
            { monitor: { policy: value as 'llm' | 'steer' | 'observe' } },
            () => `Brain monitor policy set to ${color.cyan(value)} ${live}`,
          );
        }
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (!snapshot) {
          const msg = 'The Brain runtime is not available in this session.';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        const m = snapshot.monitor;
        const msg = [
          color.bold('Brain monitor (self-activation)'),
          `  enabled  ${m.enabled === false ? color.dim('no') : color.cyan('yes')}`,
          `  policy   ${color.cyan(m.policy ?? 'llm')}`,
          color.dim('  Signals: tool-failure streak, error storm, agent stall, file churn.'),
          color.dim(
            '  Changes apply live; a change restarts the watchers, resetting signal counters.',
          ),
        ].join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'stats') {
        const msg = formatBrainStats(opts);
        opts.renderer.write(msg);
        return { message: msg };
      }

      const msg = `Unknown subcommand: ${subcommand}. Use /brain, status, stats, risk, mode, model, models, strategy, timeout, human-timeout, council, ledger, rules, heuristics, llm, trace, cache, escalation, monitor, ask, or save (see /brain help).`;
      opts.renderer.writeWarning(msg);
      return { message: msg };
    },
  };
}
