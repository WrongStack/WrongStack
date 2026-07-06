import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  type BenchReport,
  type BenchSuite,
  collectCellPredictions,
  computeToolManifestHash,
  createLocalManifestSuite,
  createPolyglotSuite,
  createSwebenchSuite,
  type BenchTask,
  type GradeResult,
  type ModelCell,
  gradeLocalManifest,
  gradePolyglot,
  gradeSwebench,
  loadBenchConfig,
  readSummary,
  renderMarkdownReport,
  reportHeaderLine,
  runBenchmark,
  writeJsonArtifacts,
  writePredictionsJsonl,
} from '@wrongstack/bench';
import { color } from '@wrongstack/core';
import { CLI_VERSION } from '../../version.js';
import type { SubcommandDeps, SubcommandHandler } from '../index.js';

/**
 * `wstack bench` — run model-independent agentic benchmarks (local manifests,
 * Aider polyglot, SWE-bench Verified) with deterministic graders and a harness
 * fingerprint.
 *
 *   wstack bench run    --suite <id> --models <config> [...]
 *   wstack bench report <dir>
 *   wstack bench list   [--models <config>]
 */
export const benchCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'run':
      return benchRun(rest, deps);
    case 'report':
      return benchReport(rest, deps);
    case 'list':
      return benchList(rest, deps);
    default:
      printUsage(deps);
      return sub === undefined ? 0 : 1;
  }
};

function printUsage(deps: SubcommandDeps): void {
  deps.renderer.write(
    [
      color.bold('wstack bench') + ' — model-independent agentic benchmarks',
      '',
      '  run     Run a suite across a model matrix and write a report',
      '  report  Re-render report.md from a finished run directory',
      '  list    Show available suites and configured model cells',
      '',
      color.dim('Examples:'),
      color.dim(
        '  wstack bench run --suite polyglot --polyglot-dir ./polyglot --models bench.config.json --limit 5',
      ),
      color.dim(
        '  wstack bench run --suite local --suite-dir ./evals --models bench.config.json',
      ),
      color.dim('  wstack bench report ./bench-results/2026-06-14T10-00-00'),
      '',
    ].join('\n') + '\n',
  );
}

// Flags arrive already-parsed in `deps.flags` (the top-level CLI parser strips
// `--name value` pairs out of the positional args before the subcommand runs).
// `args` therefore holds only positionals (the `run`/`report`/`list` verb and,
// for `report`, the run directory).
function flagStr(deps: SubcommandDeps, name: string): string | undefined {
  const v = deps.flags?.[name];
  return typeof v === 'string' ? v : undefined;
}
function flagBool(deps: SubcommandDeps, name: string): boolean {
  const v = deps.flags?.[name];
  return v === true || v === 'true';
}

/** Resolve the wstack CLI entry the runner spawns. */
async function resolveWstackEntry(): Promise<string> {
  try {
    const req = createRequire(import.meta.url);
    const pkgPath = req.resolve('@wrongstack/cli/package.json');
    const entry = path.join(path.dirname(pkgPath), 'dist', 'index.js');
    await fs.access(entry);
    return entry;
  } catch {
    return process.argv[1] ?? '';
  }
}

async function benchRun(_args: string[], deps: SubcommandDeps): Promise<number> {
  const suiteId = flagStr(deps, 'suite') ?? 'polyglot';
  const modelsPath = flagStr(deps, 'models') ?? 'bench.config.json';
  const limitRaw = flagStr(deps, 'limit');
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : undefined;
  const outBase = flagStr(deps, 'out') ?? 'bench-results';

  let config: Awaited<ReturnType<typeof loadBenchConfig>>;
  try {
    config = await loadBenchConfig(path.resolve(deps.cwd, modelsPath));
  } catch (err) {
    deps.renderer.writeError(toErrorMessage(err));
    return 1;
  }
  const concurrencyRaw = flagStr(deps, 'concurrency');
  if (concurrencyRaw) {
    const c = Number.parseInt(concurrencyRaw, 10);
    if (c > 0) config.concurrency = c;
  }

  // The output directory is computed up front: the SWE-bench grader writes
  // per-instance predictions under it during the run.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.resolve(deps.cwd, outBase, stamp);
  const predictionsDir = path.join(outDir, 'predictions');

  // Build suite + grader.
  let suite: BenchSuite;
  let grade: (a: {
    workdir: string;
    task: BenchTask;
    cell: ModelCell;
    timeoutMs: number;
  }) => Promise<GradeResult>;
  let isSwebench = false;
  if (suiteId === 'polyglot') {
    const polyglotDir = flagStr(deps, 'polyglot-dir');
    if (!polyglotDir) {
      deps.renderer.writeError('--polyglot-dir <path> is required for the polyglot suite.');
      return 1;
    }
    const languagesRaw = flagStr(deps, 'languages');
    const languages = languagesRaw
      ? languagesRaw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    suite = createPolyglotSuite({ polyglotDir: path.resolve(deps.cwd, polyglotDir), languages });
    grade = (a) => gradePolyglot(a);
  } else if (suiteId === 'swebench') {
    isSwebench = true;
    const datasetDir = flagStr(deps, 'dataset-dir');
    const docker = flagBool(deps, 'docker');
    suite = createSwebenchSuite({
      datasetDir: datasetDir ? path.resolve(deps.cwd, datasetDir) : undefined,
      docker,
    });
    // Inline Docker grading is not bundled (the official harness owns it); we
    // export conformant predictions. Pass an `externalGrade` here to grade live.
    grade = (a) => gradeSwebench({ ...a, predictionsDir });
  } else if (suiteId === 'local' || suiteId === 'manifest') {
    const suiteDirRaw = flagStr(deps, 'suite-dir');
    const manifestRaw = flagStr(deps, 'manifest');
    if (!suiteDirRaw && !manifestRaw) {
      deps.renderer.writeError(
        '--suite-dir <path> or --manifest <file> is required for the local suite.',
      );
      return 1;
    }
    const manifestFile = manifestRaw ? path.resolve(deps.cwd, manifestRaw) : undefined;
    const suiteDir = suiteDirRaw
      ? path.resolve(deps.cwd, suiteDirRaw)
      : path.dirname(manifestFile!);
    suite = createLocalManifestSuite({ suiteDir, manifestFile });
    grade = (a) => gradeLocalManifest(a);
  } else {
    deps.renderer.writeError(`unknown suite "${suiteId}" (expected: polyglot | swebench | local)`);
    return 1;
  }

  const tools = deps.toolRegistry?.list() ?? [];
  const toolNames = tools.map((t) => t.name);
  const toolManifestHash = computeToolManifestHash(tools);
  const wstackEntry = await resolveWstackEntry();

  deps.renderer.writeInfo(`Running ${suiteId} across ${config.cells.length} model(s)…`);

  let report: BenchReport;
  try {
    report = await runBenchmark({
      suite,
      grade,
      config,
      cliVersion: CLI_VERSION,
      toolNames,
      toolManifestHash,
      nodeBin: process.execPath,
      wstackEntry,
      limit,
      onProgress: (msg) => deps.renderer.write(color.dim(msg) + '\n'),
    });
  } catch (err) {
    deps.renderer.writeError(toErrorMessage(err));
    return 1;
  }

  await writeJsonArtifacts(outDir, report);
  const md = renderMarkdownReport(report);
  await fs.writeFile(path.join(outDir, 'report.md'), md, 'utf8');

  deps.renderer.write('\n' + md + '\n');

  // SWE-bench: merge the per-instance prediction files into one conformant
  // predictions.jsonl per cell, ready for the official harness.
  if (isSwebench) {
    for (const cell of config.cells) {
      const preds = await collectCellPredictions(predictionsDir, cell.label);
      if (preds.length === 0) continue;
      const file = await writePredictionsJsonl(outDir, cell.label, preds);
      deps.renderer.writeInfo(`Predictions for "${cell.label}" → ${file}`);
    }
    deps.renderer.writeInfo(
      'Grade with the official SWE-bench harness: ' +
        'python -m swebench.harness.run_evaluation --predictions_path <file> --run_id <id>',
    );
  }

  deps.renderer.writeInfo(`Report written to ${path.join(outDir, 'report.md')}`);
  return 0;
}

async function benchReport(args: string[], deps: SubcommandDeps): Promise<number> {
  const dir = args.find((a) => !a.startsWith('-'));
  if (!dir) {
    deps.renderer.writeError('Usage: wstack bench report <run-directory>');
    return 1;
  }
  const outDir = path.resolve(deps.cwd, dir);
  let summary: Awaited<ReturnType<typeof readSummary>>;
  try {
    summary = await readSummary(outDir);
  } catch (err) {
    deps.renderer.writeError(
      `cannot read summary.json in ${outDir}: ${toErrorMessage(err)}`,
    );
    return 1;
  }
  const md = renderMarkdownReport(summary);
  await fs.writeFile(path.join(outDir, 'report.md'), md, 'utf8');
  deps.renderer.write('\n' + md + '\n');
  return 0;
}

async function benchList(_args: string[], deps: SubcommandDeps): Promise<number> {
  deps.renderer.write(color.bold('Suites\n'));
  deps.renderer.write(
    '  polyglot  ' + color.dim('Aider polyglot (edit accuracy) — Phase 1, Docker-free\n'),
  );
  deps.renderer.write(
    '  swebench  ' + color.dim('SWE-bench Verified (end-to-end) — Phase 2, Docker-gated\n'),
  );
  deps.renderer.write(
    '  local     ' + color.dim('Project-defined manifest tasks with command/file graders\n'),
  );

  const modelsPath = flagStr(deps, 'models');
  if (modelsPath) {
    try {
      const config = await loadBenchConfig(path.resolve(deps.cwd, modelsPath));
      deps.renderer.write('\n' + color.bold('Model cells\n'));
      for (const cell of config.cells) {
        deps.renderer.write(
          `  ${cell.label.padEnd(16)} ${color.dim(`${cell.provider}/${cell.model}`)}\n`,
        );
      }
      const tools = deps.toolRegistry?.list() ?? [];
      const fp = reportHeaderLine({
        cliVersion: CLI_VERSION,
        toolNames: tools.map((t) => t.name),
        maxIterations: config.maxIterations,
        yolo: true,
        subsetId: '(computed at run time)',
        toolManifestHash: computeToolManifestHash(tools),
        hash: '(computed at run time)',
      });
      deps.renderer.write('\n' + color.dim(`Harness: ${fp}`) + '\n');
    } catch (err) {
      deps.renderer.writeError(toErrorMessage(err));
      return 1;
    }
  }
  return 0;
}
