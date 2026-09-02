// Aggregates every per-area coverage/coverage-summary.json in the monorepo into one
// markdown progress matrix. Part of the coverage program:
// docs/plans/test-coverage-100-2026-08.md (Phase 0 deliverable, `pnpm coverage:matrix`).
//
// This script reports; it does not gate. Thresholds live in each area's vitest config.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SUMMARY_NAME = 'coverage-summary.json';
const MS_PER_DAY = 86_400_000;

export function isDirectRun(metaUrl = import.meta.url, argvEntry = process.argv[1]) {
  return typeof argvEntry === 'string' && resolve(argvEntry) === fileURLToPath(metaUrl);
}

function listChildDirs(repoRoot, parent) {
  try {
    return readdirSync(resolve(repoRoot, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Fixed aggregates first, then packages, then apps — stable report order.
export function discoverSummaries(repoRoot) {
  const locations = [
    { label: 'coverage/root', summaryPath: resolve(repoRoot, 'coverage', 'root', SUMMARY_NAME) },
    {
      label: 'coverage/scripts',
      summaryPath: resolve(repoRoot, 'coverage', 'scripts', SUMMARY_NAME),
    },
  ];
  for (const name of listChildDirs(repoRoot, 'packages')) {
    locations.push({
      label: `packages/${name}`,
      summaryPath: resolve(repoRoot, 'packages', name, 'coverage', SUMMARY_NAME),
    });
  }
  for (const name of listChildDirs(repoRoot, 'apps')) {
    locations.push({
      label: `apps/${name}`,
      summaryPath: resolve(repoRoot, 'apps', name, 'coverage', SUMMARY_NAME),
    });
  }
  return locations;
}

// Returns a row (with the parsed json attached) or null when the area has no summary.
export function summarize(location) {
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(location.summaryPath, 'utf8');
    mtimeMs = statSync(location.summaryPath).mtimeMs;
  } catch {
    return null;
  }
  try {
    const json = JSON.parse(raw);
    return { ...location, mtimeMs, json };
  } catch (error) {
    return { ...location, mtimeMs, json: null, error: `unparseable summary: ${error.message}` };
  }
}

function metricPct(row, name) {
  const metric = row.json?.total?.[name];
  return metric && typeof metric.pct === 'number' ? `${metric.pct.toFixed(2)}%` : '—';
}

function uncoveredStatements(row) {
  const statements = row.json?.total?.statements;
  if (!statements || typeof statements.total !== 'number') return null;
  return statements.total - statements.covered;
}

function isoDay(mtimeMs) {
  return new Date(mtimeMs).toISOString().slice(0, 10);
}

export function buildMatrix(summaries, nowMs = Date.now()) {
  return summaries
    .filter((row) => row !== null)
    .map((row) => ({
      label: row.label,
      lines: metricPct(row, 'lines'),
      statements: metricPct(row, 'statements'),
      functions: metricPct(row, 'functions'),
      branches: metricPct(row, 'branches'),
      uncoveredStatements: uncoveredStatements(row),
      measuredOn: isoDay(row.mtimeMs),
      ageDays: Math.max(0, Math.floor((nowMs - row.mtimeMs) / MS_PER_DAY)),
      error: row.error,
    }));
}

// Top-N files by uncovered statements from a summary that contains per-file entries.
export function worstFiles(summaryJson, limit = 15) {
  return Object.entries(summaryJson ?? {})
    .filter(([key, value]) => key !== 'total' && value?.statements)
    .map(([key, value]) => ({
      file: key.replace(/^(?:.*[/\\])?((?:packages|apps|coverage)[/\\].*)$/u, '$1'),
      uncoveredStatements: value.statements.total - value.statements.covered,
      linesPct: typeof value.lines?.pct === 'number' ? value.lines.pct : 0,
    }))
    .filter((row) => row.uncoveredStatements > 0)
    .sort((a, b) => b.uncoveredStatements - a.uncoveredStatements)
    .slice(0, limit);
}

function fmtCount(value) {
  return value === null ? '—' : String(value);
}

export function renderMarkdown({ rows, worst, generatedAt }) {
  const lines = [
    `# Coverage Matrix — ${generatedAt.slice(0, 10)}`,
    '',
    'Aggregated from per-area `coverage/coverage-summary.json` files by',
    '`scripts/coverage-matrix.mjs` (`pnpm coverage:matrix`). This report is a progress view for',
    "`docs/plans/test-coverage-100-2026-08.md`; enforcement lives in each area's vitest config.",
    '',
    '| Area | Lines | Stmts | Funcs | Branches | Uncovered stmts | Measured | Age |',
    '|---|---:|---:|---:|---:|---:|---|---:|',
  ];
  for (const row of rows) {
    if (row.error) {
      lines.push(`| ${row.label} | — | — | — | — | — | ${row.measuredOn} | ${row.ageDays}d |`);
      lines.push(`> ⚠️ ${row.label}: ${row.error}`);
      continue;
    }
    lines.push(
      `| ${row.label} | ${row.lines} | ${row.statements} | ${row.functions} | ${row.branches} | ` +
        `${fmtCount(row.uncoveredStatements)} | ${row.measuredOn} | ${row.ageDays}d |`,
    );
  }
  lines.push('', '## Worst files in the root run (by uncovered statements)', '');
  if (worst.length === 0) {
    lines.push('No root-run summary found.');
  } else {
    lines.push('| File | Uncovered stmts | Lines |', '|---|---:|---:|');
    for (const row of worst) {
      lines.push(`| ${row.file} | ${row.uncoveredStatements} | ${row.linesPct.toFixed(2)}% |`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function parseArgs(argv) {
  const out = { outPath: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      index += 1;
      if (index >= argv.length) throw new Error('--out requires a path');
      out.outPath = argv[index];
    } else {
      throw new Error(`unknown argument: ${argv[index]}`);
    }
  }
  return out;
}

export function run(argv = [], deps = {}) {
  const repoRoot = deps.repoRoot ?? resolve(import.meta.dirname, '..');
  const log = deps.log ?? ((message) => console.log(message));
  const nowMs = deps.nowMs ?? Date.now();
  const generatedAt = new Date(nowMs).toISOString();
  const { outPath } = parseArgs(argv);

  const locations = discoverSummaries(repoRoot);
  const summaries = locations.map((location) => summarize(location));
  const missing = locations.filter((_location, index) => summaries[index] === null);
  for (const location of missing) {
    log(`[coverage-matrix] no summary for ${location.label} (skipped)`);
  }

  const rows = buildMatrix(summaries, nowMs);
  const rootJson = summaries.find((row) => row?.label === 'coverage/root')?.json ?? null;
  const markdown = renderMarkdown({ rows, worst: worstFiles(rootJson), generatedAt });

  if (outPath) {
    writeFileSync(resolve(outPath), markdown, 'utf8');
    log(`[coverage-matrix] wrote ${resolve(outPath)}`);
  } else {
    log(markdown);
  }
  return 0;
}

if (isDirectRun()) {
  process.exitCode = run(process.argv.slice(2));
}
