import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type {
  CreateProjectAgentInput,
  ProjectAgentProfile,
} from './project-agent-identity-types.js';
import {
  assertProjectAgentRole,
  projectAgentProfilePath,
  roleDir,
  writeTextAtomically,
} from './project-agent-paths.js';

export function slugifyProjectAgentRole(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 96);
  return assertProjectAgentRole(slug);
}

export function loadProjectAgentProfile(
  role: string,
  projectRoot?: string,
): ProjectAgentProfile | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(projectAgentProfilePath(role, projectRoot), 'utf8'),
    ) as Partial<ProjectAgentProfile>;
    const normalizedRole = assertProjectAgentRole(parsed.role ?? role);
    const baseRole = assertProjectAgentRole(parsed.baseRole ?? 'generic');
    if (normalizedRole !== assertProjectAgentRole(role)) return undefined;
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return undefined;
    if (typeof parsed.purpose !== 'string' || !parsed.purpose.trim()) return undefined;
    if (
      !Array.isArray(parsed.taskTypes) ||
      parsed.taskTypes.some((item) => typeof item !== 'string')
    ) {
      return undefined;
    }
    const createdAt =
      typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString();
    const updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : createdAt;
    return {
      role: normalizedRole,
      name: parsed.name.trim(),
      baseRole,
      purpose: parsed.purpose.trim(),
      taskTypes: parsed.taskTypes.map((item) => item.trim()).filter(Boolean),
      createdAt,
      updatedAt,
    };
  } catch {
    return undefined;
  }
}

/** Create a new, independently-learning project role from a roster template. */
export function createProjectAgent(
  input: CreateProjectAgentInput,
  projectRoot?: string,
): ProjectAgentProfile {
  const name = input.name.trim();
  const purpose = input.purpose.trim();
  if (!name || name.length > 120) throw new Error('Project agent name must be 1-120 characters.');
  if (purpose.length < 10 || purpose.length > 4_000) {
    throw new Error('Project agent purpose must be 10-4000 characters.');
  }
  const role = assertProjectAgentRole(
    (input.role?.trim() || slugifyProjectAgentRole(name)).toLowerCase(),
  );
  const baseRole = assertProjectAgentRole((input.baseRole?.trim() || 'generic').toLowerCase());
  const taskTypes = [...new Set(input.taskTypes.map((item) => item.trim()).filter(Boolean))];
  if (
    taskTypes.length === 0 ||
    taskTypes.length > 32 ||
    taskTypes.some((item) => item.length > 160)
  ) {
    throw new Error('Project agent requires 1-32 task descriptions, each at most 160 characters.');
  }

  const dir = roleDir(role, projectRoot);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    throw new Error(`Project agent role "${role}" already exists.`);
  }
  const now = new Date().toISOString();
  const profile: ProjectAgentProfile = {
    role,
    name,
    baseRole,
    purpose,
    taskTypes,
    createdAt: now,
    updatedAt: now,
  };
  const identity = [
    `# ${name}`,
    '',
    `You are the project-specific "${name}" agent (role: ${role}).`,
    '',
    '## Purpose',
    '',
    purpose,
    '',
    '## Primary task types',
    '',
    ...taskTypes.map((item) => `- ${item}`),
    '',
    'Learn durable project conventions from completed work, keep conclusions evidence-based, and stay within this assigned purpose.',
    '',
  ].join('\n');

  mkdirSync(dir, { recursive: true });
  writeTextAtomically(path.join(dir, 'identity.md'), identity);
  writeTextAtomically(
    projectAgentProfilePath(role, projectRoot),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
  return profile;
}
