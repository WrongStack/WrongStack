import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { validateProjectAgentConfig } from './project-agent-config-validation.js';
import type { ProjectAgentConfig } from './project-agent-identity-types.js';
import { roleDir } from './project-agent-paths.js';

/**
 * Load the project-level agent config for a given role.
 * Returns `undefined` when no project override exists.
 *
 * Lives in its own module (rather than in `project-agent-identity.ts`) so the
 * skill layer can read the role's `skillNames` override without importing the
 * identity module, which imports the skill layer.
 */
export function loadProjectAgentConfig(
  role: string,
  projectRoot?: string,
): ProjectAgentConfig | undefined {
  const cfgPath = path.join(roleDir(role, projectRoot), 'config.json');
  try {
    return validateProjectAgentConfig(JSON.parse(readFileSync(cfgPath, 'utf8')));
  } catch {
    return undefined;
  }
}
