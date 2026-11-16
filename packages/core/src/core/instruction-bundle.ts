import { statSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { moduleDirFor } from '@wrongstack/persistence';
import { expandSharedSystemInstructions } from '../utils/instruction-file.js';
import {
  activeSystemPromptPresetText,
  type SystemInstructionVariant,
} from './system-prompt-presets.js';

export interface SystemInstructionBundle {
  identity?: string | undefined;
  /** Trusted profile identity retained when a project override appends guidance. */
  trustedIdentity?: string | undefined;
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
  /**
   * Which discovery layer supplied `leaderAfterTask`. H-8 (AT-01): the
   * identity layer was hardened with a `<project-supplied-instructions>`
   * wrapper, but the sibling `leaderAfterTask` channel — read from the
   * same untrusted `<project>/.wrongstack/instructions/leader-after-task.md`
   * — was rendered raw. The consumer uses this to fence the override
   * when the source is the project.
   */
  leaderAfterTaskSource?: 'bundled' | 'global' | 'project' | 'file' | undefined;
}

export interface InstructionBundle {
  version?: number | undefined;
  system?: SystemInstructionBundle | undefined;
  /**
   * Which discovery layer supplied the `sections` map. H-8 (AT-01):
   * `<project>/.wrongstack/instructions/sections/*.md` is repo-committed
   * and rendered verbatim by `instructionSection()`, with no provenance
   * marker the way `identity` has. Filename → key mapping is mechanical
   * (`instruction-bundle.ts:176-178`), so a single `nice.md` file in a
   * cloned repo takes over a slot the genuine bundled section would
   * occupy. The consumer uses this to fence the override when the source
   * is the project.
   */
  sectionsSource?: 'bundled' | 'global' | 'project' | 'file' | undefined;
  sections?: Record<string, string> | undefined;
}

// Defined beside the presets, which need it and are imported here; this
// re-export keeps it where callers find it without a module cycle.
export type { SystemInstructionVariant };

export interface InstructionBundlePaths {
  /** Bundled instruction directory. Defaults to `<@wrongstack/core>/instructions`. */
  bundledDir?: string | undefined;
  /** Profile override directory, e.g. `~/.wrongstack/profiles/<name>/instructions`. */
  globalDir?: string | undefined;
  /** Project override directory, e.g. `<project>/.wrongstack/instructions`. */
  projectDir?: string | undefined;
  /**
   * Selects the markdown file used for the system identity layer.
   * Defaults to `system.md`; `lite` reads `system-lite.md`, `pro` reads
   * `system-pro.md`, `scout` reads `system-scout.md` and `quick` reads
   * `system-quick.md` from the same
   * bundled/global/project instruction directories.
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

  let presetInserted = false;
  for (const [index, dir] of dirs.entries()) {
    // Insert the selected profile preset after profile overrides and before
    // repository-supplied guidance, preserving the project's fenced status.
    if (layerNames[index] === 'project' && paths?.globalDir) {
      const presetText = await activeSystemPromptPresetText(
        paths.globalDir,
        paths.systemVariant ?? 'default',
        paths.projectDir,
      );
      if (presetText !== undefined) {
        presetInserted = true;
        bundle = mergeInstructionBundle(bundle, {
          system: { identity: presetText, identitySource: 'global' },
        });
      }
    }
    // The project layer ships with the repository: confine it to the project
    // (`<project>/.wrongstack/instructions` → `<project>`) so a committed
    // symlink cannot pull a file from elsewhere on the host into the prompt.
    const layer = await readInstructionDir(dir, {
      systemFile,
      ...(layerNames[index] === 'project' ? { confineTo: path.resolve(dir, '..', '..') } : {}),
    });
    const source = layerNames[index] ?? 'bundled';
    if (layer.system?.identity !== undefined) {
      layer.system = { ...layer.system, identitySource: source };
      if (source === 'project' && presetInserted) {
        layer.system.trustedIdentity = bundle.system?.identity;
      }
    }
    if (layer.system?.leaderAfterTask !== undefined) {
      layer.system = { ...layer.system, leaderAfterTaskSource: source };
    }
    if (layer.sections !== undefined && Object.keys(layer.sections).length > 0) {
      layer.sectionsSource = source;
    }
    bundle = mergeInstructionBundle(bundle, layer);
  }
  if (paths?.globalDir && !paths.projectDir) {
    const presetText = await activeSystemPromptPresetText(
      paths.globalDir,
      paths.systemVariant ?? 'default',
    );
    if (presetText !== undefined) {
      bundle = mergeInstructionBundle(bundle, {
        system: { identity: presetText, identitySource: 'global' },
      });
    }
  }
  for (const file of paths?.files ?? []) {
    const layer = await readInstructionJson(file);
    if (layer.system?.identity !== undefined) {
      layer.system = { ...layer.system, identitySource: 'file' };
    }
    if (layer.system?.leaderAfterTask !== undefined) {
      layer.system = { ...layer.system, leaderAfterTaskSource: 'file' };
    }
    if (layer.sections !== undefined && Object.keys(layer.sections).length > 0) {
      layer.sectionsSource = 'file';
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
  if (paths?.systemVariant === 'scout') return 'system-scout.md';
  if (paths?.systemVariant === 'quick') return 'system-quick.md';
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
  options: { systemFile: string; confineTo?: string | undefined },
): Promise<InstructionBundle> {
  const [json, identity, leaderAfterTask, sections] = await Promise.all([
    readInstructionJson(path.join(dir, 'instructions.json'), options.confineTo),
    readOptionalText(path.join(dir, options.systemFile), options.confineTo),
    readOptionalText(path.join(dir, 'leader-after-task.md'), options.confineTo),
    readSections(path.join(dir, 'sections'), options.confineTo),
  ]);
  const fromMarkdown: InstructionBundle = {
    system: {
      ...(identity !== undefined ? { identity: expandSharedSystemInstructions(identity) } : {}),
      ...(leaderAfterTask !== undefined ? { leaderAfterTask } : {}),
    },
    sections,
  };
  return mergeInstructionBundle(json, fromMarkdown);
}

async function readSections(
  root: string,
  confineTo?: string | undefined,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  // Entries below are skipped when they are links (Dirent), but `sections`
  // itself is followed by readdir.
  if ((await confinedPath(root, confineTo)) === undefined) return out;
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

async function readInstructionJson(
  file: string,
  confineTo?: string | undefined,
): Promise<InstructionBundle> {
  let raw: string;
  try {
    const real = await confinedPath(file, confineTo);
    if (real === undefined) return {};
    raw = await fs.readFile(real, 'utf8');
  } catch {
    return {};
  }
  try {
    return normalizeInstructionBundle(JSON.parse(raw.replace(/^\uFEFF/, '')));
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

/**
 * `file` itself when nothing confines it; otherwise its real path when that
 * resolves inside `confineTo`, else undefined (missing files too).
 */
async function confinedPath(
  file: string,
  confineTo: string | undefined,
): Promise<string | undefined> {
  if (confineTo === undefined) return file;
  try {
    const [real, root] = await Promise.all([fs.realpath(file), fs.realpath(confineTo)]);
    const rel = path.relative(root, real);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return undefined;
    }
    return real;
  } catch {
    return undefined;
  }
}

async function readOptionalText(
  file: string,
  confineTo?: string | undefined,
): Promise<string | undefined> {
  try {
    const real = await confinedPath(file, confineTo);
    if (real === undefined) return undefined;
    const text = await fs.readFile(real, 'utf8');
    return text.trimEnd();
  } catch {
    return undefined;
  }
}

function defaultBundledInstructionDir(): string {
  const here = moduleDirFor(import.meta.url, '@wrongstack/core');
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
