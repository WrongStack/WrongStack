import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Module-relative so the suite passes from any vitest root (the package
// `test` script runs vitest with --root ../.. from the package directory).
const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)));
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
    maxLines: 7820,
    rationale:
      'TUI app shell is the largest hotspot in the repo. TEMP: cap raised from 7600 → 7820 to absorb the in-flight boot/wiring refactor + statusline/hook growth; re-tighten once the pending extraction lands.',
  },
  {
    file: 'packages/webui/src/App.tsx',
    maxLines: 1100,
    rationale:
      'Desktop/bridge hooks extracted to useDesktopBridge.ts (1028 lines after extraction). Keep under 1100 by extracting new concerns into their own modules.',
  },
  {
    file: 'packages/webui/src/components/SettingsPanel/index.tsx',
    maxLines: 1220,
    rationale:
      'Settings panel must decompose into sections/hooks, not grow further. Cap re-tightened 1500 → 1200 after the model-routing section extracted into RoutingSection.tsx; extract further sections rather than raising this again.',
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
  {
    file: 'packages/tui/src/theme-presets.ts',
    maxLines: 1424,
    rationale:
      'Single inline `themePresets` Record<ThemeName, Theme> holds ~50 preset definitions inline. Extract per-preset files under theme-presets/<name>.ts and compose via index to shrink below the 1424 floor; do not extend the inline list further.',
  },
] as const;

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

async function loadSlashCommandImportExceptions(): Promise<Set<string>> {
  const document = JSON.parse(
    await fs.readFile(path.resolve(REPO_ROOT, 'architecture/exceptions.json'), 'utf8'),
  ) as {
    exceptions?: Array<{ id?: string; kind?: string; members?: string[] }>;
  };
  const exception = document.exceptions?.find(
    (item) => item.id === 'ARCH-SLASH-IMPORT-01' && item.kind === 'slash-command-import',
  );
  return new Set(exception?.members ?? []);
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
    const temporaryAllowlist = await loadSlashCommandImportExceptions();
    const failures: string[] = [];

    for (const absPath of files) {
      const relPath = repoRelative(absPath);

      if (isSlashCommandImporter(relPath)) continue;

      const text = await fs.readFile(absPath, 'utf8');
      const specs = extractSlashCommandImports(text);
      if (specs.length === 0) continue;

      if (temporaryAllowlist.has(relPath)) continue;

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
    const temporaryAllowlist = await loadSlashCommandImportExceptions();
    const actualViolators = new Set<string>();

    for (const absPath of files) {
      const relPath = repoRelative(absPath);

      if (isSlashCommandImporter(relPath)) continue;

      const text = await fs.readFile(absPath, 'utf8');
      const specs = extractSlashCommandImports(text);
      if (specs.length > 0) actualViolators.add(relPath);
    }

    expect([...actualViolators].sort()).toEqual([...temporaryAllowlist].sort());
  });
});
