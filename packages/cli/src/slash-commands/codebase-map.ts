import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import type { SlashCommand } from '@wrongstack/core/types';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import {
  ATLAS_DIR,
  type AtlasFreshness,
  checkProjectAtlasFreshness,
  type EmbedResult,
  type EnrichResult,
  embedProjectFiles,
  enrichProjectConcepts,
  exportProjectAtlasHtml,
  generateRepoMap,
  MAX_REPORTED_DRIFT,
  writeProjectAtlas,
} from '@wrongstack/tools';
import { createCodebaseEmbeddingPort } from '../wiring/codebase-embeddings.js';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/codebase-map` — read and publish the centrality-ranked view of the index.
 *
 * Three jobs, one command, because they are three views of the same data:
 * print the map, write the committable atlas projection, and report whether a
 * previously written atlas still describes the current code.
 */
export function buildCodebaseMapCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'codebase-map',
    category: 'Inspect',
    aliases: ['atlas'],
    description: 'Show the centrality-ranked repository map, or write/check the atlas projection.',
    argsHint:
      '[--write | --check | --enrich | --embed | --export [path]] [--tokens N] [--max-files N]',
    help: [
      'Usage:',
      '  /codebase-map                Print the ranked repository map.',
      '  /codebase-map --tokens 2000  Print it with a larger token budget.',
      `  /codebase-map --write        Write the atlas into ${ATLAS_DIR.replace(/\\/g, '/')}/.`,
      '  /codebase-map --check        Report whether the written atlas has drifted.',
      '  /codebase-map --enrich       Summarise files with a model (concept layer).',
      '  /codebase-map --embed        Build semantic vectors from those summaries.',
      '  /codebase-map --export [path] Write a standalone HTML map (default: atlas.html).',
      '',
      'Ranking is PageRank over the index reference graph (calls, imports, type',
      'references, inheritance) — not filenames. Scores are relative to this',
      'repository only.',
      '',
      'The atlas is a deterministic, committable projection of the index: the',
      'SQLite database stays canonical and machine-local, while the atlas can be',
      'reviewed in a pull request and read on a fresh clone. Regenerating it from',
      'an unchanged index produces byte-identical files.',
      '',
      'The concept layer describes what each file is FOR, in plain English —',
      'something the structural index cannot express. It is the only part of',
      'indexing that spends money, so it is off until you set',
      '`indexing.concepts.enabled: true`. Only files whose bytes changed since',
      'the last pass are re-sent, so the recurring cost is small. Start with',
      '`--enrich --max-files 50` to sample the cost before committing to a full run.',
      '',
      'Run /codebase-reindex first if the index has never been built.',
    ].join('\n'),
    async run(args: string, _ctx: Context) {
      const text = args.trim();
      const write = /(^|\s)--write(\s|$)/.test(text);
      const check = /(^|\s)--check(\s|$)/.test(text);
      const enrich = /(^|\s)--enrich(\s|$)/.test(text);
      const embed = /(^|\s)--embed(\s|$)/.test(text);
      const exportMatch = /(^|\s)--export(?:[= ]([^\s]+))?(\s|$)/.exec(text);
      const maxFilesMatch = /--max-files[= ](\d+)/.exec(text);
      const tokensMatch = /--tokens[= ](\d+)/.exec(text);
      const maxTokens = tokensMatch ? Number(tokensMatch[1]) : undefined;
      const projectRoot = opts.projectRoot;

      try {
        if (embed) {
          // Built on demand rather than at boot: it is an async dynamic import
          // of an optional model runtime, and this is a rare explicit command.
          // `enabled: true` is passed unconditionally because running `--embed`
          // IS the request — the config gate exists to keep the model out of
          // automatic paths, not to veto an explicit one.
          const port = await createCodebaseEmbeddingPort({ enabled: true });
          if (port === undefined) {
            return {
              message: color.yellow(
                'Semantic embeddings are not available. Set ' +
                  `${color.bold('indexing.embeddings.enabled: true')} and install the optional ` +
                  '`@huggingface/transformers` dependency.',
              ),
            };
          }
          opts.renderer.write(color.dim('Embedding files for semantic search…\n'));
          const result = await embedProjectFiles(projectRoot, port, {
            ...(maxFilesMatch ? { maxFiles: Number(maxFilesMatch[1]) } : {}),
          });
          if ('indexed' in result) return { message: noIndexMessage() };
          return { message: renderEmbedding(result) };
        }

        if (enrich) {
          const port = opts.codebaseConceptSummarizer;
          if (port === undefined) {
            return {
              message: color.yellow(
                'The concept layer is not enabled. Set ' +
                  `${color.bold('indexing.concepts.enabled: true')} in your config and restart.`,
              ),
            };
          }
          opts.renderer.write(color.dim('Summarising files for the concept layer…\n'));
          const result = await enrichProjectConcepts(projectRoot, port, {
            ...(maxFilesMatch ? { maxFiles: Number(maxFilesMatch[1]) } : {}),
            subsystems: true,
            onProgress: (done, total) => {
              // One line per completed file would flood the transcript; a
              // coarse heartbeat is enough to show the pass is alive.
              if (done % 25 === 0) opts.renderer.write(color.dim(`  ${done}/${total}\n`));
            },
          });
          if ('indexed' in result) return { message: noIndexMessage() };
          return { message: renderEnrichment(result) };
        }

        if (exportMatch) {
          const html = await exportProjectAtlasHtml(projectRoot, {
            projectName: path.basename(projectRoot),
          });
          if (typeof html !== 'string') return { message: noIndexMessage() };
          const target = path.resolve(projectRoot, exportMatch[2] ?? DEFAULT_EXPORT_FILE);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, html, 'utf8');
          return {
            message:
              `${color.green('✓')} static map written to ${color.bold(target)} ` +
              color.dim(`— ${Math.round(html.length / 1024)} kB, opens with no server`),
          };
        }

        if (check) {
          const report = await checkProjectAtlasFreshness(projectRoot);
          if ('indexed' in report) return { message: noIndexMessage() };
          return { message: renderFreshness(report) };
        }

        if (write) {
          const written = await writeProjectAtlas(projectRoot);
          if ('indexed' in written) return { message: noIndexMessage() };
          return {
            message:
              `${color.green('✓')} atlas written to ${color.bold(written.dir)} ` +
              color.dim(
                `— ${written.fileCount} files · ${written.packageCount} packages · ${written.files.join(', ')}`,
              ),
          };
        }

        const result = await generateRepoMap({ projectRoot, maxTokens });
        if (result.filesCount === 0) {
          return {
            message: color.yellow(
              'No indexable source files found. Run /codebase-reindex if the index has not been built.',
            ),
          };
        }
        return {
          message:
            `${result.map}\n\n` +
            color.dim(
              `${result.filesCount} of ${result.totalFilesScanned} files · ~${result.estimatedTokens} tokens`,
            ),
        };
      } catch (err) {
        return { message: `${color.red('codebase-map failed:')} ${toErrorMessage(err)}` };
      }
    },
  };
}

/** Where `--export` writes when the caller names no path. */
const DEFAULT_EXPORT_FILE = 'atlas.html';

function noIndexMessage(): string {
  return color.yellow(
    `No codebase index for this project yet. Run ${color.bold('/codebase-reindex')} first.`,
  );
}

function renderEmbedding(result: EmbedResult): string {
  const parts = [`${result.embedded} embedded`, `${result.cached} already current`];
  if (result.fromDeclarations > 0) {
    // Worth saying: a vector built from declaration names is a much weaker
    // signal than one built from a summary, so `--enrich` first pays off here.
    parts.push(`${result.fromDeclarations} without a summary`);
  }
  if (result.pruned > 0) parts.push(`${result.pruned} pruned`);
  const lines = [
    `${color.green('✓')} semantic vectors updated ` +
      color.dim(`— ${parts.join(' · ')} · ${result.durationMs}ms`),
  ];
  if (result.providerChanged) {
    lines.push(color.dim('  embedding model changed — every vector was rebuilt'));
  }
  for (const error of result.errors.slice(0, 3)) lines.push(color.dim(`  ${error}`));
  return lines.join('\n');
}

function renderEnrichment(result: EnrichResult): string {
  const parts = [`${result.summarised} summarised`, `${result.cached} already current`];
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.markedStale > 0) parts.push(`${result.markedStale} marked stale`);
  if (result.pruned > 0) parts.push(`${result.pruned} pruned`);
  if (result.subsystems > 0) parts.push(`${result.subsystems} subsystems`);

  const lines = [
    `${color.green('✓')} concept layer updated ` +
      color.dim(`— ${parts.join(' · ')} · ${result.durationMs}ms`),
  ];
  // Failures are per-file and expected at the margins; show a couple so a
  // systematic problem (bad key, wrong model) is visible immediately.
  for (const error of result.errors.slice(0, 3)) lines.push(color.dim(`  ${error}`));
  if (result.errors.length > 3) {
    lines.push(color.dim(`  …and ${result.errors.length - 3} more`));
  }
  return lines.join('\n');
}

function renderFreshness(report: AtlasFreshness): string {
  if (report.fresh) {
    return `${color.green('✓')} atlas is current ${color.dim('— no drift against the index')}`;
  }
  if (report.reason === 'missing') {
    return color.yellow(`No atlas written yet. Run ${color.bold('/codebase-map --write')}.`);
  }
  if (report.reason === 'unreadable' || report.reason === 'schema') {
    return color.yellow(
      `Atlas manifest is ${report.reason === 'schema' ? 'from an older schema' : 'unreadable'}. ` +
        `Run ${color.bold('/codebase-map --write')} to regenerate it.`,
    );
  }

  const lines = [`${color.yellow('⚠')} atlas has drifted from the index`];
  if (report.changed.length > 0) {
    lines.push(color.dim(`  changed (${report.changed.length}):`));
    for (const file of report.changed) lines.push(`    ${file}`);
    if (report.changed.length === MAX_REPORTED_DRIFT) lines.push(color.dim('    …'));
  }
  if (report.removed.length > 0) {
    lines.push(color.dim(`  no longer indexed (${report.removed.length}):`));
    for (const file of report.removed) lines.push(`    ${file}`);
  }
  if (report.changed.length === 0 && report.removed.length === 0) {
    // The digest covers the whole repository, so files outside the atlas can
    // drift without any atlas file changing.
    lines.push(color.dim('  files outside the atlas changed'));
  }
  lines.push(color.dim(`  run ${'/codebase-map --write'} to refresh`));
  return lines.join('\n');
}
