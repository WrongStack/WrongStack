import { ERROR_CODES, PluginError } from '@wrongstack/contracts/types/errors';
import type { Plugin, PluginDependency } from '@wrongstack/contracts/types/plugin';

function parseSemver(v: string): [number, number, number] {
  const parts = v
    .replace(/^[^0-9]*/, '')
    .split('.')
    .map((s) => Number.parseInt(s, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const COMPARATOR_RE =
  /^(\^|~|>=|<=|>|<|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/;

/** One comparator (`^1.2`, `>=0.1.0`, `0.1.x`, `*`) against a version. */
function satisfiesComparator(token: string, version: [number, number, number]): boolean {
  if (token === '' || token === '*' || token === 'x' || token === 'X') return true;
  const match = COMPARATOR_RE.exec(token);
  if (!match) return false;
  const op = match[1] ?? '=';
  const parts = [match[2], match[3], match[4]];
  const fixed = parts.findIndex((part) => part === undefined || !/^\d+$/.test(part));
  const specified = fixed === -1 ? 3 : fixed;
  const [rMaj, rMin, rPatch] = parts.map((part) =>
    part !== undefined && /^\d+$/.test(part) ? Number.parseInt(part, 10) : 0,
  ) as [number, number, number];
  const [vMaj, vMin, vPatch] = version;
  const cmp = compareSemver(version, [rMaj, rMin, rPatch]);
  switch (op) {
    case '^':
      if (rMaj === 0) return vMaj === 0 && vMin === rMin && vPatch >= rPatch;
      return vMaj === rMaj && (vMin > rMin || (vMin === rMin && vPatch >= rPatch));
    case '~':
      return vMaj === rMaj && vMin === rMin && vPatch >= rPatch;
    case '>=':
      return cmp >= 0;
    case '>':
      return cmp > 0;
    case '<=':
      return cmp <= 0;
    case '<':
      return cmp < 0;
    default:
      return [vMaj, vMin, vPatch]
        .slice(0, specified)
        .every((component, index) => component === [rMaj, rMin, rPatch][index]);
  }
}

/**
 * Whether `version` satisfies a semver range (`^`, `~`, comparators, `||`, x-ranges).
 */
export function satisfies(range: string, version: string): boolean {
  const parsed = parseSemver(version);
  const normalized = range.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
  return normalized.split('||').some((set) =>
    set
      .trim()
      .split(/\s+/)
      .every((token) => satisfiesComparator(token, parsed)),
  );
}

/** Normalize either `string` or `PluginDependency` into the structured form. */
export function normalizeDep(d: string | PluginDependency): PluginDependency {
  return typeof d === 'string' ? { name: d } : d;
}

/**
 * Topologically order plugins according to `dependsOn` and `optionalDeps`.
 */
export function topoSort(plugins: Plugin[]): Plugin[] {
  const map = new Map<string, Plugin>();
  for (const p of plugins) map.set(p.name, p);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const order: Plugin[] = [];

  const visit = (p: Plugin, stack: string[]) => {
    if (visited.has(p.name)) return;
    if (visiting.has(p.name)) {
      throw new PluginError({
        message: `Plugin dependency cycle: ${[...stack, p.name].join(' -> ')}`,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: p.name,
      });
    }
    visiting.add(p.name);
    for (const raw of p.dependsOn ?? []) {
      const dep = normalizeDep(raw);
      const d = map.get(dep.name);
      if (!d) {
        throw new PluginError({
          message: `Plugin "${p.name}" depends on missing plugin "${dep.name}"`,
          code: ERROR_CODES.PLUGIN_MISSING_DEPENDENCY,
          pluginName: p.name,
          context: { dependency: dep.name },
        });
      }
      if (dep.version && d.version && !satisfies(dep.version, d.version)) {
        throw new PluginError({
          message: `Plugin "${p.name}" requires "${dep.name}@${dep.version}", found ${d.version}`,
          code: ERROR_CODES.PLUGIN_LOAD_FAILED,
          pluginName: p.name,
          context: { dependency: dep.name, required: dep.version, found: d.version },
        });
      }
      visit(d, [...stack, p.name]);
    }
    for (const raw of p.optionalDeps ?? []) {
      const dep = normalizeDep(raw);
      const d = map.get(dep.name);
      if (d) {
        if (dep.version && d.version && !satisfies(dep.version, d.version)) {
          throw new PluginError({
            message: `Plugin "${p.name}" optional dep "${dep.name}@${dep.version}" found ${d.version}`,
            code: ERROR_CODES.PLUGIN_LOAD_FAILED,
            pluginName: p.name,
            context: { dependency: dep.name, required: dep.version, found: d.version },
          });
        }
        visit(d, [...stack, p.name]);
      }
    }
    visiting.delete(p.name);
    visited.add(p.name);
    order.push(p);
  };

  for (const p of plugins) visit(p, []);
  return order;
}
