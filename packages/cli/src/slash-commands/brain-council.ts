/**
 * Brain council command parsing, seat grammar, and subcommand execution.
 *
 * @module slash-commands/brain-council
 */

import { parseModelRef } from '@wrongstack/core/agent';
import {
  BUILTIN_COUNCIL_PERSONA_IDS,
  BUILTIN_COUNCIL_PERSONAS,
  type BrainConfigPatch,
  type BrainConfigSnapshot,
} from '@wrongstack/core/execution';
import type { BrainCouncilVoterConfig } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

const COUNCIL_RISKS: ReadonlySet<string> = new Set(['medium', 'high', 'critical']);
export const COUNCIL_DISTINCTNESS: ReadonlySet<string> = new Set(['none', 'model', 'provider']);

const COUNCIL_NUMERIC_OPS: Record<string, string | undefined> = {
  timeout: 'perCallTimeoutMs',
  concurrency: 'maxConcurrency',
  votertokens: 'voterMaxTokens',
  judgetokens: 'judgeMaxTokens',
};

const PERSONA_SHORTHANDS: ReadonlySet<string> = new Set(BUILTIN_COUNCIL_PERSONA_IDS);

export function parseRefEntry(ref: string): { provider?: string; model: string } | null {
  const parsed = parseModelRef(ref);
  const model = parsed.model?.trim();
  if (!model) return null;
  return parsed.provider ? { provider: parsed.provider, model } : { model };
}

export function compactEntry(entry: { provider?: string | undefined; model: string }): string {
  return entry.provider ? `${entry.provider}/${entry.model}` : entry.model;
}

export function judgeSummary(s: {
  judgeLabel: string | undefined;
  judgeIsVoter: boolean;
  council: { judge?: { provider?: string | undefined; model: string } | undefined };
}): string {
  if (!s.judgeLabel) return '';
  const origin = s.council.judge ? '' : ' [derived]';
  return `, judge: ${s.judgeLabel}${origin}${s.judgeIsVoter ? ' ⚠ also a voter' : ''}`;
}

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

export async function handleBrainCouncilSubcommand(
  rest: string[],
  opts: SlashCommandContext,
  applyPatch: (
    patch: BrainConfigPatch,
    describe: (snapshot: BrainConfigSnapshot) => string,
  ) => Promise<{ message: string }>,
): Promise<{ message: string }> {
  const op = (rest[0] ?? '').toLowerCase();
  const councilSummary = (s: BrainConfigSnapshot): string =>
    s.council.enabled
      ? `council ${color.cyan('convened')}: ${s.councilLabels.join(', ')} ${color.dim(`(minRisk: ${s.council.minRisk}${judgeSummary(s)})`)}`
      : `council ${color.dim('disabled')}`;

  if (!op) {
    const snapshot = opts.brainRuntime?.getSnapshot();
    const msg = snapshot
      ? `Brain ${councilSummary(snapshot)}`
      : 'The Brain runtime is not available in this session.';
    opts.renderer.write(msg);
    return { message: msg };
  }
  if (op === 'on' || op === 'off') {
    return applyPatch(
      { council: { enabled: op === 'on' } },
      (s) =>
        `Brain ${councilSummary(s)}${op === 'on' && !s.council.enabled ? ' — needs ≥2 resolvable voters (set /brain council voters or a ≥2-model pool)' : ''}`,
    );
  }
  if (op === 'minrisk') {
    const level = (rest[1] ?? '').toLowerCase();
    if (!COUNCIL_RISKS.has(level)) {
      const msg = 'Usage: /brain council minrisk <medium|high|critical>';
      opts.renderer.writeWarning(msg);
      return { message: msg };
    }
    return applyPatch(
      { council: { minRisk: level as 'medium' | 'high' | 'critical' } },
      (s) =>
        `Brain council risk floor set to ${color.cyan(s.council.minRisk)} — questions at/above it convene the council`,
    );
  }
  if (op === 'voters') {
    const seats = rest.slice(1).map(parseSeat);
    if (seats.length === 0 || seats.some((s) => s === null)) {
      const msg = `Usage: /brain council voters <ref[:<persona>][:veto][:w=N]> [...] — personas: ${BUILTIN_COUNCIL_PERSONA_IDS.join(', ')} (see /brain council personas)`;
      opts.renderer.writeWarning(msg);
      return { message: msg };
    }
    return applyPatch(
      { council: { voters: seats as BrainCouncilVoterConfig[] } },
      councilSummary,
    );
  }
  if (op === 'personas') {
    const lines = [
      'Council decision lenses (built-in):',
      ...BUILTIN_COUNCIL_PERSONAS.map(
        (p) =>
          `  ${color.cyan(p.id.padEnd(15))} ${p.description}${p.defaultVeto ? color.dim(' [veto by default]') : ''}`,
      ),
      color.dim('Any other string is used verbatim as a custom lens instruction.'),
    ];
    const msg = lines.join('\n');
    opts.renderer.write(msg);
    return { message: msg };
  }
  if (op === 'judge') {
    const ref = rest[1];
    if (!ref) {
      const msg = 'Usage: /brain council judge <provider/model | auto>';
      opts.renderer.writeWarning(msg);
      return { message: msg };
    }
    return applyPatch(
      { council: { judge: ref.toLowerCase() === 'auto' ? null : ref } },
      (s) =>
        `Brain council judge: ${color.cyan(s.council.judge ? compactEntry(s.council.judge) : 'auto')}${s.council.judge ? '' : color.dim(judgeSummary(s).replace(/^, judge: /, ' → '))}`,
    );
  }
  if (op === 'quorum' || op === 'approval') {
    const value = Number(rest[1]);
    return applyPatch(
      op === 'quorum' ? { council: { quorum: value } } : { council: { approval: value } },
      (s) =>
        `Brain council ${op} set to ${color.cyan(String(op === 'quorum' ? (s.council.quorum ?? 0.5) : (s.council.approval ?? 0.5)))}`,
    );
  }
  if (op === 'distinctness') {
    const mode = (rest[1] ?? '').toLowerCase();
    if (!COUNCIL_DISTINCTNESS.has(mode)) {
      const msg = 'Usage: /brain council distinctness <none|model|provider>';
      opts.renderer.writeWarning(msg);
      return { message: msg };
    }
    return applyPatch(
      { council: { distinctness: mode as 'none' | 'model' | 'provider' } },
      (s) =>
        `Brain council distinctness set to ${color.cyan(s.council.distinctness)}${mode === 'none' ? color.dim(' — a non-diverse panel will no longer be reported') : ''}`,
    );
  }
  if (COUNCIL_NUMERIC_OPS[op]) {
    const field = COUNCIL_NUMERIC_OPS[op] as
      | 'perCallTimeoutMs'
      | 'maxConcurrency'
      | 'voterMaxTokens'
      | 'judgeMaxTokens';
    const raw = rest[1];
    if (!raw) {
      const msg = `Usage: /brain council ${op} <positive integer | default>`;
      opts.renderer.writeWarning(msg);
      return { message: msg };
    }
    const value = raw.toLowerCase() === 'default' ? null : Number(raw);
    return applyPatch({ council: { [field]: value } }, (s) => {
      const applied = s.council[field];
      return `Brain council ${op} set to ${color.cyan(applied === undefined ? 'default' : String(applied))}`;
    });
  }
  const msg = `Unknown council subcommand: ${op}. Use on, off, minrisk, voters, personas, judge, quorum, approval, distinctness, timeout, concurrency, votertokens, or judgetokens.`;
  opts.renderer.writeWarning(msg);
  return { message: msg };
}
