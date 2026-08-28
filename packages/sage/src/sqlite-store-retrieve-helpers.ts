import { normalizeProjectPath } from './paths.js';
import { escapeGlobPattern, escapeLikePattern } from './sqlite-store-pagination.js';

type RetrievePathTargets = {
  relPaths: string[];
  targetList: string[];
  symbolGlobs: string[];
};

type RetrieveFallbackQuery = {
  conditions: string[];
  params: string[];
};

export function buildRetrievePathTargets(
  projectRoot: string,
  paths: readonly string[],
  includeAncestors: boolean,
): RetrievePathTargets {
  const relPaths: string[] = [];
  for (const p of paths) {
    try {
      relPaths.push(normalizeProjectPath(projectRoot, p));
    } catch {
      // Path outside the project root — no stored anchor can match it.
    }
  }

  const targets = new Set<string>();
  const symbolGlobs: string[] = [];
  for (const normalized of relPaths) {
    targets.add(`file:${normalized}`);
    symbolGlobs.push(`symbol:${escapeGlobPattern(normalized)}#*`);
    if (includeAncestors) {
      const parts = normalized.split('/').filter(Boolean);
      for (let i = parts.length; i >= 1; i--) {
        const ancestor = parts.slice(0, i).join('/');
        targets.add(`file:${ancestor}`);
        targets.add(`dir:${ancestor}`);
      }
    }
  }

  return { relPaths, targetList: [...targets], symbolGlobs };
}

export function buildRetrieveFallbackQuery(
  relPaths: readonly string[],
  includeAncestors: boolean,
): RetrieveFallbackQuery {
  const conditions: string[] = [];
  const params: string[] = [];
  for (const normalized of relPaths) {
    pushPathCondition(conditions, params, normalized);
    if (includeAncestors) {
      const parts = normalized.split('/').filter(Boolean);
      for (let i = parts.length; i >= 1; i--) {
        pushPathCondition(conditions, params, parts.slice(0, i).join('/'));
      }
    }
  }
  return { conditions, params };
}

function pushPathCondition(conditions: string[], params: string[], path: string): void {
  const jsonEncoded = JSON.stringify(path);
  params.push(`%"path":${escapeLikePattern(jsonEncoded)}%`);
  conditions.push("LOWER(data) LIKE ? ESCAPE '\\'");
}
