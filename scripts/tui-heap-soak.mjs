#!/usr/bin/env node
/**
 * Controlled retained-heap benchmark for the production Ink history renderer.
 *
 * Each terminal width runs in a fresh `node --expose-gc` process. Heap snapshots
 * are analyzed only after that renderer exits so dominator parsing cannot affect
 * the measured process.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'packages', 'tui');
const tempDir = join(root, '.temp_files', `tui-heap-soak-${process.pid}`);

function usage() {
  return `Usage: pnpm bench:tui-heap [options]

Options:
  --quick                 Small smoke profile (still captures/analyzes snapshots)
  --widths <list>         Comma-separated terminal widths (default: 72,160)
  --viewport-rows <n>     Managed history viewport height (default: 32)
  --entries <n>           Final deterministic transcript entries (default: 2000)
  --steps <n>             Transcript growth checkpoints (default: 20)
  --plateau-samples <n>   Full-transcript rerenders after growth (default: 8)
  --gc-passes <n>         Forced major-GC calls before every sample (default: 3)
  --top <n>               Dominators retained per snapshot (default: 25)
  --seed <n>              Deterministic workload seed (default: 1592639710)
  --output <path>         Artifact directory (default: .reports/tui-heap-soak)
  --max-old-space-mb <n>  Renderer/analyzer heap ceiling (default: 4096)
  --help                  Show this help
`;
}

function positiveInteger(raw, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${raw}`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {
    widths: [72, 160],
    viewportRows: 32,
    entries: 2000,
    steps: 20,
    plateauSamples: 8,
    gcPasses: 3,
    top: 25,
    seed: 1592639710,
    output: join(root, '.reports', 'tui-heap-soak'),
    maxOldSpaceMb: 4096,
    quick: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help') return { help: true, options };
    if (arg === '--quick') {
      options.quick = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value after ${arg}`);
    switch (arg) {
      case '--widths': {
        options.widths = value.split(',').map((part) => positiveInteger(part.trim(), 'width'));
        if (options.widths.length === 0) throw new Error('--widths must not be empty');
        break;
      }
      case '--viewport-rows':
        options.viewportRows = positiveInteger(value, 'viewport-rows');
        break;
      case '--entries':
        options.entries = positiveInteger(value, 'entries');
        break;
      case '--steps':
        options.steps = positiveInteger(value, 'steps');
        break;
      case '--plateau-samples':
        options.plateauSamples = positiveInteger(value, 'plateau-samples');
        break;
      case '--gc-passes':
        options.gcPasses = positiveInteger(value, 'gc-passes');
        break;
      case '--top':
        options.top = positiveInteger(value, 'top');
        break;
      case '--seed':
        options.seed = positiveInteger(value, 'seed');
        break;
      case '--output':
        options.output = resolve(value);
        break;
      case '--max-old-space-mb':
        options.maxOldSpaceMb = positiveInteger(value, 'max-old-space-mb');
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (options.quick) {
    options.entries = 120;
    options.steps = 4;
    options.plateauSamples = 2;
    options.top = Math.min(options.top, 10);
  }
  return { help: false, options };
}

async function bundle(entry, outfile) {
  await build({
    absWorkingDir: packageRoot,
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'bundle',
    plugins: [
      {
        name: 'optional-react-devtools-stub',
        setup(builder) {
          builder.onResolve({ filter: /^react-devtools-core$/ }, () => ({
            path: 'react-devtools-core',
            namespace: 'tui-heap-soak',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'tui-heap-soak' }, () => ({
            contents: 'export default { initialize() {}, connectToDevTools() {} };',
            loader: 'js',
          }));
        },
      },
    ],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    sourcemap: false,
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  });
}

async function runNode(entry, args, maxOldSpaceMb) {
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(
      process.execPath,
      [`--max-old-space-size=${maxOldSpaceMb}`, '--expose-gc', entry, ...args],
      { cwd: root, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${relative(root, entry)} terminated by ${signal}`));
      else resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`${relative(root, entry)} exited with code ${exitCode}`);
}

function formatMiB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function markdownCell(value, maxLength = 120) {
  const compact = String(value).replace(/\s+/g, ' ').replaceAll('|', '\\|').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function markdownReport(report) {
  const lines = [
    '# TUI heap-soak report',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '| Width | Entries | Mounted heap | After unmount | Released | Plateau slope | Ink nodes | Text nodes | Yoga nodes |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const item of report.scenarios) {
    const run = item.run;
    const structures = run.renderer.mountedStructures;
    lines.push(
      `| ${run.scenario.width} | ${run.scenario.entries} | ${formatMiB(run.memory.mounted.heapUsed)} MiB | ${formatMiB(run.memory.unmounted.heapUsed)} MiB | ${formatMiB(run.memory.releasedOnUnmountBytes)} MiB | ${formatMiB(run.memory.plateauSlopeBytesPerSample)} MiB/sample | ${structures.inkElements} | ${structures.textNodes} | ${structures.yogaNodes} |`,
    );
  }
  lines.push('', '## Top mounted dominators', '');
  for (const item of report.scenarios) {
    lines.push(`### ${item.run.scenario.width} columns`, '');
    lines.push('| Rank | Type | Name | Retained | Self |');
    lines.push('| ---: | --- | --- | ---: | ---: |');
    for (const [index, dominator] of item.analysis.mounted.dominators.slice(0, 10).entries()) {
      lines.push(
        `| ${index + 1} | ${markdownCell(dominator.type, 32)} | ${markdownCell(dominator.name)} | ${formatMiB(dominator.retainedSize)} MiB | ${formatMiB(dominator.selfSize)} MiB |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    return;
  }
  const options = parsed.options;
  await mkdir(tempDir, { recursive: true });
  await mkdir(options.output, { recursive: true });
  const worker = join(tempDir, 'heap-soak-worker.mjs');
  const analyzer = join(tempDir, 'heap-soak-analyze.mjs');
  try {
    await Promise.all([
      bundle(join(packageRoot, 'bench', 'heap-soak-worker.tsx'), worker),
      bundle(join(packageRoot, 'bench', 'heap-soak-analyze.ts'), analyzer),
    ]);
    const scenarios = [];
    for (const width of options.widths) {
      const label = `width-${width}`;
      const scenarioPath = join(options.output, `${label}.json`);
      const analysisPath = join(options.output, `${label}-dominators.json`);
      const mountedSnapshot = join(options.output, `${label}-mounted.heapsnapshot`);
      const unmountedSnapshot = join(options.output, `${label}-unmounted.heapsnapshot`);
      process.stdout.write(`[tui-heap-soak] rendering ${width} columns\n`);
      await runNode(
        worker,
        [
          '--width',
          String(width),
          '--viewport-rows',
          String(options.viewportRows),
          '--entries',
          String(options.entries),
          '--steps',
          String(options.steps),
          '--plateau-samples',
          String(options.plateauSamples),
          '--gc-passes',
          String(options.gcPasses),
          '--seed',
          String(options.seed),
          '--output',
          scenarioPath,
          '--snapshot',
          mountedSnapshot,
          '--unmounted-snapshot',
          unmountedSnapshot,
        ],
        options.maxOldSpaceMb,
      );
      process.stdout.write(`[tui-heap-soak] analyzing ${width}-column dominators\n`);
      await runNode(
        analyzer,
        ['--scenario', scenarioPath, '--output', analysisPath, '--top', String(options.top)],
        options.maxOldSpaceMb,
      );
      scenarios.push({
        run: JSON.parse(await readFile(scenarioPath, 'utf8')),
        analysis: JSON.parse(await readFile(analysisPath, 'utf8')),
      });
    }
    const fingerprints = new Set(scenarios.map((item) => item.run.workload.fingerprint));
    if (fingerprints.size !== 1) {
      throw new Error('Narrow and wide scenarios did not replay the same workload');
    }
    const aggregate = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      options,
      workloadFingerprint: scenarios[0]?.run.workload.fingerprint,
      scenarios,
    };
    const reportPath = join(options.output, 'report.json');
    const markdownPath = join(options.output, 'report.md');
    await Promise.all([
      writeFile(reportPath, `${JSON.stringify(aggregate, null, 2)}\n`, 'utf8'),
      writeFile(markdownPath, markdownReport(aggregate), 'utf8'),
    ]);
    process.stdout.write(`[tui-heap-soak] wrote ${relative(root, reportPath)}\n`);
    process.stdout.write(`[tui-heap-soak] wrote ${relative(root, markdownPath)}\n`);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

await main();
