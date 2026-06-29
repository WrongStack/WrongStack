/**
 * /brain — inspect and steer the session's global Brain.
 *
 * The Brain is the decision layer between the agents and the human:
 * policy arbiter first, LLM decision support second (within a live risk
 * ceiling), human escalation last. The BrainMonitor also engages it
 * proactively on tool-failure streaks and error storms.
 *
 *   /brain                  status — ceiling + recent decisions
 *   /brain status           same
 *   /brain risk <level>     set the autonomy ceiling (off|low|medium|high|all)
 *   /brain ask <question>   consult the Brain directly for a decision
 */
import { randomUUID } from 'node:crypto';
import type { BrainAutoRisk, SlashCommand } from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

const RISK_LEVELS: ReadonlySet<string> = new Set(['off', 'low', 'medium', 'high', 'all']);

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
    argsHint: '[status|risk <level>|ask <question>]',
    description: 'Inspect the Brain, set its autonomy risk ceiling, or ask it for a decision.',
    help: [
      'Usage:',
      '  /brain                 Show Brain status (risk ceiling + recent decisions)',
      '  /brain status          Same as /brain',
      '  /brain risk <level>    Set autonomy ceiling: off | low | medium | high | all',
      '  /brain ask <question>  Consult the Brain directly for decision support',
      '',
      'The Brain decides in three tiers: deterministic policy → LLM (within',
      'the risk ceiling) → human escalation. It also self-activates on tool',
      'failure streaks and error storms, steering agents via mailbox.',
    ].join('\n'),
    async run(args) {
      const trimmed = args.trim();
      const [sub, ...rest] = trimmed.split(/\s+/);
      const subcommand = (sub ?? '').toLowerCase();

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
        lines.push(`${color.bold('Brain')} — policy → LLM → human decision chain`);
        lines.push(
          `  autonomy ceiling: ${color.cyan(ceiling)} ${color.dim('(/brain risk <level> to change)')}`,
        );
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

      const msg = `Unknown subcommand: ${subcommand}. Use /brain, /brain risk <level>, or /brain ask <question>.`;
      opts.renderer.writeWarning(msg);
      return { message: msg };
    },
  };
}
