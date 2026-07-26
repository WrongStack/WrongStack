import * as path from 'node:path';
import { projectSlug } from '../utils/wstack-paths.js';

export const GLOBAL_MAILBOX_FILE = '_mailbox.jsonl';
export const GLOBAL_MAILBOX_CLIENT_REGISTRY_FILE = '_mailbox.clients.json';

/**
 * Derive the project-level mailbox directory path.
 *
 * Delegates to the canonical projectSlug() from wstack-paths so every surface
 * lands in the same ~/.wrongstack/projects/<slug>/ directory.
 */
export function resolveProjectDir(projectRoot: string, globalRoot: string): string {
  return path.join(globalRoot, 'projects', projectSlug(projectRoot));
}
