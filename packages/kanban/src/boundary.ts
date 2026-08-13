import * as path from 'node:path';
import type {
  KanbanBoard,
  KanbanBoundaryAccess,
  KanbanBoundaryPolicy,
  KanbanBoundarySelector,
  KanbanTask,
} from './types.js';

export type KanbanBoundaryDecision = 'allow' | 'confirm' | 'block';

export interface KanbanBoundaryEvaluation {
  decision: KanbanBoundaryDecision;
  reason?: string | undefined;
  path?: string | undefined;
  source?: 'board' | 'task' | undefined;
}

export interface KanbanBoundaryLayer {
  source: 'board' | 'task';
  policy: KanbanBoundaryPolicy;
}

export function resolveKanbanBoundaryLayers(
  board: Pick<KanbanBoard, 'boundary'>,
  task?: Pick<KanbanTask, 'boundary'> | null,
): KanbanBoundaryLayer[] {
  const layers: KanbanBoundaryLayer[] = [];
  if (board.boundary?.enabled) layers.push({ source: 'board', policy: board.boundary });
  if (task?.boundary?.enabled) layers.push({ source: 'task', policy: task.boundary });
  return layers;
}

export function evaluateKanbanBoundaryPath(
  layers: readonly KanbanBoundaryLayer[],
  resourcePath: string,
  access: 'read' | 'write',
): KanbanBoundaryEvaluation {
  if (layers.length === 0) return { decision: 'allow' };
  const normalized = normalizeBoundaryPath(resourcePath);
  if (!normalized) {
    return strongestViolation(
      layers.map((layer) => ({
        decision: layer.policy.enforcement,
        source: layer.source,
        reason: `Path "${resourcePath}" is absolute or escapes the project root.`,
      })),
    );
  }

  const violations: KanbanBoundaryEvaluation[] = [];
  for (const layer of layers) {
    const denied = (layer.policy.deny ?? []).find(
      (selector) => accessMatches(selector.access, access) && selectorMatches(selector, normalized),
    );
    if (denied) {
      violations.push({
        decision: layer.policy.enforcement,
        source: layer.source,
        path: normalized,
        reason: `${capitalize(layer.source)} boundary denies ${access} access to "${normalized}" (${describeSelector(denied)}).`,
      });
      continue;
    }

    const relevantAllow = layer.policy.allow.filter((selector) =>
      accessMatches(selector.access, access),
    );
    if (
      relevantAllow.length > 0 &&
      !relevantAllow.some((selector) => selectorMatches(selector, normalized))
    ) {
      violations.push({
        decision: layer.policy.enforcement,
        source: layer.source,
        path: normalized,
        reason: `${capitalize(layer.source)} boundary does not allow ${access} access to "${normalized}".`,
      });
    }
  }
  return violations.length > 0
    ? strongestViolation(violations)
    : { decision: 'allow', path: normalized };
}

export function evaluateKanbanBoundaryOpaque(
  layers: readonly KanbanBoundaryLayer[],
  toolName: string,
): KanbanBoundaryEvaluation {
  const violations = layers
    .filter((layer) => layer.policy.shellAccess !== 'allow')
    .map<KanbanBoundaryEvaluation>((layer) => ({
      decision: layer.policy.shellAccess,
      source: layer.source,
      reason: `${capitalize(layer.source)} boundary requires ${layer.policy.shellAccess} for opaque tool "${toolName}" because its filesystem effects cannot be proven in advance.`,
    }));
  return violations.length > 0 ? strongestViolation(violations) : { decision: 'allow' };
}

export function normalizeKanbanBoundaryPolicy(policy: KanbanBoundaryPolicy): KanbanBoundaryPolicy {
  const normalizeSelector = (selector: KanbanBoundarySelector): KanbanBoundarySelector => {
    if (!selector || typeof selector !== 'object' || Array.isArray(selector)) {
      throw new Error('Kanban boundary selectors must be objects.');
    }
    if (!['file', 'directory', 'package', 'glob'].includes(selector.kind)) {
      throw new Error(`Unknown Kanban boundary selector kind: ${String(selector.kind)}`);
    }
    if (!['read', 'write', 'read_write'].includes(selector.access)) {
      throw new Error(`Unknown Kanban boundary selector access: ${String(selector.access)}`);
    }
    if (typeof selector.path !== 'string') {
      throw new Error('Kanban boundary selector paths must be strings.');
    }
    if (selector.note !== undefined && typeof selector.note !== 'string') {
      throw new Error('Kanban boundary selector notes must be strings.');
    }
    const normalized = normalizeBoundaryPath(selector.path);
    if (!normalized) {
      throw new Error(`Kanban boundary path must stay inside the project: ${selector.path}`);
    }
    return {
      kind: selector.kind,
      access: selector.access,
      path: normalized,
      ...(selector.note !== undefined ? { note: selector.note } : {}),
    };
  };
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Kanban boundary policy must be an object.');
  }
  if (typeof policy.enabled !== 'boolean') {
    throw new Error('Kanban boundary enabled flag must be boolean.');
  }
  if (!['confirm', 'block'].includes(policy.enforcement)) {
    throw new Error(`Unknown Kanban boundary enforcement: ${String(policy.enforcement)}`);
  }
  if (!['allow', 'confirm', 'block'].includes(policy.shellAccess)) {
    throw new Error(`Unknown Kanban boundary shell access: ${String(policy.shellAccess)}`);
  }
  if (!Array.isArray(policy.allow) || (policy.deny !== undefined && !Array.isArray(policy.deny))) {
    throw new Error('Kanban boundary allow/deny selectors must be arrays.');
  }
  // If the operator configured boundary selectors but left enabled === false,
  // those rules are inert: resolveKanbanBoundaryLayers skips disabled layers,
  // so writes are never scoped. Surface this once per normalization (which
  // happens at board create/update, not on every tool call) so a board edited
  // through the boundary UI does not silently configure dead rules.
  warnIfBoundaryRulesInactive(policy);
  return {
    enabled: policy.enabled,
    enforcement: policy.enforcement,
    shellAccess: policy.shellAccess,
    allow: policy.allow.map(normalizeSelector),
    ...(policy.deny ? { deny: policy.deny.map(normalizeSelector) } : {}),
  };
}

/**
 * Emit a namespaced warning when a boundary policy carries selectors but is
 * disabled. The boundary editor (WebUI/TUI) lets operators add allow/deny
 * rules; without `enabled: true` those rules are never consulted by
 * `resolveKanbanBoundaryLayers`, so the editor would otherwise configure a
 * silent no-op. This mirrors the WRONGSTACK_KANBAN_* warning convention.
 */
function warnIfBoundaryRulesInactive(policy: KanbanBoundaryPolicy): void {
  if (policy.enabled) return;
  const hasSelectors = policy.allow.length > 0 || (policy.deny?.length ?? 0) > 0;
  if (!hasSelectors) return;
  const count = policy.allow.length + (policy.deny?.length ?? 0);
  process.emitWarning(
    `Kanban boundary has ${count} rule(s) configured but enabled=false — the rules are inert until the boundary is enabled.`,
    { code: 'WRONGSTACK_KANBAN_BOUNDARY_RULES_INACTIVE' },
  );
}

export function normalizeBoundaryPath(value: string): string | null {
  const trimmed = value.trim().replace(/\\/g, '/');
  if (!trimmed || path.posix.isAbsolute(trimmed) || path.win32.isAbsolute(trimmed)) return null;
  const normalized = path.posix.normalize(trimmed).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return null;
  return normalized;
}

export function describeKanbanBoundary(policy: KanbanBoundaryPolicy | undefined): string {
  if (!policy?.enabled) return 'unrestricted';
  const allowed = policy.allow.length;
  const denied = policy.deny?.length ?? 0;
  return `${policy.enforcement} · ${allowed} allow · ${denied} deny · shell ${policy.shellAccess}`;
}

function selectorMatches(selector: KanbanBoundarySelector, resourcePath: string): boolean {
  const selectorPath = normalizeBoundaryPath(selector.path);
  if (!selectorPath) return false;
  if (selector.kind === 'file') return resourcePath === selectorPath;
  if (selector.kind === 'directory' || selector.kind === 'package') {
    if (selectorPath === '.') return true;
    return resourcePath === selectorPath || resourcePath.startsWith(`${selectorPath}/`);
  }
  return globToRegExp(selectorPath).test(resourcePath);
}

function globToRegExp(pattern: string): RegExp {
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!;
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (
      char === '/' &&
      pattern[index + 1] === '*' &&
      pattern[index + 2] === '*' &&
      index + 3 === pattern.length
    ) {
      // A terminal `/**` includes the selected directory itself as well as descendants.
      source += '(?:/.*)?';
      index += 2;
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function accessMatches(selectorAccess: KanbanBoundaryAccess, requested: 'read' | 'write'): boolean {
  return selectorAccess === 'read_write' || selectorAccess === requested;
}

function strongestViolation(
  violations: readonly KanbanBoundaryEvaluation[],
): KanbanBoundaryEvaluation {
  return (
    violations.find((violation) => violation.decision === 'block') ??
    violations.find((violation) => violation.decision === 'confirm') ?? { decision: 'allow' }
  );
}

function describeSelector(selector: KanbanBoundarySelector): string {
  return `${selector.kind}:${selector.path}:${selector.access}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
