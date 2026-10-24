/**
 * `wstack skill-suggest` — inspect and tune the TypeSafe skill suggester.
 *
 * The suggester runs inside a turn and its output is one line of system prompt,
 * which makes it almost impossible to observe in place: you see the agent load
 * a skill, not why. Two modes make it inspectable:
 *
 *   wstack skill-suggest "<request>"        one request, both passes, all numbers
 *   wstack skill-suggest --eval cases.jsonl labeled set, scored
 *   wstack skill-suggest --eval cases.jsonl --sweep   …plus a threshold table
 *
 * Both work whether or not `skills.suggest.enabled` is on — previewing is how
 * you decide whether to turn it on. Both need a TypeSafe API key, and both send
 * request text to TypeSafe, so `--eval` prints what it is about to spend before
 * it spends it.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Config } from '@wrongstack/contracts/types';
import {
  buildSuggesterFromConfig,
  parseEvalJsonl,
  type SkillSuggester,
  type SkillSuggestionTrace,
  type SuggestionScore,
  scoreSuggestions,
  skillPromptExclusionReasons,
  sweepThresholds,
  unknownGoldLabels,
} from '@wrongstack/core/skills';
import { estimateTypeSafeCostUsd } from '@wrongstack/core/typesafe';
import { color } from '@wrongstack/core/utils';
import type { SubcommandHandler } from '../contracts.js';

/** Threshold values the sweep table walks. */
const SWEEP_STEPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6] as const;

/** Concurrency for an eval run. Small: gentle on rate limits, still minutes. */
const EVAL_WORKERS = 4;

const USAGE = [
  'Usage:',
  '  wstack skill-suggest "<request>"              preview one request',
  '  wstack skill-suggest --eval <file.jsonl>      score a labeled set',
  '  wstack skill-suggest --eval <file.jsonl> --sweep   …and sweep thresholds',
  '',
  'Eval file: one JSON object per line.',
  '  {"text": "cut a release branch for 1.2.0", "gold": "git-flow"}',
  '  {"text": "explain what a monad is"}            // nothing covers it',
  '',
  'Both modes send request text to the configured TypeSafe/OpenRouter route.',
  'Configure its key with `wstack typesafe login` and verify with `wstack typesafe test`.',
].join('\n');

export const skillSuggestCmd: SubcommandHandler = async (args, deps) => {
  const write = (line: string): void => deps.renderer.write(`${line}\n`);

  // Flags arrive PARSED in `deps.flags`, not in `args` — the CLI's top-level
  // `parseArgs` strips every `--flag` before a handler sees its positionals.
  // Reading them out of `args` looked correct in a unit test that calls this
  // handler directly, and rendered usage for every real invocation.
  const flags = deps.flags ?? {};
  const evalFile = typeof flags['eval'] === 'string' ? flags['eval'] : undefined;
  const sweep = flags['sweep'] === true || flags['sweep'] === 'true';
  const positional = args.filter((a) => !a.startsWith('-'));

  if (flags['help'] === true || flags['h'] === true) {
    write(USAGE);
    return 0;
  }
  if (!evalFile && positional.length === 0) {
    write(USAGE);
    return 1;
  }

  const availableToolNames = deps.toolRegistry?.list().map((tool) => tool.name);
  const built = buildSuggesterFromConfig({
    config: deps.config,
    skillLoader: deps.skillLoader,
    availableToolNames,
  });
  if ('error' in built) {
    write(color.red(`skill-suggest: ${built.error}`));
    return 1;
  }
  const { suggester } = built;

  if (evalFile) {
    return runEval({
      file: path.resolve(deps.cwd, evalFile),
      sweep,
      suggester,
      rosterNames:
        (await deps.skillLoader?.list())
          ?.filter((skill) => skillPromptExclusionReasons(skill, availableToolNames).length === 0)
          .map((skill) => skill.name) ?? [],
      write,
    });
  }

  const request = positional.join(' ').trim();
  if (!request) {
    write(color.red('skill-suggest: give a request to preview, or --eval <file>'));
    return 1;
  }
  return runPreview({ request, suggester, write, config: deps.config });
};

interface PreviewInput {
  request: string;
  suggester: SkillSuggester;
  write: (line: string) => void;
  /** Only the two thresholds are read, to echo the same cut the live path uses. */
  config: Pick<Config, 'skills'>;
}

async function runPreview(input: PreviewInput): Promise<number> {
  const { write } = input;
  const gateThreshold = input.config.skills?.suggest?.gateThreshold ?? 0.3;
  const fitsThreshold = input.config.skills?.suggest?.fitsThreshold ?? 0.3;

  const started = Date.now();
  const trace = await input.suggester.explain(input.request);
  const elapsed = Date.now() - started;

  write('');
  write(color.dim(`  "${truncate(input.request, 72)}"`));
  write('');

  if (trace.stop === 'error') {
    // The live path swallows this deliberately; the preview exists to show it.
    write(color.red('  the suggester failed — no answer to show'));
    write(color.dim('  check the API key, the endpoint, and network reachability'));
    return 1;
  }
  if (trace.stop === 'roster-too-small') {
    write(color.yellow('  roster has fewer than 2 visible skills — nothing to choose between'));
    return 0;
  }

  write(
    `  ${label('gate')} ${bar(trace.gate)} ${pct(trace.gate)} ${verdictWord(trace.gate >= gateThreshold, gateThreshold)}`,
  );
  for (const [key, value] of Object.entries(trace.gateValues)) {
    const inverted = key === 'prose_suffices';
    write(
      color.dim(`      ${key.padEnd(34)} ${pct(value)}${inverted ? ' (counts inverted)' : ''}`),
    );
  }
  write('');

  if (trace.ranked.length > 0) {
    write(`  ${label('pass 1 — ranked')}`);
    for (const entry of trace.ranked.slice(0, 5)) {
      const shortlisted = trace.shortlist.includes(entry.name);
      const line = `      ${pct(entry.probability).padStart(4)}  ${entry.name}`;
      write(shortlisted ? line : color.dim(line));
    }
    write('');
  }

  if (trace.shortlist.length > 0 && Object.keys(trace.fits).length > 0) {
    write(`  ${label('pass 2 — fits')}`);
    for (const name of trace.shortlist) {
      const value = trace.fits[name];
      const marker = name === trace.winner ? color.cyan(' ← choice') : '';
      write(`      ${(value === undefined ? '—' : pct(value)).padStart(4)}  ${name}${marker}`);
    }
    write('');
  }

  const suggestion = trace.suggestion;
  if (suggestion) {
    write(`  ${color.green('suggests')} ${suggestion.name}`);
  } else {
    write(
      `  ${color.yellow('suggests nothing')} ${color.dim(`(${stopReason(trace, gateThreshold, fitsThreshold)})`)}`,
    );
  }
  write(
    color.dim(
      `  ${trace.requests} request(s), ${elapsed}ms, ${trace.inputTokens} input tokens ` +
        `(~$${estimateTypeSafeCostUsd(trace.inputTokens).toFixed(6)})` +
        (trace.models.length > 0 ? ` · answered by ${trace.models.join(', ')}` : ''),
    ),
  );
  write('');
  return 0;
}

function stopReason(
  trace: SkillSuggestionTrace,
  gateThreshold: number,
  fitsThreshold: number,
): string {
  switch (trace.stop) {
    case 'gate':
      return `gate ${pct(trace.gate)} below ${pct(gateThreshold)}`;
    case 'fits': {
      const best = Math.max(...Object.values(trace.fits), 0);
      return `best fit ${pct(best)} below ${pct(fitsThreshold)}`;
    }
    case 'wide-failed':
    case 'rerank-failed':
      return 'the model returned no usable answer for that pass';
    default:
      return trace.stop;
  }
}

interface EvalInput {
  file: string;
  sweep: boolean;
  suggester: PreviewInput['suggester'];
  rosterNames: string[];
  write: (line: string) => void;
}

async function runEval(input: EvalInput): Promise<number> {
  const { write } = input;
  let source: string;
  try {
    source = await fs.readFile(input.file, 'utf8');
  } catch {
    write(color.red(`skill-suggest: cannot read ${input.file}`));
    return 1;
  }

  const { requests, errors } = parseEvalJsonl(source);
  for (const error of errors) {
    // Reported, never skipped silently: a dropped line changes the denominator
    // every rate below is computed over.
    write(color.yellow(`  line ${error.line}: ${error.reason}`));
  }
  if (errors.length > 0) return 1;
  if (requests.length === 0) {
    write(color.red('skill-suggest: no usable cases in that file'));
    return 1;
  }

  const unknown = unknownGoldLabels(requests, input.rosterNames);
  if (unknown.length > 0) {
    // A label naming a skill that no longer exists can never be matched, so it
    // counts as a wrong suggestion on every run for a reason that has nothing
    // to do with the suggester.
    write(color.yellow(`  gold labels not in this roster: ${unknown.join(', ')}`));
    write(color.yellow('  those cases can never be scored correct — fix or remove them'));
    write('');
    return 1;
  }
  if (new Set(requests.map((request) => request.text)).size !== requests.length) {
    write(color.red('skill-suggest: duplicate request text — remove duplicates before evaluation'));
    return 1;
  }

  const covered = requests.filter((r) => r.gold).length;
  write(
    color.dim(
      `  ${requests.length} cases (${covered} covered, ${requests.length - covered} uncovered)` +
        ` → up to ${requests.length * 2} TypeSafe requests`,
    ),
  );
  write('');

  const traces = await mapWithConcurrency(requests, EVAL_WORKERS, async (request) => ({
    request,
    // A sweep has to know what pass 2 WOULD have said below the configured
    // gate, and a trace that stopped at the gate cannot answer that.
    trace: await input.suggester.explain(request.text, undefined, { alwaysRerank: input.sweep }),
  }));

  // What this run actually cost, and which model version produced the numbers
  // a threshold is about to be chosen from. `jev-latest` is an alias: a sweep
  // table that cannot name its version is a calibration with no date on it.
  const inputTokens = traces.reduce((sum, row) => sum + row.trace.inputTokens, 0);
  const models = [...new Set(traces.flatMap((row) => row.trace.models))];
  write(
    color.dim(
      `  spent ${inputTokens} input tokens (~$${estimateTypeSafeCostUsd(inputTokens).toFixed(4)})` +
        (models.length > 0 ? ` · answered by ${models.join(', ')}` : ''),
    ),
  );
  if (models.length > 1) {
    write(
      color.yellow(
        '  Two model versions answered this run — the alias moved mid-run; re-run before trusting the sweep.',
      ),
    );
  }
  write('');

  const failed = traces.filter(
    (row) => !['suggested', 'gate', 'fits'].includes(row.trace.stop),
  ).length;
  if (failed > 0) {
    write(
      color.yellow(
        `  ${failed} case(s) were not evaluated — no accuracy score or threshold sweep produced`,
      ),
    );
    return 1;
  }

  const byText = new Map(traces.map((row) => [row.request.text, row.trace]));
  const { score, cases } = scoreSuggestions(
    requests,
    (request) => byText.get(request.text)?.suggestion?.name,
  );
  writeScore(write, score);

  const misses = cases.filter((c) => c.outcome === 'wrong' || c.outcome === 'needless');
  if (misses.length > 0) {
    write('');
    write(`  ${label('worst cases')}`);
    for (const miss of misses.slice(0, 10)) {
      const wanted = miss.request.gold ?? '(nothing)';
      write(color.dim(`      "${truncate(miss.request.text, 52)}"`));
      write(`        wanted ${wanted}, got ${color.red(miss.suggested ?? '(nothing)')}`);
    }
    if (misses.length > 10) write(color.dim(`      …and ${misses.length - 10} more`));
  }

  if (input.sweep) {
    write('');
    write(`  ${label('threshold sweep')}`);
    write(
      color.dim('      gate  fits  correct   wrong  missed  needless    (of covered / uncovered)'),
    );
    const rows = sweepThresholds(traces, SWEEP_STEPS, SWEEP_STEPS);
    for (const row of rows) {
      const s = row.score;
      write(
        `      ${row.gateThreshold.toFixed(1)}   ${row.fitsThreshold.toFixed(1)}   ` +
          `${pct(s.correct).padStart(6)}  ${pct(s.wrongSuggestion).padStart(6)}  ` +
          `${pct(s.missed).padStart(6)}  ${pct(s.needless).padStart(8)}`,
      );
    }
    write('');
    write(
      color.dim(
        '      These score the SUGGESTER against your labels, not what the agent then loads.',
      ),
    );
    write(
      color.dim(
        '      Raising gate cuts needless suggestions and adds misses. Pick the one that costs you more.',
      ),
    );
  }
  write('');
  return 0;
}

function writeScore(write: (line: string) => void, score: SuggestionScore): void {
  write(`  ${label('covered')} ${color.dim(`(${score.covered} cases)`)}`);
  write(`      correct            ${pct(score.correct)}`);
  write(`      wrong suggestion   ${pct(score.wrongSuggestion)}`);
  write(`      suggested nothing  ${pct(score.missed)}`);
  write(`  ${label('uncovered')} ${color.dim(`(${score.uncovered} cases)`)}`);
  write(`      needless           ${pct(score.needless)}`);
}

/** Bounded-concurrency map; keeps an eval to minutes without a rate-limit storm. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function bar(value: number): string {
  const filled = Math.round(value * 10);
  return color.dim(`[${'#'.repeat(filled)}${'.'.repeat(10 - filled)}]`);
}

function label(text: string): string {
  return color.bold(text);
}

function verdictWord(passed: boolean, threshold: number): string {
  return passed
    ? color.green(`≥ ${pct(threshold)} — continue`)
    : color.yellow(`< ${pct(threshold)} — stop here`);
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
