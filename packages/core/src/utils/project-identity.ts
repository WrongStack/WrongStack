import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { detectVcs } from '../vcs/vcs-adapter.js';
import { atomicWrite } from './atomic-write.js';
import { isUlid, ulid } from './ulid.js';

export const PROJECT_IDENTITY_VERSION = 1 as const;
export const PROJECT_ID_PREFIX = 'proj_';
export const PROJECT_IDENTITY_RELATIVE_PATH = path.join('.wrongstack', 'project.json');

export interface ProjectIdentityFile {
  version: typeof PROJECT_IDENTITY_VERSION;
  projectId: string;
}

export interface EnsureProjectIdentityResult {
  identity: ProjectIdentityFile;
  created: boolean;
}

export interface RekeyProjectIdentityResult {
  previous?: ProjectIdentityFile | undefined;
  identity: ProjectIdentityFile;
}

const PROJECT_GITIGNORE_RULES = [
  '.temp_files/',
  'acp-sessions/',
  '.wrongstack/',
  '!/.wrongstack/',
  '/.wrongstack/*',
  '!/.wrongstack/project.json',
] as const;

/**
 * The same rules for Mercurial, which does not read `.gitignore`. Per-line
 * `re:` leaves the syntax of the rest of the user's file alone. Every
 * `.wrongstack/` file but `project.json` is ignored, at any depth.
 */
const PROJECT_HGIGNORE_HEADER = '# WrongStack local state';
const PROJECT_HGIGNORE_RULES = [
  're:(^|/)\\.temp_files/',
  're:(^|/)acp-sessions/',
  're:(^|/)\\.wrongstack/(?!project\\.json$)',
] as const;

export function projectIdentityPath(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_IDENTITY_RELATIVE_PATH);
}

export function createProjectId(seedTime: number = Date.now()): string {
  return `${PROJECT_ID_PREFIX}${ulid(seedTime)}`;
}

export function isProjectId(value: string): boolean {
  return value.startsWith(PROJECT_ID_PREFIX) && isUlid(value.slice(PROJECT_ID_PREFIX.length));
}

export function readProjectIdentitySync(projectRoot: string): ProjectIdentityFile | undefined {
  const filePath = projectIdentityPath(projectRoot);
  try {
    return parseProjectIdentity(fs.readFileSync(filePath, 'utf8'), filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function readProjectIdentity(
  projectRoot: string,
): Promise<ProjectIdentityFile | undefined> {
  const filePath = projectIdentityPath(projectRoot);
  try {
    return parseProjectIdentity(await fsPromises.readFile(filePath, 'utf8'), filePath);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function ensureProjectIdentity(
  projectRoot: string,
  idFactory: () => string = createProjectId,
): Promise<EnsureProjectIdentityResult> {
  const existing = await readProjectIdentity(projectRoot);
  if (existing) return { identity: existing, created: false };

  const filePath = projectIdentityPath(projectRoot);
  const identity = makeIdentity(idFactory());
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });

  try {
    await fsPromises.writeFile(filePath, serializeProjectIdentity(identity), {
      encoding: 'utf8',
      flag: 'wx',
    });
    return { identity, created: true };
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
    const winner = await readProjectIdentity(projectRoot);
    if (!winner) throw error;
    return { identity: winner, created: false };
  }
}

export async function rekeyProjectIdentity(
  projectRoot: string,
  idFactory: () => string = createProjectId,
): Promise<RekeyProjectIdentityResult> {
  const previous = await readProjectIdentity(projectRoot);
  const identity = makeIdentity(idFactory());
  const filePath = projectIdentityPath(projectRoot);
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  await atomicWrite(filePath, serializeProjectIdentity(identity));
  return { previous, identity };
}

/**
 * Keep local runtime and temporary state ignored while allowing the small,
 * explicitly shared WrongStack project contract to travel with the repository.
 * In a Mercurial repository the repository's `.hgignore` gets the same rules.
 */
export async function ensureProjectGitignore(projectRoot: string): Promise<void> {
  await ensureGitignoreFile(projectRoot);
  const vcs = await detectVcs(projectRoot);
  if (vcs?.kind === 'hg') await ensureHgignoreFile(vcs.root);
}

async function ensureHgignoreFile(repoRoot: string): Promise<void> {
  const filePath = path.join(repoRoot, '.hgignore');
  let content = '';
  try {
    content = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  const present = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = PROJECT_HGIGNORE_RULES.filter((rule) => !present.has(rule));
  if (missing.length === 0) return;
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const block = [
    ...(present.has(PROJECT_HGIGNORE_HEADER) ? [] : [PROJECT_HGIGNORE_HEADER]),
    ...missing,
  ];
  const separator = content.length === 0 ? '' : content.endsWith('\n') ? eol : `${eol}${eol}`;
  await atomicWrite(filePath, `${content}${separator}${block.join(eol)}${eol}`);
}

async function ensureGitignoreFile(projectRoot: string): Promise<void> {
  const filePath = path.join(projectRoot, '.gitignore');
  let content = '';
  try {
    content = await fsPromises.readFile(filePath, 'utf8');
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  const hadTrailingNewline = content.endsWith('\n');
  const lines = content.length === 0 ? [] : content.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();

  let changed = false;
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]?.trim() === '.wrongstack/*') {
      lines[index] = '.wrongstack/';
      changed = true;
    }
  }

  for (const entry of PROJECT_GITIGNORE_RULES) {
    if (!lines.some((line) => line.trim() === entry)) {
      if (entry === '.wrongstack/' && lines.length > 0 && lines.at(-1) !== '') lines.push('');
      lines.push(entry);
      changed = true;
    }
  }

  if (!changed) return;
  // Gitignore is last-match-wins. Appending a missing broad rule (for example
  // `/.wrongstack/*`) AFTER an existing `!/.wrongstack/project.json` re-ignored
  // the committed identity — the exact file this repair exists to keep
  // travelling with the repository. The managed negations therefore always go
  // last, so the repair is independent of where the missing rules landed.
  const managedNegations = new Set(['!/.wrongstack/', '!/.wrongstack/project.json']);
  const withoutManagedNegations = lines.filter((line) => !managedNegations.has(line.trim()));
  lines.length = 0;
  lines.push(...withoutManagedNegations, '!/.wrongstack/', '!/.wrongstack/project.json');
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  await atomicWrite(filePath, `${lines.join(eol)}${eol}`);
}

function makeIdentity(projectId: string): ProjectIdentityFile {
  if (!isProjectId(projectId)) {
    throw new Error(`Invalid WrongStack project id: ${projectId}`);
  }
  return { version: PROJECT_IDENTITY_VERSION, projectId };
}

function parseProjectIdentity(raw: string, filePath: string): ProjectIdentityFile {
  let value: unknown;
  try {
    // A teammate's Windows editor may re-save this committed file with a UTF-8 BOM.
    value = JSON.parse(raw.replace(/^﻿/, ''));
  } catch {
    throw new Error(`Invalid JSON in WrongStack project identity file: ${filePath}`);
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Invalid WrongStack project identity file: ${filePath}`);
  }
  const record = value as Record<string, unknown>;
  if (record['version'] !== PROJECT_IDENTITY_VERSION) {
    throw new Error(`Unsupported WrongStack project identity version in ${filePath}`);
  }
  if (typeof record['projectId'] !== 'string' || !isProjectId(record['projectId'])) {
    throw new Error(`Invalid projectId in WrongStack project identity file: ${filePath}`);
  }
  return { version: PROJECT_IDENTITY_VERSION, projectId: record['projectId'] };
}

function serializeProjectIdentity(identity: ProjectIdentityFile): string {
  return `${JSON.stringify(identity, null, 2)}\n`;
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}
