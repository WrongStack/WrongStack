import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { removePathSync } from '@wrongstack/primitives';

const AGENT_ROLE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,95}$/i;

export function assertProjectAgentRole(role: string): string {
  const normalized = role.trim();
  if (
    !AGENT_ROLE_PATTERN.test(normalized) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\')
  ) {
    throw new Error(`Invalid project agent role: "${role}".`);
  }
  return normalized;
}

export function isProjectAgentRoleName(name: string): boolean {
  return typeof name === 'string' && AGENT_ROLE_PATTERN.test(name) && name !== '.' && name !== '..';
}

export function agentsDir(projectRoot?: string): string {
  const root = projectRoot ?? process.cwd();
  return path.join(root, '.wrongstack', 'agents');
}

export function roleDir(role: string, projectRoot?: string): string {
  return path.join(agentsDir(projectRoot), assertProjectAgentRole(role));
}

/**
 * Read a role file that is about to be rewritten from what it holds. Only a
 * missing file is empty: an unreadable one (EBUSY from an AV scan, EPERM, EIO)
 * read as '' was re-rendered from nothing over every lesson the role had.
 */
export function readRoleFileForUpdate(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

export function writeTextAtomically(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, content, 'utf8');
    renameSync(temporaryPath, filePath);
  } finally {
    try {
      removePathSync(temporaryPath, { force: true });
    } catch {
      // Best-effort cleanup after a failed rename.
    }
  }
}

export function learningPolicyPath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'learning.json');
}

export function projectAgentProfilePath(role: string, projectRoot?: string): string {
  return path.join(roleDir(role, projectRoot), 'profile.json');
}
