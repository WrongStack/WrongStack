import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SystemInstructionBundle {
  identity?: string | undefined;
  leaderAfterTask?: string | undefined;
  /**
   * Which discovery layer supplied `identity`.
   *
   * WS-016: `<project>/.wrongstack/instructions/system.md` is repo-committed
   * and therefore untrusted, yet it *replaced* the layer-1 identity prompt
   * verbatim — no delimiter, no trust gate. It is the one project-supplied
   * prompt surface with no untrusted-content treatment, while project config is
   * stripped, MCP resources get a banner, and council/SAGE text is delimited.
   * The consumer uses this to append rather than replace when the source is the
   * project.
   */
  identitySource?: 'bundled' | 'global' | 'project' | 'file' | undefined;
}

export interface InstructionBundle {
  version?: number | undefined;
  system?: SystemInstructionBundle | undefined;
  sections?: Record<string, string> | undefined;
}

export type SystemInstructionVariant = 'default' | 'lite' | 'pro';

export interface InstructionBundlePaths {
  /** Bundled instruction directory. Defaults to `<@wrongstack/core>/instructions`. */
  bundledDir?: string | undefined;
  /** Profile override directory, e.g. `~/.wrongstack/profiles/<name>/instructions`. */
  globalDir?: string | undefined;
  /** Project override directory, e.g. `<project>/.wrongstack/instructions`. */
  projectDir?: string | undefined;
  /**
   * Selects the markdown file used for the system identity layer.
   * Defaults to `system.md`; `lite` reads `system-lite.md` and `pro` reads
   * `system-pro.md` from the same bundled/global/project instruction directories.
   */
  systemVariant?: SystemInstructionVariant | undefined;
  /**
   * Direct markdown filename for the system identity layer, for callers that
   * need an explicit file such as `system-pro.md` without introducing another
   * variant. Path separators are rejected so selection stays within each
   * instruction directory.
   */
  systemFile?: string | undefined;
  /** Extra override JSON files applied after projectDir, in order. */
  files?: readonly string[] | undefined;
}

export async function loadInstructionBundle(
  paths: InstructionBundlePaths | undefined,
): Promise<InstructionBundle> {
  let bundle: InstructionBundle = {};
  const systemFile = resolveSystemInstructionFile(paths);
  const dirs = [
    paths?.bundledDir ?? defaultBundledInstructionDir(),
    paths?.globalDir,
    paths?.projectDir,
  ].filter((p): p is string => typeof p === 'string' && p.trim().length > 0);

  const layerNames: Array<'bundled' | 'global' | 'project'> = [];
  if (paths?.bundledDir ?? defaultBundledInstructionDir()) layerNames.push('bundled');
  if (typeof paths?.globalDir === 'string' && paths.globalDir.trim().length > 0) {
    layerNames.push('global');
  }
  if (typeof paths?.projectDir === 'string' && paths.projectDir.trim().length > 0) {
    layerNames.push('project');
  }

  for (const [index, dir] of dirs.entries()) {
    const layer = await readInstructionDir(dir, { systemFile });
    if (layer.system?.identity !== undefined) {
      layer.system = { ...layer.system, identitySource: layerNames[index] ?? 'bundled' };
    }
    bundle = mergeInstructionBundle(bundle, layer);
  }
  for (const file of paths?.files ?? []) {
    const layer = await readInstructionJson(file);
    if (layer.system?.identity !== undefined) {
      layer.system = { ...layer.system, identitySource: 'file' };
    }
    bundle = mergeInstructionBundle(bundle, layer);
  }
  return bundle;
}

export function mergeInstructionBundle(
  base: InstructionBundle,
  override: InstructionBundle,
): InstructionBundle {
  return {
    ...base,
    ...definedPick(override, ['version']),
    system: {
      ...(base.system ?? {}),
      ...(override.system ?? {}),
    },
    sections: {
      ...(base.sections ?? {}),
      ...(override.sections ?? {}),
    },
  };
}

function resolveSystemInstructionFile(paths: InstructionBundlePaths | undefined): string {
  if (paths?.systemFile !== undefined) return sanitizeSystemInstructionFile(paths.systemFile);
  if (paths?.systemVariant === 'lite') return 'system-lite.md';
  if (paths?.systemVariant === 'pro') return 'system-pro.md';
  return 'system.md';
}

function sanitizeSystemInstructionFile(file: string): string {
  const trimmed = file.trim();
  if (
    trimmed.length === 0 ||
    trimmed !== path.basename(trimmed) ||
    path.extname(trimmed).toLowerCase() !== '.md'
  ) {
    throw new Error(`Invalid system instruction file: ${file}`);
  }
  return trimmed;
}

async function readInstructionDir(
  dir: string,
  options: { systemFile: string },
): Promise<InstructionBundle> {
  const [json, identity, leaderAfterTask, sections] = await Promise.all([
    readInstructionJson(path.join(dir, 'instructions.json')),
    readOptionalText(path.join(dir, options.systemFile)),
    readOptionalText(path.join(dir, 'leader-after-task.md')),
    readSections(path.join(dir, 'sections')),
  ]);
  const fromMarkdown: InstructionBundle = {
    system: {
      ...(identity !== undefined ? { identity } : {}),
      ...(leaderAfterTask !== undefined ? { leaderAfterTask } : {}),
    },
    sections,
  };
  return mergeInstructionBundle(json, fromMarkdown);
}

async function readSections(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await readSectionsInto(root, root, out);
  return out;
}

async function readSectionsInto(
  root: string,
  dir: string,
  out: Record<string, string>,
): Promise<void> {
  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await readSectionsInto(root, file, out);
        return;
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) return;
      const text = await readOptionalText(file);
      if (text === undefined) return;
      const rel = path.relative(root, file).replace(/\\/g, '/').replace(/\.md$/i, '');
      const key = rel.split('/').join('.').replace(/-/g, '.');
      out[key] = text;
    }),
  );
}

async function readInstructionJson(file: string): Promise<InstructionBundle> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return {};
  }
  try {
    return normalizeInstructionBundle(JSON.parse(raw));
  } catch {
    return {};
  }
}

function normalizeInstructionBundle(value: unknown): InstructionBundle {
  if (!value || typeof value !== 'object') return {};
  const input = value as {
    version?: unknown;
    system?: unknown;
    sections?: unknown;
  };
  const system =
    input.system && typeof input.system === 'object'
      ? (input.system as { identity?: unknown; leaderAfterTask?: unknown })
      : undefined;
  const sections =
    input.sections && typeof input.sections === 'object'
      ? Object.fromEntries(
          Object.entries(input.sections as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
  return {
    ...(typeof input.version === 'number' ? { version: input.version } : {}),
    ...(system
      ? {
          system: {
            ...(typeof system.identity === 'string' ? { identity: system.identity } : {}),
            ...(typeof system.leaderAfterTask === 'string'
              ? { leaderAfterTask: system.leaderAfterTask }
              : {}),
          },
        }
      : {}),
    ...(sections ? { sections } : {}),
  };
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return text.trimEnd();
  } catch {
    return undefined;
  }
}

function defaultBundledInstructionDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return firstExistingDirSync([
    path.resolve(here, '../../instructions'),
    path.resolve(here, '../instructions'),
    path.resolve(here, 'instructions'),
  ]);
}

function definedPick<T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

function firstExistingDirSync(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next candidate
    }
  }
  return candidates[0] ?? '';
}
