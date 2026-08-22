/**
 * Model benchmark subcommand handler for `wrongstack modeldiag bench`.
 *
 * @module subcommands/handlers/modeldiag-bench
 */

import { color, toErrorMessage } from '@wrongstack/core/utils';
import type { makeProviderFromConfig } from '@wrongstack/providers';
import type { SubcommandDeps } from '../contracts.js';
import { createProviderForId, type ModelDiagConfig } from './modeldiag-eval.js';
import { type CacheProvider, fmtMs, rankModels, roleCat, scoreBar } from './modeldiag-profiles.js';

export async function runModeldiagBench(
  args: string[],
  deps: SubcommandDeps,
  providers: CacheProvider[],
  config: ModelDiagConfig,
  hasKey: (pid: string) => boolean,
): Promise<number> {
  const writeLine = (line = '') => {
    deps.renderer.write(`${line}\n`);
  };

  const benchArgs = args.slice(1);
  if (benchArgs.length < 2) {
    writeLine(
      `${color.amber('Usage:')} wstack modeldiag bench <role> "<test prompt>" [--providers=p1,p2]`,
    );
    writeLine();
    writeLine(
      color.dim(
        'Example: wstack modeldiag bench verify "Write a function that checks if a string is a palindrome"',
      ),
    );
    writeLine(
      color.dim(
        'Tests the top 5 candidate models for the role with your prompt and reports results.',
      ),
    );
    writeLine(color.dim('Add --providers=anthropic,google to test across multiple providers.'));
    return 0;
  }

  const providersEqIdx = benchArgs.findIndex((a) => a.startsWith('--providers='));
  let providerFilter: string[] | undefined;
  if (providersEqIdx >= 0) {
    const rawFilter = benchArgs[providersEqIdx]?.replace('--providers=', '').split(',');
    if (rawFilter) {
      providerFilter = rawFilter.map((s) => s.trim()).filter(Boolean);
      benchArgs.splice(providersEqIdx, 1);
    }
  } else {
    const rawFilter = deps.flags?.['providers'] ?? deps.flags?.['provider'];
    if (typeof rawFilter === 'string') {
      providerFilter = rawFilter
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  const benchRole = benchArgs[0];
  if (!benchRole) {
    writeLine(
      `${color.amber('No benchmark role specified')}. Usage: wstack diag bench <role> [prompt]`,
    );
    return 1;
  }
  const benchPrompt = benchArgs.slice(1).join(' ');

  const cat = roleCat(benchRole);
  const candidates = rankModels(providers, hasKey, cat, 5);

  if (candidates.length === 0) {
    writeLine(
      `${color.amber('No candidate models found')} for role "${benchRole}" (category: ${cat}).`,
    );
    return 0;
  }

  let targetCandidates: typeof candidates;
  if (providerFilter && providerFilter.length > 0) {
    targetCandidates = candidates.filter((c) => providerFilter.includes(c.provider));
    if (targetCandidates.length === 0) {
      writeLine(
        `${color.amber('No candidates match the specified providers')}: ${providerFilter.join(', ')}`,
      );
      writeLine(
        `Candidate providers: ${[...new Set(candidates.map((c) => c.provider))].join(', ')}`,
      );
      return 0;
    }
  } else {
    targetCandidates = candidates;
  }

  writeLine(
    `${color.bold('Model Benchmark')} — ${color.amber(benchRole)} ${color.dim(`(category: ${cat})`)}`,
  );
  writeLine(
    `${color.dim('Prompt:')} "${benchPrompt.slice(0, 120)}${benchPrompt.length > 120 ? '…' : ''}"`,
  );
  writeLine();

  writeLine(
    `  ${color.dim('#  model'.padEnd(52))} ${color.dim('score'.padEnd(12))} ${color.dim('latency'.padEnd(10))} ${color.dim('tokens'.padEnd(14))} ${color.dim('first line')}`,
  );
  writeLine(`  ${color.dim('─'.repeat(108))}`);

  const providerInstances = new Map<string, ReturnType<typeof makeProviderFromConfig>>();
  for (const pid of [...new Set(targetCandidates.map((c) => c.provider))]) {
    const prov = createProviderForId(pid, config);
    if (prov) providerInstances.set(pid, prov);
  }

  let idx = 0;
  for (const c of targetCandidates.slice(0, 20)) {
    idx++;
    const label = `${idx}`.padStart(2);
    const modelKey = `${c.provider}/${c.model}`;
    const prov = providerInstances.get(c.provider);

    if (!prov) {
      writeLine(
        `  ${label} ${color.red(modelKey.padEnd(50))} ${scoreBar(c.score, 110).slice(0, 11)}  ${color.red('NO PROVIDER')}`,
      );
      continue;
    }

    try {
      const start = Date.now();
      const resp = await prov.complete(
        {
          model: c.model,
          messages: [{ role: 'user', content: [{ type: 'text' as const, text: benchPrompt }] }],
          maxTokens: 256,
        },
        { signal: AbortSignal.timeout(30_000) },
      );
      const latency = Date.now() - start;
      const firstText: string =
        resp.content[0] && 'text' in resp.content[0]
          ? (resp.content[0] as { text: string }).text
          : '';
      const firstLineClean = firstText.replace(/\n/g, ' ').slice(0, 80) || color.dim('(empty)');

      const provColor = c.provider === config.provider ? color.green : color.cyan;
      const usage = resp.usage;
      writeLine(
        `  ${label} ${provColor(modelKey.padEnd(50))} ${scoreBar(c.score, 110).slice(0, 11)}  ${color.amber(fmtMs(latency).padEnd(8))} ${color.dim(`in${usage?.input ?? '?'}/out${usage?.output ?? '?'}`.padEnd(12))} ${firstLineClean}`,
      );
    } catch (err) {
      const errMsg = toErrorMessage(err);
      writeLine(
        `  ${label} ${color.red(modelKey.padEnd(50))} ${scoreBar(c.score, 110).slice(0, 11)}  ${color.red('FAILED')}    ${color.dim(errMsg.slice(0, 40))}`,
      );
    }
  }

  const testedProviders = [...new Set(targetCandidates.map((c) => c.provider))];
  writeLine();
  writeLine(
    color.dim(
      `Tested ${idx} model(s) across ${testedProviders.length} provider(s): ${testedProviders.join(', ')}.`,
    ),
  );
  writeLine(color.dim('Pin the best: wstack setmodel set <role> <provider>/<model>'));
  return 0;
}
