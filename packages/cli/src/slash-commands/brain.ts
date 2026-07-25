/**
 * /brain — inspect and steer the session's global Brain.
 *
 * The Brain is the decision layer between the agents and the human:
 * policy arbiter first, LLM decision support second (within a live risk
 * ceiling), human escalation last. The BrainMonitor also engages it
 * proactively on tool-failure streaks and error storms.
 *
 *   /brain                  status — mode, ceiling, pool, recent decisions
 *   /brain status           same
 *   /brain risk <level>     set the autonomy ceiling (off|low|medium|high|all)
 *   /brain mode <m>         headless (never block on a human) | interactive
 *   /brain model <ref>      single decision model ("session" = session model)
 *   /brain models ...       ordered LLM pool (set/add/remove/clear)
 *   /brain strategy <s>     pool strategy: fallback | round-robin
 *   /brain timeout <ms>     per-LLM-call decision timeout
 *   /brain human-timeout    interactive escalation timeout (ms | off)
 *   /brain council ...      multi-LLM council (on/off/minrisk/voters/judge/…)
 *   /brain ledger ...       view rows | on|off | autodeny <n>
 *   /brain ask <question>   consult the Brain directly for a decision
 *   /brain save             re-persist the current settings
 *
 * Every setter applies LIVE and persists to the active profile config
 * (config.brain is denied in project scope by design).
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { BrainAutoRisk, BrainConfigPatch } from '@wrongstack/core/execution';
import type { BrainConfigSnapshot } from '@wrongstack/core/execution';
import type { BrainCouncilVoterConfig, SlashCommand } from '@wrongstack/core/types';
import type { BrainLedgerEntry } from '@wrongstack/core/coordination';
import { color } from '@wrongstack/core/utils';
import { parseModelRef } from '@wrongstack/core/agent';
import type { SlashCommandContext } from './command-context.js';

const RISK_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'all']);
const COUNCIL_RISKS: ReadonlySet<string> = new Set(['medium', 'high', 'critical']);
const PERSONA_SHORTHANDS: ReadonlySet<string> = new Set(['executor', 'skeptic', 'auditor']);
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
/** Tiers that reached a decision without any provider call. */
const DETERMINISTIC_TIER_NAMES = ['rule', 'policy', 'heuristic', 'cache', 'ledger-guard', 'terminal'];

function parseRefEntry(ref: string): { provider?: string; model: string } | null {
  const parsed = parseModelRef(ref);
  const model = parsed.model?.trim();
  if (!model) return null;
  return parsed.provider ? { provider: parsed.provider, model } : { model };
}

function compactEntry(entry: { provider?: string | undefined; model: string }): string {
  return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

/**
 * Render the EFFECTIVE council judge as a `, judge: …` suffix.
 *
 * Status used to print `council.judge`, which is the CONFIGURED judge and is
 * usually absent — so in the common case (judge derived from the pool) the
 * line said nothing at all. That is precisely the case worth showing: the
 * judge only runs to break a tie or synthesize a split panel, so a judge that
 * is itself one of the seats re-states its own vote with the deciding weight.
 * `[derived]` marks the non-configured case and `⚠ also a voter` marks the
 * correlation, which happens whenever the pool has no model left over after
 * seating (pool size == seat count).
 */
function judgeSummary(s: {
  judgeLabel: string | undefined;
  judgeIsVoter: boolean;
  council: { judge?: { provider?: string | undefined; model: string } | undefined };
}): string {
  if (!s.judgeLabel) return '';
  const origin = s.council.judge ? '' : ' [derived]';
  return `, judge: ${s.judgeLabel}${origin}${s.judgeIsVoter ? ' ⚠ also a voter' : ''}`;
}

/**
 * Council seat grammar: `<ref>[:executor|:skeptic|:auditor][:persona=NAME][:veto][:w=N]`.
 * Modifiers are stripped from the RIGHT so model ids containing `:`
 * (e.g. ollama tags) survive as part of the ref.
 */
function parseSeat(token: string): BrainCouncilVoterConfig | null {
  const parts = token.split(':');
  const mods: string[] = [];
  while (parts.length > 1) {
    const tail = (parts[parts.length - 1] ?? '').toLowerCase();
    const isMod =
      tail === 'veto' ||
      /^w(eight)?=\d+(\.\d+)?$/.test(tail) ||
      tail.startsWith('persona=') ||
      PERSONA_SHORTHANDS.has(tail);
    if (!isMod) break;
    mods.push(parts.pop() as string);
  }
  const entry = parseRefEntry(parts.join(':'));
  if (!entry) return null;
  const voter: BrainCouncilVoterConfig = { ...entry };
  for (const raw of mods) {
    const mod = raw.toLowerCase();
    if (mod === 'veto') voter.veto = true;
    else if (mod.startsWith('w=') || mod.startsWith('weight=')) {
      voter.weight = Number(raw.slice(raw.indexOf('=') + 1));
    } else if (mod.startsWith('persona=')) {
      voter.persona = raw.slice(raw.indexOf('=') + 1);
    } else voter.persona = mod;
  }
  return voter;
}

function fmtAge(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

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
      '  /brain council voters <seat> [<seat> ...]   seat = <ref>[:executor|:skeptic|:auditor][:veto][:w=N]',
      '  /brain council judge <ref|auto> | quorum <0..1> | approval <0..1>',
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

      /** Apply a live+persist patch through the BrainRuntime and report the outcome. */
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
        snapshot.poolLabels.length > 0
          ? snapshot.poolLabels.join(' → ')
          : 'session model';

      // TUI mode: bare /brain or /brain status opens the interactive panel.
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
          return applyPatch({ models: null }, (s) => `Brain decision model: ${color.cyan('session model')} (pool cleared)${s.councilLabels.length === 0 ? '' : ' — council dissolved'}`);
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
          return applyPatch({ models: null }, () => `Brain LLM pool cleared — using the ${color.cyan('session model')}`);
        }
        if (op === 'add') {
          const ref = rest[1];
          if (!ref) {
            const msg = 'Usage: /brain models add <provider/model>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const current = (snapshot?.models ?? []).map(compactEntry);
          return applyPatch({ models: [...current, ref] }, (s) => `Brain LLM pool: ${color.cyan(poolSummary(s))}`);
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
            : current.findIndex((c) => c === target || c.endsWith(`/${target}`) || c === parseRefEntry(target)?.model);
          if (idx < 0 || idx >= current.length) {
            const msg = `No pool entry matches "${target}". Current pool: ${current.join(', ') || '(empty)'}`;
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          const next = current.filter((_, i) => i !== idx);
          return applyPatch({ models: next.length > 0 ? next : null }, (s) => `Brain LLM pool: ${color.cyan(poolSummary(s))}`);
        }
        return applyPatch({ models: rest }, (s) => `Brain LLM pool: ${color.cyan(poolSummary(s))} ${color.dim(`(${s.poolLabels.length}/${rest.length} resolved)`)}`);
      }

      if (subcommand === 'strategy') {
        const strategy = (rest[0] ?? '').toLowerCase();
        if (strategy !== 'fallback' && strategy !== 'round-robin') {
          const msg = 'Usage: /brain strategy <fallback|round-robin>';
          opts.renderer.writeWarning(msg);
          return { message: msg };
        }
        return applyPatch({ strategy }, () =>
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
        return applyPatch(patch, (s) =>
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
        return applyPatch(patch, (s) =>
          `Brain human-escalation timeout: ${color.cyan(s.humanTimeoutMs ? `${s.humanTimeoutMs}ms — unanswered prompts then resolve via the terminal policy` : 'off (wait indefinitely)')}`,
        );
      }

      if (subcommand === 'council') {
        const op = (rest[0] ?? '').toLowerCase();
        const councilSummary = (s: BrainConfigSnapshot): string =>
          s.council.enabled
            ? `council ${color.cyan('convened')}: ${s.councilLabels.join(', ')} ${color.dim(`(minRisk: ${s.council.minRisk}${judgeSummary(s)})`)}`
            : `council ${color.dim('disabled')}`;
        if (!op) {
          const snapshot = opts.brainRuntime?.getSnapshot();
          const msg = snapshot ? `Brain ${councilSummary(snapshot)}` : 'The Brain runtime is not available in this session.';
          opts.renderer.write(msg);
          return { message: msg };
        }
        if (op === 'on' || op === 'off') {
          return applyPatch({ council: { enabled: op === 'on' } }, (s) => `Brain ${councilSummary(s)}${op === 'on' && !s.council.enabled ? ' — needs ≥2 resolvable voters (set /brain council voters or a ≥2-model pool)' : ''}`);
        }
        if (op === 'minrisk') {
          const level = (rest[1] ?? '').toLowerCase();
          if (!COUNCIL_RISKS.has(level)) {
            const msg = 'Usage: /brain council minrisk <medium|high|critical>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch({ council: { minRisk: level as 'medium' | 'high' | 'critical' } }, (s) => `Brain council risk floor set to ${color.cyan(s.council.minRisk)} — questions at/above it convene the council`);
        }
        if (op === 'voters') {
          const seats = rest.slice(1).map(parseSeat);
          if (seats.length === 0 || seats.some((s) => s === null)) {
            const msg = 'Usage: /brain council voters <ref[:executor|:skeptic|:auditor][:veto][:w=N]> [...]';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch({ council: { voters: seats as BrainCouncilVoterConfig[] } }, councilSummary);
        }
        if (op === 'judge') {
          const ref = rest[1];
          if (!ref) {
            const msg = 'Usage: /brain council judge <provider/model | auto>';
            opts.renderer.writeWarning(msg);
            return { message: msg };
          }
          return applyPatch({ council: { judge: ref.toLowerCase() === 'auto' ? null : ref } }, (s) => `Brain council judge: ${color.cyan(s.council.judge ? compactEntry(s.council.judge) : 'auto')}${s.council.judge ? '' : color.dim(judgeSummary(s).replace(/^, judge: /, ' → '))}`);
        }
        if (op === 'quorum' || op === 'approval') {
          const value = Number(rest[1]);
          return applyPatch(
            op === 'quorum' ? { council: { quorum: value } } : { council: { approval: value } },
            (s) => `Brain council ${op} set to ${color.cyan(String(op === 'quorum' ? (s.council.quorum ?? 0.5) : (s.council.approval ?? 0.5)))}`,
          );
        }
        const msg = `Unknown council subcommand: ${op}. Use on, off, minrisk, voters, judge, quorum, or approval.`;
        opts.renderer.writeWarning(msg);
        return { message: msg };
      }

      if (subcommand === 'save') {
        return applyPatch({}, () => 'Brain settings re-persisted');
      }

      if (subcommand === 'ledger') {
        const ledgerOp = (rest[0] ?? '').toLowerCase();
        if (ledgerOp === 'on' || ledgerOp === 'off') {
          return applyPatch({ ledger: { enabled: ledgerOp === 'on' } }, (s) =>
            `Brain decision ledger ${color.cyan(s.ledger.enabled ? 'enabled' : 'disabled')}${s.ledger.enabled && s.ledger.path ? ` — ${s.ledger.path}` : ''}`,
          );
        }
        if (ledgerOp === 'autodeny') {
          const n = Number.parseInt(rest[1] ?? '', 10);
          if (!Number.isInteger(n) || n < 0) {
            const msg = 'Usage: /brain ledger autodeny <n>  (0 disables the deterministic deny guard)';
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
        let raw: string;
        try {
          raw = await readFile(ledgerPath, 'utf8');
        } catch {
          const msg = `No ledger entries yet (${ledgerPath}).`;
          opts.renderer.write(msg);
          return { message: msg };
        }
        const rows = raw
          .split('\n')
          .filter((l) => l.trim().length > 0)
          .slice(-n)
          .map((l) => {
            try {
              return JSON.parse(l) as BrainLedgerEntry;
            } catch {
              return null;
            }
          })
          .filter((e): e is BrainLedgerEntry => e !== null);
        const lines = [
          `${color.bold('Brain ledger')} — ${color.dim(ledgerPath)}`,
          ...rows.map((e) => {
            const what =
              e.kind === 'outcome'
                ? `outcome:${e.outcome}`
                : e.kind === 'answered' && e.optionId
                  ? `answered [${e.optionId}]`
                  : e.kind;
            const detail = e.question ?? e.detail ?? '';
            const trimmed = detail.length > 70 ? `${detail.slice(0, 67)}…` : detail;
            return `  ${color.dim(fmtAge(e.at).padEnd(8))} ${what.padEnd(20)} ${trimmed}`;
          }),
        ];
        if (rows.length === 0) lines.push(color.dim('  (empty)'));
        const msg = lines.join('\n');
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
        const lines: string[] = [];
        const ceiling = opts.brainSettings?.maxAutoRisk ?? 'unknown';
        const mode = opts.brainSettings?.mode ?? 'interactive';
        lines.push(`${color.bold('Brain')} — policy → LLM/council → escalation decision chain`);
        lines.push(
          `  escalation mode:  ${color.cyan(mode)} ${color.dim(mode === 'headless' ? '(never blocks on a human — /brain mode interactive to change)' : '(/brain mode headless for fully unattended)')}`,
        );
        lines.push(
          `  autonomy ceiling: ${color.cyan(ceiling)} ${color.dim('(/brain risk <level> to change)')}`,
        );
        const snapshot = opts.brainRuntime?.getSnapshot();
        const pool = opts.brainSettings?.poolLabels ?? [];
        lines.push(
          `  LLM pool:         ${pool.length > 0 ? color.cyan(pool.join(' → ')) : color.dim('session model (/brain model <ref> or /brain models <refs>)')}${snapshot && pool.length > 1 ? color.dim(` (strategy: ${snapshot.strategy})`) : ''}`,
        );
        if (snapshot?.decisionTimeoutMs) {
          lines.push(`  decision timeout: ${color.cyan(`${snapshot.decisionTimeoutMs}ms`)}`);
        }
        if (snapshot?.humanTimeoutMs) {
          lines.push(`  human timeout:    ${color.cyan(`${snapshot.humanTimeoutMs}ms`)} ${color.dim('(then terminal policy)')}`);
        }
        const councilSeats = opts.brainSettings?.councilLabels ?? [];
        if (councilSeats.length > 0) {
          lines.push(
            `  council:          ${color.cyan(councilSeats.join(', '))}${snapshot ? color.dim(` (minRisk: ${snapshot.council.minRisk}${judgeSummary(snapshot)})`) : ''}`,
          );
        } else if (snapshot) {
          lines.push(`  council:          ${color.dim('disabled (/brain council on + voters)')}`);
        }
        if (opts.brainSettings?.ledgerPath) {
          lines.push(
            `  ledger:           ${color.dim(`${opts.brainSettings.ledgerPath} (/brain ledger to view)`)}`,
          );
        }
        if (opts.brainRuntime) {
          lines.push(color.dim('  setters apply live and persist to the active profile config'));
        }
        const log = opts.getBrainLog?.() ?? [];
        if (log.length === 0) {
          lines.push(color.dim('  no decisions recorded yet this session'));
        } else {
          lines.push(`  recent decisions (${log.length}):`);
          for (const entry of log.slice(-10)) {
            const q =
              entry.question.length > 70 ? `${entry.question.slice(0, 67)}…` : entry.question;
            lines.push(
              `  ${color.dim(fmtAge(entry.at).padEnd(8))} ${entry.kind.padEnd(12)} ${q}${entry.outcome ? color.dim(` → ${entry.outcome}`) : ''}`,
            );
          }
        }
        const msg = lines.join('\n');
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
          color.dim('  Records tiers, every pool target (incl. failures), council votes and tokens.'),
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
        const rate = total > 0 ? color.dim(` (${Math.round((c.hits / total) * 100)}% hit rate)`) : '';
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
        // Monitor settings are live: the host re-tunes the running BrainMonitor
        // from the runtime's onApplied. A threshold change restarts its
        // watchers, so partially-accumulated streaks reset (they were measured
        // against the old threshold); engagement cooldowns are preserved.
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
          color.dim('  Changes apply live; a change restarts the watchers, resetting signal counters.'),
        ].join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      if (subcommand === 'stats') {
        const log = opts.getBrainLog?.() ?? [];
        const counts = new Map<string, number>();
        const councilWarnings: Array<(typeof log)[number]> = [];
        for (const entry of log) {
          // Council integrity warnings ride in the same ring but are not
          // decisions — counting them would inflate 'unattributed'.
          if (entry.kind === 'council_warn') {
            councilWarnings.push(entry);
            continue;
          }
          const tier = (entry as { tier?: string }).tier ?? 'unattributed';
          counts.set(tier, (counts.get(tier) ?? 0) + 1);
        }
        let free = 0;
        let paid = 0;
        for (const [tier, n] of counts) {
          if (DETERMINISTIC_TIER_NAMES.includes(tier)) free += n;
          else if (tier === 'llm' || tier === 'council') paid += n;
        }
        const lines = [color.bold('Brain decision tiers'), ''];
        if (counts.size === 0) {
          lines.push(color.dim('  No decisions recorded yet this session.'));
        } else {
          for (const [tier, n] of [...counts].sort((a, b) => b[1] - a[1])) {
            lines.push(`  ${tier.padEnd(14)} ${color.cyan(String(n))}`);
          }
          const decided = free + paid;
          const pct = decided > 0 ? color.dim(` (${Math.round((free / decided) * 100)}% of decided)`) : '';
          lines.push('');
          lines.push(`  ${'deterministic'.padEnd(14)} ${color.cyan(String(free))}${pct}`);
          lines.push(`  ${'model-backed'.padEnd(14)} ${color.cyan(String(paid))}`);
        }
        const snapshot = opts.brainRuntime?.getSnapshot();
        if (snapshot?.cache.enabled) {
          lines.push('', color.dim(`  cache: ${snapshot.cache.hits} hit / ${snapshot.cache.misses} miss`));
        }
        if (snapshot?.circuit && snapshot.circuit.state !== 'closed') {
          lines.push(color.dim(`  circuit: ${snapshot.circuit.state}`));
        }
        if (councilWarnings.length > 0) {
          lines.push('', color.bold(`  Council panel integrity (${councilWarnings.length})`));
          for (const w of councilWarnings.slice(-3)) {
            lines.push(color.dim(`  ${fmtAge(w.at).padEnd(8)} ${w.outcome}`));
          }
        }
        lines.push('', color.dim(`  Based on the last ${log.length} logged decision(s) of this session.`));
        const msg = lines.join('\n');
        opts.renderer.write(msg);
        return { message: msg };
      }

      const msg = `Unknown subcommand: ${subcommand}. Use /brain, status, stats, risk, mode, model, models, strategy, timeout, human-timeout, council, ledger, rules, heuristics, llm, trace, cache, escalation, monitor, ask, or save (see /brain help).`;
      opts.renderer.writeWarning(msg);
      return { message: msg };
    },
  };
}
