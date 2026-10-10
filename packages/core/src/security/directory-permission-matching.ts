/**
 * Target-path extraction and rule matching for the directory-scoped
 * permission policy. Split out of directory-permission-policy.ts; see that
 * file for rule precedence.
 */

import * as path from 'node:path';
import type { Context } from '../core/context.js';
import type { DirectoryPolicy, DirectoryRule, PermissionDecision } from '../types/permission.js';
import { matchAny, matchGlob } from '../utils/glob-match.js';

const PATH_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'filepath',
  'filename',
  'target',
  'targetPath',
  'file_path',
  'filePath',
  'directory',
  'dir',
  'cwd',
  'workdir',
  'root',
  'baseDir',
  'out',
  'outputPath',
  'sourcePath',
  'destinationPath',
  'fromPath',
  'toPath',
  'worktreePath',
]);

function extractPathInputs(input: unknown): string[] {
  if (!input || typeof input !== 'object') return [];
  const obj = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value.length > 0) {
      const values = key === 'paths' || key === 'files' ? value.split(',') : [value];
      for (const item of values) {
        const trimmed = item.trim();
        if (trimmed.length > 0) paths.push(trimmed);
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) paths.push(item);
      }
    }
  }
  return [...new Set(paths)];
}

/**
 * Resolve a tool input's target path against `ctx.workingDir` and
 * normalize it to forward slashes. Returns `undefined` when the input
 * has no path-like subject — the caller must then pass through.
 *
 * The returned path is RELATIVE to `ctx.projectRoot` (when the target
 * lives inside the project) so that user-authored globs like
 * `infra/star-star` match the project-relative shape regardless of
 * where the project is checked out on disk. When the target escapes
 * the project root the absolute path is returned unchanged, prefixed
 * with `..` so leading-wildcard patterns still match.
 */
function resolveRawTargetPath(raw: string, ctx: Context): string {
  // If the path is absolute, use it directly. Otherwise resolve against
  // workingDir. We deliberately do NOT use projectRoot here — the agent
  // may have set a working directory inside the project, and the rule
  // should follow its position, not the project root.
  const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ctx.workingDir, raw);
  const normalizedAbsolute = path.resolve(absolute).replace(/\\/g, '/');

  // Strip the project-root prefix so user globs like `infra/**` match
  // the project-relative shape. When the target is outside the project
  // we keep the absolute path with a `..` marker so leading-wildcard
  // patterns like `**/secrets/**` still work.
  const projectRoot = path.resolve(ctx.projectRoot).replace(/\\/g, '/');
  return path.relative(projectRoot, normalizedAbsolute).replace(/\\/g, '/');
}

export function resolveTargetPaths(input: unknown, ctx: Context): string[] {
  // Preserve raw filesystem paths until after path.resolve(). Trust-pattern
  // subjects glob-escape characters such as `[` and `]`, which would change
  // real filenames and let matching rules observe a different path.
  return extractPathInputs(input).map((raw) => resolveRawTargetPath(raw, ctx));
}

export function resolveGlobSelectors(input: unknown, ctx: Context): Set<string> {
  if (!input || typeof input !== 'object') return new Set();
  const obj = input as Record<string, unknown>;
  const selectors: string[] = [];
  for (const key of ['paths', 'files'] as const) {
    const value = obj[key];
    const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    for (const item of values) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed.length > 0 && /[*?[\]]/.test(trimmed))
        selectors.push(resolveRawTargetPath(trimmed, ctx));
    }
  }
  return new Set(selectors);
}

function literalGlobPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*?[\]]/);
  const prefix = (wildcardIndex < 0 ? pattern : pattern.slice(0, wildcardIndex)).replace(
    /\/+$/,
    '',
  );
  return prefix === '.' ? '' : prefix;
}

function selectorMayOverlapRule(selector: string, rulePattern: string): boolean {
  const selectorPrefix = literalGlobPrefix(selector);
  const rulePrefix = literalGlobPrefix(rulePattern);
  if (!selectorPrefix || !rulePrefix) return true;
  return (
    selectorPrefix === rulePrefix ||
    selectorPrefix.startsWith(`${rulePrefix}/`) ||
    rulePrefix.startsWith(`${selectorPrefix}/`)
  );
}

export function matchTargetRule(
  policy: DirectoryPolicy,
  targetPath: string,
  globSelectors: ReadonlySet<string>,
): DirectoryRule | undefined {
  if (!globSelectors.has(targetPath)) return matchRule(policy, targetPath);
  const overlappingPolicy: DirectoryPolicy = {
    schemaVersion: policy.schemaVersion,
    rules: policy.rules.filter((rule) => selectorMayOverlapRule(targetPath, rule.directory)),
  };
  if (overlappingPolicy.rules.length === 0) return undefined;
  return overlappingPolicy.rules.reduce((best, rule) =>
    patternSpecificity(rule.directory) > patternSpecificity(best.directory) ? rule : best,
  );
}

/**
 * Resolve the first tool-input target path against `ctx.workingDir` and
 * normalize it to forward slashes. Multi-target enforcement uses every path
 * internally; this helper retains its historical first-target public contract.
 */
export function resolveTargetPath(input: unknown, ctx: Context): string | undefined {
  return resolveTargetPaths(input, ctx)[0];
}

/**
 * Compute a "specificity" score for a directory pattern. Patterns with
 * more literal characters (and fewer wildcards) score higher. Used to
 * break ties when multiple rules match the same path.
 *
 * Examples (approximate scores):
 *   infra star-star            → 5
 *   infra slash terraform star-star → 14
 *   secrets subdir star-star   → 8
 *   clients slash acme star-star → 11
 */
function patternSpecificity(pattern: string): number {
  let score = 0;
  for (const ch of pattern) {
    if (ch === '*' || ch === '?' || ch === '[' || ch === ']') continue;
    score++;
  }
  // A trailing /** is the common "directory subtree" marker — give a
  // small bonus so `infra/terraform/**` beats `infra/**` even when the
  // literal count is close.
  if (pattern.endsWith('/**')) score += 1;
  return score;
}

/**
 * A rule names a directory, so it covers a path that matches its pattern AND
 * everything below a directory that does. Matching the file path alone made a
 * plain `"directory": "secrets"` (the shape `DirectoryRule` documents: the
 * pattern is matched against the directory portion) cover the directory's own
 * path and none of its files, so a `write` to `secrets/key.pem` sailed
 * through a rule that validated and read as a ban. Only `secrets/**` worked.
 */
/**
 * ASCII case fold. Windows paths are case-insensitive; `String.toLowerCase`
 * follows the process locale (`I` → `ı` under Turkish) and would make a
 * rule miss. Non-ASCII folding is left to the filesystem.
 */
function foldFsPath(value: string): string {
  if (process.platform !== 'win32') return value;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : value[i]!;
  }
  return out;
}

function ruleCoversPath(pattern: string, targetPath: string): boolean {
  const foldedPattern = foldFsPath(pattern);
  const foldedTarget = foldFsPath(targetPath);
  if (matchGlob(foldedPattern, foldedTarget)) return true;
  // A call rooted AT the directory (a shell cwd, a recursive grep/glob path)
  // reaches everything below it, but the canonical `dir/**` shape does not
  // match the bare `dir`; its directory form `dir/` does.
  if (foldedTarget.length > 0 && matchGlob(foldedPattern, `${foldedTarget}/`)) return true;
  for (
    let cut = foldedTarget.lastIndexOf('/');
    cut > 0;
    cut = foldedTarget.lastIndexOf('/', cut - 1)
  ) {
    if (matchGlob(foldedPattern, foldedTarget.slice(0, cut))) return true;
  }
  return false;
}

/**
 * Find the most-specific rule that matches the target path. Returns
 * undefined when no rule matches. Specificity is computed as the
 * pattern's literal-character length with a small bonus for trailing
 * `/**`. Ties resolve to first-declared order.
 */
export function matchRule(policy: DirectoryPolicy, targetPath: string): DirectoryRule | undefined {
  let best: { rule: DirectoryRule; specificity: number; index: number } | undefined;
  for (const [index, rule] of policy.rules.entries()) {
    if (!ruleCoversPath(rule.directory, targetPath)) continue;
    const specificity = patternSpecificity(rule.directory);
    if (
      best === undefined ||
      specificity > best.specificity ||
      (specificity === best.specificity && index < best.index)
    ) {
      best = { rule, specificity, index };
    }
  }
  return best?.rule;
}

export function deny(
  reason: string,
  rule: DirectoryRule,
  matchedConstraint: 'denyTools' | 'denyProviders' | 'allowOnlyTools',
  toolName: string,
): PermissionDecision {
  const detail = rule.description ? ` (${rule.description})` : '';
  return {
    permission: 'deny',
    source: 'directory_rules',
    reason: `directory rule "${rule.directory}" denied ${matchedConstraint} for "${toolName}"${detail}: ${reason}`,
  };
}

export function isToolInList(toolName: string, list: readonly string[]): boolean {
  return matchAny([...list], toolName);
}

export function clonePolicy(policy: DirectoryPolicy): DirectoryPolicy {
  return {
    schemaVersion: policy.schemaVersion,
    rules: policy.rules.map((rule) => {
      const cloned = { ...rule };
      if (rule.denyTools) cloned.denyTools = [...rule.denyTools];
      if (rule.denyProviders) cloned.denyProviders = [...rule.denyProviders];
      if (rule.allowOnlyTools) cloned.allowOnlyTools = [...rule.allowOnlyTools];
      return cloned;
    }),
  };
}
