import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RUNTIME_CAPABILITY_MANIFEST } from '@wrongstack/contracts/types/runtime-capability-manifest';
import type { SystemInstructionVariant } from '@wrongstack/contracts/types/system-prompt';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import {
  expandSharedSystemInstructions,
  readBundledInstructionText,
} from '../utils/instruction-file.js';

export type { SystemInstructionVariant };

export interface SystemPromptPreset {
  id: string;
  name: string;
  baseVariant: SystemInstructionVariant;
  baseHash: string;
  baseText: string;
  text: string;
  revision: number;
}

export interface PromptValidationIssue {
  severity: 'error' | 'warning';
  line: number;
  message: string;
}

const FILES: Record<SystemInstructionVariant, string> = {
  default: 'system.md',
  lite: 'system-lite.md',
  pro: 'system-pro.md',
  scout: 'system-scout.md',
};
const PRESET_ID = /^[a-f0-9-]{36}$/;
const MAX_TEXT = 200_000;
const BUILTIN_TOOLS: ReadonlySet<string> = new Set(
  RUNTIME_CAPABILITY_MANIFEST.flatMap((entry) => [...entry.tools]),
);
let presetGeneration = 0;
export function systemPromptPresetGeneration(): number {
  return presetGeneration;
}

export function bundledPromptText(variant: SystemInstructionVariant): string {
  return expandSharedSystemInstructions(readBundledInstructionText(FILES[variant]));
}

export function promptTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Strict editor validation. Runtime template rendering is intentionally fail-open. */
export function validateSystemPromptPreset(text: string): PromptValidationIssue[] {
  const issues: PromptValidationIssue[] = [];
  if (!text.trim()) issues.push({ severity: 'error', line: 1, message: 'Prompt cannot be empty.' });
  if (text.length > MAX_TEXT)
    issues.push({ severity: 'error', line: 1, message: 'Prompt exceeds 200,000 characters.' });
  const stack: Array<{ line: number; elseSeen: boolean }> = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const lineNo = index + 1;
    for (const marker of line.matchAll(/<!--\s*ws:(if|else|end)\b([^>]*?)-->/g)) {
      const kind = marker[1];
      if (kind === 'if') {
        const attrs = (marker[2] ?? '').trim().split(/\s+/).filter(Boolean);
        if (
          !attrs.length ||
          attrs.some(
            (attr) =>
              !/^!?((tool=[\w.,-]+)|(tier=(off|minimal|light|medium|aggressive)(,(off|minimal|light|medium|aggressive))*)|(role=(leader|subagent)(,(leader|subagent))*))$/.test(
                attr,
              ),
          )
        ) {
          issues.push({ severity: 'error', line: lineNo, message: 'Invalid ws:if condition.' });
        }
        for (const attr of attrs) {
          const toolList = /^!?tool=([\w.,-]+)$/.exec(attr)?.[1];
          if (!toolList) continue;
          for (const tool of toolList.split(',')) {
            if (!BUILTIN_TOOLS.has(tool)) {
              issues.push({
                severity: 'warning',
                line: lineNo,
                message: `“${tool}” is not a built-in tool. Check that this integration supplies it.`,
              });
            }
          }
        }
        stack.push({ line: lineNo, elseSeen: false });
      } else if (kind === 'else') {
        const open = stack[stack.length - 1];
        if (!open || open.elseSeen)
          issues.push({ severity: 'error', line: lineNo, message: 'Unexpected ws:else.' });
        else if (open) open.elseSeen = true;
      } else if (!stack.pop())
        issues.push({ severity: 'error', line: lineNo, message: 'Unexpected ws:end.' });
    }
    if (/<!--\s*ws:/.test(line) && !/<!--\s*ws:(if|else|end)\b[^>]*-->/.test(line)) {
      issues.push({
        severity: 'error',
        line: lineNo,
        message: 'Unknown or incomplete ws directive.',
      });
    }
    for (const placeholder of line.matchAll(/\{\{\s*tools:([^}]*)}}/g)) {
      const names = (placeholder[1] ?? '').split(',').map((name) => name.trim());
      if (names.some((name) => !/^[\w.-]+$/.test(name))) {
        issues.push({ severity: 'error', line: lineNo, message: 'Invalid tools placeholder.' });
      }
    }
  }
  for (const open of stack)
    issues.push({ severity: 'error', line: open.line, message: 'Unclosed ws:if block.' });
  if (/\{\{shared:/.test(text))
    issues.push({
      severity: 'error',
      line: 1,
      message: 'Shared fragments must be expanded before saving.',
    });
  return issues;
}

function directory(globalInstructions: string): string {
  return path.join(globalInstructions, 'system-prompt-presets');
}

function fileFor(globalInstructions: string, id: string): string {
  if (!PRESET_ID.test(id)) throw new Error('Invalid preset id.');
  return path.join(directory(globalInstructions), `${id}.json`);
}

function validateRecord(value: unknown): SystemPromptPreset {
  if (!value || typeof value !== 'object') throw new Error('Invalid preset file.');
  const p = value as Partial<SystemPromptPreset>;
  if (
    !p.id ||
    !PRESET_ID.test(p.id) ||
    typeof p.name !== 'string' ||
    !p.name.trim() ||
    p.name.length > 80 ||
    !(typeof p.baseVariant === 'string' && Object.hasOwn(FILES, p.baseVariant)) ||
    typeof p.baseHash !== 'string' ||
    typeof p.baseText !== 'string' ||
    typeof p.text !== 'string' ||
    !Number.isSafeInteger(p.revision) ||
    (p.revision ?? 0) < 1
  )
    throw new Error('Invalid preset file.');
  if (validateSystemPromptPreset(p.text).some((issue) => issue.severity === 'error'))
    throw new Error('Preset file contains invalid instructions.');
  return p as SystemPromptPreset;
}

export async function readSystemPromptPreset(
  globalInstructions: string,
  id: string,
): Promise<SystemPromptPreset> {
  return validateRecord(JSON.parse(await fs.readFile(fileFor(globalInstructions, id), 'utf8')));
}

export async function listSystemPromptPresets(
  globalInstructions: string,
): Promise<SystemPromptPreset[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory(globalInstructions));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const presets: SystemPromptPreset[] = [];
  for (const name of names) {
    if (!PRESET_ID.test(name.replace(/\.json$/, '')) || !name.endsWith('.json')) continue;
    presets.push(await readSystemPromptPreset(globalInstructions, name.slice(0, -5)));
  }
  return presets.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createSystemPromptPreset(
  globalInstructions: string,
  name: string,
  baseVariant: SystemInstructionVariant,
): Promise<SystemPromptPreset> {
  if (!name.trim() || name.length > 80) throw new Error('Preset name must be 1–80 characters.');
  const baseText = bundledPromptText(baseVariant);
  if (!baseText) throw new Error('Bundled system prompt is unavailable.');
  const preset: SystemPromptPreset = {
    id: randomUUID(),
    name: name.trim(),
    baseVariant,
    baseHash: promptTextHash(baseText),
    baseText,
    text: baseText,
    revision: 1,
  };
  await fs.mkdir(directory(globalInstructions), { recursive: true });
  await atomicWrite(fileFor(globalInstructions, preset.id), JSON.stringify(preset, null, 2));
  presetGeneration++;
  return preset;
}

export async function saveSystemPromptPreset(
  globalInstructions: string,
  id: string,
  revision: number,
  name: string,
  text: string,
  reviewedCurrentSource = false,
): Promise<SystemPromptPreset> {
  const issues = validateSystemPromptPreset(text);
  if (issues.some((issue) => issue.severity === 'error'))
    throw new Error(issues.map((issue) => `Line ${issue.line}: ${issue.message}`).join('\n'));
  if (!name.trim() || name.length > 80) throw new Error('Preset name must be 1–80 characters.');
  const file = fileFor(globalInstructions, id);
  return withFileLock(file, async () => {
    const current = await readSystemPromptPreset(globalInstructions, id);
    if (current.revision !== revision)
      throw new Error('Preset changed elsewhere. Reload before saving.');
    const baseText = reviewedCurrentSource
      ? bundledPromptText(current.baseVariant)
      : current.baseText;
    const next = {
      ...current,
      name: name.trim(),
      text,
      baseText,
      baseHash: promptTextHash(baseText),
      revision: revision + 1,
    };
    await atomicWrite(file, JSON.stringify(next, null, 2));
    presetGeneration++;
    return next;
  });
}

type ActivePresets = Partial<Record<SystemInstructionVariant, string>>;
const activeFile = (globalInstructions: string) =>
  path.join(directory(globalInstructions), 'active.json');
const projectsFile = (globalInstructions: string) =>
  path.join(directory(globalInstructions), 'projects.json');
const projectKey = (projectDir: string) =>
  promptTextHash(
    process.platform === 'win32'
      ? path.resolve(projectDir).toLowerCase()
      : path.resolve(projectDir),
  );

function parseActivePresets(raw: Record<string, unknown>): ActivePresets {
  const active: ActivePresets = {};
  for (const variant of Object.keys(FILES) as SystemInstructionVariant[]) {
    if (typeof raw[variant] === 'string' && PRESET_ID.test(raw[variant]))
      active[variant] = raw[variant];
  }
  return active;
}

async function readProjectMap(globalInstructions: string): Promise<Record<string, ActivePresets>> {
  try {
    const raw = JSON.parse(await fs.readFile(projectsFile(globalInstructions), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([key, value]) => /^[a-f0-9]{64}$/.test(key) && value && typeof value === 'object')
        .map(([key, value]) => [key, parseActivePresets(value)]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function readProjectSystemPromptPresets(
  globalInstructions: string,
  projectDir: string,
): Promise<ActivePresets> {
  return (await readProjectMap(globalInstructions))[projectKey(projectDir)] ?? {};
}

export async function readActiveSystemPromptPresets(
  globalInstructions: string,
): Promise<ActivePresets> {
  try {
    const raw = JSON.parse(await fs.readFile(activeFile(globalInstructions), 'utf8')) as Record<
      string,
      unknown
    >;
    return parseActivePresets(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function activateSystemPromptPreset(
  globalInstructions: string,
  variant: SystemInstructionVariant,
  id?: string,
  projectDir?: string,
): Promise<void> {
  if (id) {
    const preset = await readSystemPromptPreset(globalInstructions, id);
    if (preset.baseVariant !== variant) throw new Error('Preset base variant does not match.');
  }
  await fs.mkdir(directory(globalInstructions), { recursive: true });
  if (projectDir) {
    await withFileLock(projectsFile(globalInstructions), async () => {
      const projects = await readProjectMap(globalInstructions);
      const key = projectKey(projectDir);
      const active = projects[key] ?? {};
      if (id) active[variant] = id;
      else delete active[variant];
      if (Object.keys(active).length) projects[key] = active;
      else delete projects[key];
      await atomicWrite(projectsFile(globalInstructions), JSON.stringify(projects, null, 2));
      presetGeneration++;
    });
  } else {
    await withFileLock(activeFile(globalInstructions), async () => {
      const active = await readActiveSystemPromptPresets(globalInstructions);
      if (id) active[variant] = id;
      else delete active[variant];
      await atomicWrite(activeFile(globalInstructions), JSON.stringify(active, null, 2));
      presetGeneration++;
    });
  }
}

export async function deleteSystemPromptPreset(
  globalInstructions: string,
  id: string,
): Promise<void> {
  const preset = await readSystemPromptPreset(globalInstructions, id);
  const active = await readActiveSystemPromptPresets(globalInstructions);
  if (active[preset.baseVariant] === id)
    throw new Error('Deactivate this preset before deleting it.');
  const projects = await readProjectMap(globalInstructions);
  if (Object.values(projects).some((selection) => selection[preset.baseVariant] === id))
    throw new Error('Deactivate this preset in its projects before deleting it.');
  await fs.unlink(fileFor(globalInstructions, id));
  presetGeneration++;
}

export async function activeSystemPromptPresetText(
  globalInstructions: string,
  variant: SystemInstructionVariant,
  projectDir?: string,
): Promise<string | undefined> {
  const project = projectDir
    ? (await readProjectSystemPromptPresets(globalInstructions, projectDir))[variant]
    : undefined;
  const id = project ?? (await readActiveSystemPromptPresets(globalInstructions))[variant];
  if (!id) return undefined;
  const preset = await readSystemPromptPreset(globalInstructions, id);
  if (preset.baseVariant !== variant) throw new Error('Active preset base variant does not match.');
  return preset.text;
}

/** Detect changes made by another running WebUI process without reloading a
 * full prompt on every agent turn. The small selection maps are read each time;
 * the selected preset is checked by file identity and nanosecond mtime. */
export async function systemPromptPresetCacheKey(
  globalInstructions: string,
  variant: SystemInstructionVariant,
  projectDir?: string,
): Promise<string> {
  const project = projectDir
    ? (await readProjectSystemPromptPresets(globalInstructions, projectDir))[variant]
    : undefined;
  const id = project ?? (await readActiveSystemPromptPresets(globalInstructions))[variant];
  if (!id) return '';
  const stat = await fs.stat(fileFor(globalInstructions, id), { bigint: true });
  return `${id}:${stat.mtimeNs}:${stat.size}`;
}
