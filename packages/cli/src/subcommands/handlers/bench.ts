import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import {
  type BenchConfig,
  type BenchReport,
  type BenchSuite,
  type BenchTask,
  collectCellPredictions,
  compareReports,
  computeToolManifestHash,
  createCoreSuite,
  createLocalManifestSuite,
  createPolyglotSuite,
  createSmokeSuite,
  createSwebenchSuite,
  type GradeResult,
  gradeLocalManifest,
  gradePolyglot,
  gradeSwebench,
  loadBenchConfig,
  type ModelCell,
  mineTranscript,
  readRunDir,
  renderComparisonMarkdown,
  renderMarkdownReport,
  reportHeaderLine,
  runBenchmark,
  writeJsonArtifacts,
  writePredictionsJsonl,
} from '@wrongstack/bench';
import { color, toErrorMessage } from '@wrongstack/core/utils';
import { CLI_VERSION } from '../../version.js';
import type { SubcommandDeps, SubcommandHandler } from '../contracts.js';
import { resolveBenchRunConfig } from './bench-run-config.js';

/**
 * `wstack bench` — run model-independent agentic benchmarks (bundled smoke,
 * local manifests, Aider polyglot, SWE-bench Verified) with deterministic
 * graders and a harness fingerprint.
 *
 *   wstack bench run     --suite <id> [--cell spec | --models config] [...]
 *   wstack bench mine    --transcript <session.jsonl> [--out <eval-dir>]
 *   wstack bench report  <dir>
 *   wstack bench compare <baseline-dir> <candidate-dir>
 *   wstack bench list    [--models <config>]
 */
export const benchCmd: SubcommandHandler = async (args, deps) => {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case 'run':
      return benchRun(rest, deps);
    case 'report':
      return benchReport(rest, deps);
    case 'compare':
      return benchCompare(rest, deps);
    case 'list':
      return benchList(rest, deps);
    case 'mine':
      return benchMine(rest, deps);
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
      '  run      Run a suite across a model matrix and write a report',
      '  compare  Diff two finished run directories (fingerprint-aware)',
      '  mine     Copy a real session transcript and draft trace-eval cases',
      '  report   Re-render report.md from a finished run directory',
      '  list     Show available suites and configured model cells',
      '',
      color.dim('Examples:'),
      color.dim('  wstack bench run --cell anthropic/claude-sonnet-4-6,openai/gpt-5.4'),
      color.dim('  wstack bench run --suite smoke --cell zai-coding-plan/glm-5.3-flash'),
      color.dim(
        '  wstack bench run --suite polyglot --polyglot-dir ./polyglot --models bench.config.json --limit 5',
      ),
      color.dim('  wstack bench run --suite local --suite-dir ./evals --models bench.config.json'),
      color.dim('  wstack bench compare ./bench-results/<baseline> ./bench-results/<candidate>'),
      color.dim('  wstack bench mine --transcript ./session.jsonl --out ./evals'),
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
  const suiteId = flagStr(deps, 'suite') ?? 'core';
  const limitRaw = flagStr(deps, 'limit');
  const limit = limitRaw ? Math.max(1, Number.parseInt(limitRaw, 10)) : undefined;
  const outBase = flagStr(deps, 'out') ?? 'bench-results';

  let config: BenchConfig;
  try {
    config = await resolveBenchRunConfig({
      suiteId,
      cwd: deps.cwd,
      flags: deps.flags,
      savedProvider: deps.config?.provider,
      savedModel: deps.config?.model,
    });
  } catch (err) {
    deps.renderer.writeError(toErrorMessage(err));
    return 1;
  }
  const concurrencyRaw = flagStr(deps, 'concurrency');
  if (concurrencyRaw) {
    const c = Number.parseInt(concurrencyRaw, 10);
    if (c > 0) config.concurrency = c;
  }
  const repeatsRaw = flagStr(deps, 'repeats');
  if (repeatsRaw) {
    const r = Number.parseInt(repeatsRaw, 10);
    if (!Number.isFinite(r) || r <= 0) {
      deps.renderer.writeError('--repeats must be a positive integer.');
      return 1;
    }
    config.repeats = r;
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
  if (suiteId === 'core') {
    suite = createCoreSuite();
    grade = (a) => gradeLocalManifest(a);
  } else if (suiteId === 'smoke') {
    suite = createSmokeSuite();
    grade = (a) => gradeLocalManifest(a);
  } else if (suiteId === 'polyglot') {
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
    deps.renderer.writeError(
      `unknown suite "${suiteId}" (expected: core | smoke | local | polyglot | swebench)`,
    );
    return 1;
  }

  const tools = deps.toolRegistry?.list() ?? [];
  const toolNames = tools.map((t) => t.name);
  const toolManifestHash = computeToolManifestHash(tools);
  const wstackEntry = await resolveWstackEntry();

  deps.renderer.writeInfo(`Running ${suiteId} across ${config.cells.length} model(s)…`);

  // A full matrix can run for hours. Stream every row to disk as it lands so a
  // crash, a Ctrl-C, or a dead battery leaves partial results behind instead of
  // nothing; `writeJsonArtifacts` rewrites the same file at the end.
  await fs.mkdir(outDir, { recursive: true });
  const partialPath = path.join(outDir, 'results.jsonl');
  await fs.writeFile(partialPath, '', 'utf8');

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
      hostHomeDir: deps.paths?.globalRoot,
      keepSandbox: flagBool(deps, 'keep-sandbox'),
      onProgress: (msg) => deps.renderer.write(color.dim(msg) + '\n'),
      onResult: (result) => fs.appendFile(partialPath, JSON.stringify(result) + '\n', 'utf8'),
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

  // Every single attempt crashed before producing a result — a bad model id,
  // missing credentials, or a broken CLI entry, not a model outcome. Returning
  // 0 here let CI publish a 0%-pass leaderboard as if it were a measurement.
  const spawned = report.results.filter((row) => row.run.status !== 'crashed').length;
  if (report.results.length > 0 && spawned === 0) {
    deps.renderer.writeError(
      'Every run crashed before producing a result — check the provider/model ids and credentials. ' +
        'See the Failures section of the report.',
    );
    return 1;
  }
  return 0;
}

async function benchReport(args: string[], deps: SubcommandDeps): Promise<number> {
  const dir = args.find((a) => !a.startsWith('-'));
  if (!dir) {
    deps.renderer.writeError('Usage: wstack bench report <run-directory>');
    return 1;
  }
  const outDir = path.resolve(deps.cwd, dir);
  let report: BenchReport;
  try {
    report = await readRunDir(outDir);
  } catch (err) {
    deps.renderer.writeError(`cannot read run artifacts in ${outDir}: ${toErrorMessage(err)}`);
    return 1;
  }
  const md = renderMarkdownReport(report);
  await fs.writeFile(path.join(outDir, 'report.md'), md, 'utf8');
  deps.renderer.write('\n' + md + '\n');
  return 0;
}

async function benchCompare(args: string[], deps: SubcommandDeps): Promise<number> {
  const dirs = args.filter((a) => !a.startsWith('-'));
  const baselineRaw = dirs[0];
  const candidateRaw = dirs[1];
  if (!baselineRaw || !candidateRaw) {
    deps.renderer.writeError('Usage: wstack bench compare <baseline-dir> <candidate-dir>');
    return 1;
  }
  const baselineDir = path.resolve(deps.cwd, baselineRaw);
  const candidateDir = path.resolve(deps.cwd, candidateRaw);
  let comparisonMd: string;
  try {
    const baseline = await readRunDir(baselineDir);
    const candidate = await readRunDir(candidateDir);
    const comparison = compareReports(baseline, candidate);
    comparisonMd = renderComparisonMarkdown(comparison);
  } catch (err) {
    deps.renderer.writeError(`cannot compare runs: ${toErrorMessage(err)}`);
    return 1;
  }
  const outRaw = flagStr(deps, 'out');
  const outFile = outRaw ? path.resolve(deps.cwd, outRaw) : path.join(candidateDir, 'compare.md');
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(outFile, comparisonMd, 'utf8');
  deps.renderer.write('\n' + comparisonMd + '\n');
  deps.renderer.writeInfo(`Comparison written to ${outFile}`);
  return 0;
}

async function benchMine(args: string[], deps: SubcommandDeps): Promise<number> {
  const transcriptRaw = flagStr(deps, 'transcript') ?? args.find((arg) => !arg.startsWith('-'));
  if (!transcriptRaw) {
    deps.renderer.writeError(
      'Usage: wstack bench mine --transcript <session.jsonl> [--out <eval-dir>]',
    );
    return 1;
  }
  const outRaw = flagStr(deps, 'out') ?? 'evals';
  try {
    const mined = await mineTranscript({
      transcriptPath: path.resolve(deps.cwd, transcriptRaw),
      outDir: path.resolve(deps.cwd, outRaw),
    });
    deps.renderer.writeInfo(
      `Mined ${mined.candidates.length} edit attempt(s) from ${mined.sessionId}.`,
    );
    deps.renderer.writeInfo(`Pinned transcript → ${mined.copiedTranscriptPath}`);
    deps.renderer.writeInfo(`Curator drafts → ${mined.draftsPath}`);
    deps.renderer.writeInfo(
      'Add a frozen pre-edit fixture and deterministic grader before copying a draft into bench.local.json.',
    );
    return 0;
  } catch (err) {
    deps.renderer.writeError(toErrorMessage(err));
    return 1;
  }
}

async function benchList(_args: string[], deps: SubcommandDeps): Promise<number> {
  deps.renderer.write(color.bold('Suites\n'));
  deps.renderer.write(
    '  core      ' +
      color.dim('Bundled 6-task agent-edit eval (hidden tests) — default for `bench run`\n'),
  );
  deps.renderer.write(
    '  smoke     ' + color.dim('3 trivial file edits — harness wiring only, not a quality score\n'),
  );
  deps.renderer.write(
    '  local     ' + color.dim('Project-defined manifest tasks with command/file graders\n'),
  );
  deps.renderer.write(
    '  polyglot  ' +
      color.dim('Aider polyglot (edit accuracy) — Docker-free, needs --polyglot-dir\n'),
  );
  deps.renderer.write(
    '  swebench  ' + color.dim('SWE-bench Verified (end-to-end) — Docker-gated\n'),
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
