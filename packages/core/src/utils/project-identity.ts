import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
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
  '.wrongstack/',
  '!/.wrongstack/',
  '/.wrongstack/*',
  '!/.wrongstack/project.json',
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
 */
export async function ensureProjectGitignore(projectRoot: string): Promise<void> {
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
    value = JSON.parse(raw);
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
