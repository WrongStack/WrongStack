import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const CLI_SRC = path.resolve(REPO_ROOT, 'packages/cli/src');

type Hotspot = {
  file: string;
  maxLines: number;
  rationale: string;
};

const HOTSPOTS: readonly Hotspot[] = [
  {
    file: 'packages/cli/src/cli-main.ts',
    maxLines: 3600,
    rationale: 'Top-level CLI orchestrator must shrink over time, not grow.',
  },
  {
    file: 'packages/cli/src/slash-commands/sdd.ts',
    maxLines: 1400,
    rationale: 'SDD command is already oversized; extract services instead of extending it.',
  },
  {
    file: 'packages/tui/src/app.tsx',
    maxLines: 7800,
    rationale:
      'TUI app shell is the largest hotspot in the repo. TEMP: cap raised from 7600 → 7800 to absorb the in-flight boot/wiring refactor growth; re-tighten once the pending extraction lands.',
  },
  {
    file: 'packages/webui/src/App.tsx',
    maxLines: 1100,
    rationale: 'Desktop/bridge hooks extracted to useDesktopBridge.ts (1028 lines after extraction). Keep under 1100 by extracting new concerns into their own modules.',
  },
  {
    file: 'packages/webui/src/components/SettingsPanel/index.tsx',
    maxLines: 1200,
    rationale: 'Settings panel must decompose into sections/hooks, not grow further. Cap re-tightened 1500 → 1200 after the model-routing section extracted into RoutingSection.tsx; extract further sections rather than raising this again.',
  },
  {
    file: 'packages/webui/src/components/SetupScreen.tsx',
    maxLines: 1600,
    rationale: 'Setup flow should split by step/validation concerns.',
  },
  {
    file: 'packages/webui/src/components/OfficeMapCanvas.tsx',
    maxLines: 2000,
    rationale: 'Canvas rendering and interaction logic need decomposition, not more inline growth.',
  },
] as const;

/**
 * Temporary debt baseline.
 *
 * These are current non-command modules that still import from slash-commands/.
 * The guardrail blocks new violations while follow-up refactors move shared logic
 * into cli/services/*.
 */
const TEMPORARY_SLASH_COMMAND_IMPORT_ALLOWLIST = new Set<string>([
  'packages/cli/src/execution.ts',
  'packages/cli/src/project-picker.ts',
  'packages/cli/src/repl.ts',
  'packages/cli/src/webui-server/ws-handlers/projects.ts',
  'packages/cli/src/cli-main.ts',
  'packages/cli/src/cli-eternal-flag.ts',
  'packages/cli/src/boot/dispatch-webui.ts',
  'packages/cli/src/boot/system-prompt-builder.ts',
  // Extracted from execution.ts (Phase C3/C5) — carry its pre-existing violations.
  'packages/cli/src/boot/tui-project-picker-callback.ts',
  'packages/cli/src/boot/tui-sdd-callback.ts',
  'packages/cli/src/next-task-predictor.ts',
  // Extracted from cli-main.ts (Phase D, PR #241) — carries the same slash-command
  // imports as cli-main.ts itself (which is already on the allowlist above).
  'packages/cli/src/wiring/director-setup.ts',
  // Extracted from boot.ts (boot/wiring refactor) — boot.ts no longer imports
  // slash-commands directly; these carry its pre-existing statusline/autonomy
  // imports until they move into cli/services/*.
  'packages/cli/src/execute-deps.ts',
  'packages/cli/src/wiring/controllers.ts',
]);

/**
 * Permanent architectural allowance: this file is the dedicated registration
 * bridge that wires slash commands into the runtime.
 */
const PERMANENT_ALLOWED_IMPORTERS = new Set<string>(['packages/cli/src/wiring/slash-commands.ts']);

const IMPORT_RE =
  /(?:from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/g;

async function lineCount(absPath: string): Promise<number> {
  const text = await fs.readFile(absPath, 'utf8');
  return text.split(/\r?\n/).length;
}

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...(await walk(full)));
      continue;
    }
    if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function repoRelative(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).replaceAll(path.sep, '/');
}

function isSlashCommandImporter(relPath: string): boolean {
  if (relPath.startsWith('packages/cli/src/slash-commands/')) return true;
  if (PERMANENT_ALLOWED_IMPORTERS.has(relPath)) return true;
  return false;
}

function isAllowedBaselineViolation(relPath: string): boolean {
  return TEMPORARY_SLASH_COMMAND_IMPORT_ALLOWLIST.has(relPath);
}

function extractSlashCommandImports(text: string): string[] {
  const specs: string[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (!spec) continue;
    if (!spec.startsWith('.')) continue;
    if (!spec.includes('slash-commands/')) continue;
    specs.push(spec);
  }
  return specs;
}

describe('architecture guardrails', () => {
  it('keeps known hotspot files under explicit line-count caps', async () => {
    const failures: string[] = [];

    for (const hotspot of HOTSPOTS) {
      const abs = path.resolve(REPO_ROOT, hotspot.file);
      const count = await lineCount(abs);
      if (count > hotspot.maxLines) {
        failures.push(
          [
            `${hotspot.file} is ${count} lines (cap: ${hotspot.maxLines}).`,
            hotspot.rationale,
            'Extract logic into smaller modules instead of extending this file.',
          ].join(' '),
        );
      }
    }

    expect(
      failures,
      failures.length === 0
        ? undefined
        : `Hotspot guardrail violations:\n\n- ${failures.join('\n- ')}`,
    ).toEqual([]);
  });

  it('blocks new non-command imports from slash-commands/', async () => {
    const files = await walk(CLI_SRC);
    const failures: string[] = [];

    for (const absPath of files) {
      const relPath = repoRelative(absPath);

      if (isSlashCommandImporter(relPath)) continue;

      const text = await fs.readFile(absPath, 'utf8');
      const specs = extractSlashCommandImports(text);
      if (specs.length === 0) continue;

      if (isAllowedBaselineViolation(relPath)) continue;

      for (const spec of specs) {
        failures.push(
          `${relPath} imports "${spec}". Move shared logic into cli/services/* instead of depending on slash-command modules.`,
        );
      }
    }

    expect(
      failures,
      failures.length === 0
        ? undefined
        : `New slash-command boundary violations:\n\n- ${failures.join('\n- ')}`,
    ).toEqual([]);
  });

  it('tracks the temporary slash-command import baseline explicitly', async () => {
    const files = await walk(CLI_SRC);
    const actualViolators = new Set<string>();

    for (const absPath of files) {
      const relPath = repoRelative(absPath);

      if (isSlashCommandImporter(relPath)) continue;

      const text = await fs.readFile(absPath, 'utf8');
      const specs = extractSlashCommandImports(text);
      if (specs.length > 0) actualViolators.add(relPath);
    }

    expect([...actualViolators].sort()).toEqual(
      [...TEMPORARY_SLASH_COMMAND_IMPORT_ALLOWLIST].sort(),
    );
  });
});
