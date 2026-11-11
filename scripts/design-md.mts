#!/usr/bin/env bun
/**
 * Standalone CLI runner for the WrongStack Design DNA & DESIGN.md Synthesis Engine.
 *
 * Exposes all six designmd.me / Design Studio workflows directly from the terminal
 * without spinning up an interactive chat session:
 *
 *   bun run design:md extract <url-or-file> [--pages <1-8>] [--name <slug>] [--out <path>]
 *   bun run design:md compare <ref-slug> <url-or-file-or-slug> [--against]
 *   bun run design:md inspect <url-or-file> [--surface <page|app>]
 *   bun run design:md lint <DESIGN.md>
 *   bun run design:md diff <before-DESIGN.md> <after-DESIGN.md>
 *   bun run design:md materialize <DESIGN.md> [--stack <stack>] [--out <path>] [--stdout]
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import {
  type DesignStack,
  designMdToTokens,
  diffDesignMd,
  isDesignStack,
  materializeTokens,
  parseDesignMd,
  renderDesignMdDiff,
} from '../packages/core/src/design/index.js';

const USAGE = `Usage: bun run design:md <command> [options]

Commands:
  extract <url|file>           Extract DESIGN.md + design DNA across 5 breakpoints
    --pages <1-8>              Max same-origin pages to crawl & merge (default: 1)
    --name <slug>              Override output slug under .design/references/<slug>/
    --out <path>               Also copy the synthesized DESIGN.md to <path>
    --root <dir>               Project root directory (default: cwd)

  compare <ref> <target>       Score implementation fidelity against .design/references/<ref>/
    --against                  Treat <target> as another saved reference slug instead of URL/file
    --root <dir>               Project root directory (default: cwd)

  inspect <url|file>           Inspect a rendered page for contrast/overflow/hierarchy defects
    --surface <page|app>       Surface profile: "page" (default) or "app"
    --root <dir>               Project root directory (default: cwd)

  lint <DESIGN.md>             Parse and validate a DESIGN.md file (YAML, refs, WCAG contrast)

  diff <before.md> <after.md>  Compare two DESIGN.md versions and flag regressions

  materialize <DESIGN.md>      Compile DESIGN.md tokens into a native stack theme file
    --stack <stack>            Target stack: web | react-native | flutter | swiftui | compose
    --out <path>               Output file path (defaults per stack, e.g. src/styles/tokens.css)
    --stdout                   Print generated theme file to stdout instead of writing to disk

Options:
  --help, -h                   Show this help message
`;

type CommandName = 'extract' | 'compare' | 'inspect' | 'lint' | 'diff' | 'materialize';

interface ParsedCli {
  help: boolean;
  command?: CommandName;
  positionals: string[];
  pages?: number;
  name?: string;
  out?: string;
  root: string;
  against: boolean;
  surface?: 'page' | 'app';
  stack?: DesignStack;
  stdout: boolean;
}

const COMMANDS = new Set<CommandName>([
  'extract',
  'compare',
  'inspect',
  'lint',
  'diff',
  'materialize',
]);

function failCli(message: string): never {
  process.stderr.write(`${message}\n\n${USAGE}`);
  process.exit(2);
}

export function parseArgs(argv: readonly string[]): ParsedCli {
  const parsed: ParsedCli = {
    help: false,
    positionals: [],
    root: process.cwd(),
    against: false,
    stdout: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h' || (i === 0 && arg === 'help')) {
      parsed.help = true;
      continue;
    }
    if (arg === '--against') {
      parsed.against = true;
      continue;
    }
    if (arg === '--stdout') {
      parsed.stdout = true;
      continue;
    }
    if (arg === '--pages') {
      const raw = argv[++i];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 8) {
        failCli(`Invalid value for --pages: ${raw ?? '(missing)'} (expected integer 1-8)`);
      }
      parsed.pages = n;
      continue;
    }
    if (arg === '--name') {
      const raw = argv[++i];
      if (!raw || raw.startsWith('-')) failCli('Missing value for --name');
      parsed.name = raw;
      continue;
    }
    if (arg === '--out') {
      const raw = argv[++i];
      if (!raw || raw.startsWith('-')) failCli('Missing value for --out');
      parsed.out = raw;
      continue;
    }
    if (arg === '--root') {
      const raw = argv[++i];
      if (!raw || raw.startsWith('-')) failCli('Missing value for --root');
      parsed.root = path.resolve(raw);
      continue;
    }
    if (arg === '--surface') {
      const raw = argv[++i];
      if (raw !== 'page' && raw !== 'app') {
        failCli(`Invalid value for --surface: ${raw ?? '(missing)'} (expected page or app)`);
      }
      parsed.surface = raw;
      continue;
    }
    if (arg === '--stack') {
      const raw = argv[++i];
      if (!raw || !isDesignStack(raw)) {
        failCli(
          `Invalid value for --stack: ${raw ?? '(missing)'} (expected web, react-native, flutter, swiftui, or compose)`,
        );
      }
      parsed.stack = raw;
      continue;
    }
    if (arg.startsWith('-')) {
      failCli(`Unknown argument: ${arg}`);
    }
    if (!parsed.command) {
      if (!COMMANDS.has(arg as CommandName)) {
        failCli(`Unknown argument: ${arg}`);
      }
      parsed.command = arg as CommandName;
      continue;
    }
    parsed.positionals.push(arg);
  }

  return parsed;
}

function makeToolContext(projectRoot: string): Context {
  return {
    cwd: projectRoot,
    projectRoot,
    tools: [],
    meta: {},
  } as unknown as Context;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

async function runLint(filePath: string): Promise<number> {
  const abs = path.resolve(filePath);
  const raw = await fs.readFile(abs, 'utf8');
  const { doc, sections, issues } = parseDesignMd(raw);
  const errors = issues.filter((x) => x.severity === 'error');
  const warnings = issues.filter((x) => x.severity === 'warning');

  if (!doc) {
    process.stderr.write(`FAIL ${filePath}: unable to parse DESIGN.md frontmatter\n`);
    for (const issue of issues) {
      process.stderr.write(`  [${issue.severity.toUpperCase()}] ${issue.rule}: ${issue.message}\n`);
    }
    return 1;
  }

  const colorCount = Object.keys(doc.colors).length;
  const typoCount = Object.keys(doc.typography).length;
  const compCount = Object.keys(doc.components).length;
  const status = errors.length > 0 ? 'FAIL' : 'PASS';
  process.stdout.write(
    `${status} ${filePath} — "${doc.name ?? 'Untitled'}" (${colorCount} colors, ${typoCount} typography roles, ${compCount} components, ${sections.length} sections)\n`,
  );
  for (const issue of issues) {
    const stream = issue.severity === 'error' ? process.stderr : process.stdout;
    stream.write(`  [${issue.severity.toUpperCase()}] ${issue.rule}: ${issue.message}\n`);
  }
  if (issues.length === 0) {
    process.stdout.write('  0 errors, 0 warnings.\n');
  } else {
    process.stdout.write(`  ${errors.length} error(s), ${warnings.length} warning(s).\n`);
  }
  return errors.length > 0 ? 1 : 0;
}

async function runDiff(beforePath: string, afterPath: string): Promise<number> {
  const [beforeRaw, afterRaw] = await Promise.all([
    fs.readFile(path.resolve(beforePath), 'utf8'),
    fs.readFile(path.resolve(afterPath), 'utf8'),
  ]);
  const before = parseDesignMd(beforeRaw);
  const after = parseDesignMd(afterRaw);
  if (!before.doc) {
    process.stderr.write(
      `Failed to parse ${beforePath}: ${before.issues.map((i) => i.message).join('; ')}\n`,
    );
    return 1;
  }
  if (!after.doc) {
    process.stderr.write(
      `Failed to parse ${afterPath}: ${after.issues.map((i) => i.message).join('; ')}\n`,
    );
    return 1;
  }
  const changes = diffDesignMd(before.doc, after.doc);
  const label = `${path.basename(beforePath)} → ${path.basename(afterPath)}`;
  process.stdout.write(`${renderDesignMdDiff(changes, label)}\n`);
  return changes.some((c) => c.severity === 'FAIL') ? 1 : 0;
}

async function runMaterialize(
  filePath: string,
  stack: DesignStack,
  outPath: string | undefined,
  stdoutOnly: boolean,
): Promise<number> {
  const absInput = path.resolve(filePath);
  const raw = await fs.readFile(absInput, 'utf8');
  const parsed = parseDesignMd(raw);
  const errors = parsed.issues.filter((i) => i.severity === 'error');
  if (!parsed.doc || errors.length > 0) {
    process.stderr.write(
      `Cannot materialize invalid DESIGN.md (${filePath}): ${errors.map((e) => e.message).join('; ') || 'missing frontmatter'}\n`,
    );
    return 1;
  }
  const tokens = designMdToTokens(parsed.doc);
  const kitId =
    (parsed.doc.name ?? path.basename(path.dirname(absInput)) ?? 'design-md')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'design-md';
  const result = materializeTokens({
    tokens,
    stack,
    kitId,
    outPath,
  });
  if (stdoutOnly) {
    process.stdout.write(result.content);
    if (!result.content.endsWith('\n')) process.stdout.write('\n');
    return 0;
  }
  const dest = path.resolve(process.cwd(), result.path);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, result.content, 'utf8');
  process.stdout.write(`Wrote ${result.format} → ${result.path}\n`);
  return 0;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!cli.command) {
    failCli('Missing command (expected extract, compare, inspect, lint, diff, or materialize)');
  }

  if (cli.command === 'lint') {
    const target = cli.positionals[0];
    if (!target) failCli('Missing <DESIGN.md> path for lint');
    const code = await runLint(target);
    process.exit(code);
  }

  if (cli.command === 'diff') {
    const [beforePath, afterPath] = cli.positionals;
    if (!beforePath || !afterPath) failCli('Usage: bun run design:md diff <before.md> <after.md>');
    const code = await runDiff(beforePath, afterPath);
    process.exit(code);
  }

  if (cli.command === 'materialize') {
    const target = cli.positionals[0];
    if (!target) failCli('Missing <DESIGN.md> path for materialize');
    const code = await runMaterialize(target, cli.stack ?? 'web', cli.out, cli.stdout);
    process.exit(code);
  }

  const { designReferenceTool } = await import('../packages/tools/src/design-reference.js');
  const ctx = makeToolContext(cli.root);
  const signal = new AbortController().signal;

  if (cli.command === 'extract') {
    const target = cli.positionals[0];
    if (!target) failCli('Missing <url|file> target for extract');
    const res = await designReferenceTool.execute(
      {
        action: 'extract',
        ...(isHttpUrl(target) ? { url: target } : { file: target }),
        ...(cli.pages !== undefined ? { maxPages: cli.pages } : {}),
        ...(cli.name !== undefined ? { name: cli.name } : {}),
      },
      ctx,
      { signal },
    );
    process.stdout.write(`${res.output}\n`);
    if (cli.out && res.path) {
      const srcDesignMd = path.resolve(cli.root, res.path, 'DESIGN.md');
      const destDesignMd = path.resolve(process.cwd(), cli.out);
      await fs.mkdir(path.dirname(destDesignMd), { recursive: true });
      await fs.copyFile(srcDesignMd, destDesignMd);
      process.stdout.write(`Copied DESIGN.md → ${cli.out}\n`);
    }
    // Explicitly exit so Playwright browser idle timers do not keep the CLI alive.
    process.exit(0);
  }

  if (cli.command === 'compare') {
    const [reference, target] = cli.positionals;
    if (!reference || !target) {
      failCli('Usage: bun run design:md compare <ref-slug> <url|file|slug> [--against]');
    }
    const res = await designReferenceTool.execute(
      {
        action: 'compare',
        reference,
        ...(cli.against
          ? { against: target }
          : isHttpUrl(target)
            ? { url: target }
            : { file: target }),
      },
      ctx,
      { signal },
    );
    process.stdout.write(`${res.output}\n`);
    process.exit(0);
  }

  if (cli.command === 'inspect') {
    const target = cli.positionals[0];
    if (!target) failCli('Missing <url|file> target for inspect');
    const res = await designReferenceTool.execute(
      {
        action: 'inspect',
        ...(isHttpUrl(target) ? { url: target } : { file: target }),
        ...(cli.surface ? { surface: cli.surface } : {}),
      },
      ctx,
      { signal },
    );
    process.stdout.write(`${res.output}\n`);
    process.exit((res.fails ?? 0) > 0 ? 1 : 0);
  }
}

await main();
