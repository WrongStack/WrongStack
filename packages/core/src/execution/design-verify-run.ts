/**
 * Project-level design verify: collect UI files (an explicit list or a bounded
 * walk) and run `verifyFiles` on them. Node IO lives here so the rule engine in
 * `design-verify.ts` stays a pure function of file text.
 */

import type { DesignKitTokens } from '@wrongstack/contracts/types/design-kit';
import { type DesignVerifyReport, verifyFiles } from './design-verify.js';

const UI_EXT_RE = /\.(css|scss|sass|less|tsx|jsx|vue|svelte|astro|html?)$/i;
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  '.wrongstack',
  '.design',
]);

/** Bounded recursive walk for frontend files under a project root. */
async function walkUiFiles(root: string, max = 200): Promise<string[]> {
  const { default: fs } = await import('node:fs/promises');
  const { default: nodePath } = await import('node:path');
  const found: string[] = [];
  async function rec(dir: string, depth: number): Promise<void> {
    if (found.length >= max || depth > 8) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= max) return;
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || e.name.startsWith('.')) continue;
        await rec(nodePath.join(dir, e.name), depth + 1);
      } else if (UI_EXT_RE.test(e.name)) {
        found.push(nodePath.join(dir, e.name));
      }
    }
  }
  await rec(root, 0);
  return found;
}

/**
 * Resolve + read UI files (explicit list, or a bounded walk) and verify them
 * against a kit's tokens. Shared by the `design` tool and the WebUI handler so
 * the file-collection rules stay identical.
 */
export async function runDesignVerify(
  projectRoot: string,
  tokens: DesignKitTokens,
  explicitFiles?: string[] | undefined,
): Promise<DesignVerifyReport> {
  const { default: fs } = await import('node:fs/promises');
  const { default: nodePath } = await import('node:path');
  const abs =
    explicitFiles && explicitFiles.length > 0
      ? explicitFiles.map((f) => (nodePath.isAbsolute(f) ? f : nodePath.join(projectRoot, f)))
      : await walkUiFiles(projectRoot);
  const files: { path: string; text: string }[] = [];
  for (const a of abs) {
    try {
      files.push({ path: nodePath.relative(projectRoot, a), text: await fs.readFile(a, 'utf8') });
    } catch {
      // unreadable — skip
    }
  }
  return verifyFiles(tokens, files);
}
