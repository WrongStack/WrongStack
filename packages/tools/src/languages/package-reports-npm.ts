import type { ParsedPackageReports } from './package-report-types.js';
import { mapOutdatedKind, mapSeverity } from './package-report-utils.js';
import type {
  LanguageDiagnostic,
  LanguagePackageMutation,
  LanguagePackageVulnerability,
} from './types.js';

export function parseNpmAudit(text: string): ParsedPackageReports {
  const advisories: LanguagePackageVulnerability[] = [];
  const diagnostics: LanguageDiagnostic[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    root = undefined;
  }
  // Yarn 1 `audit --json` is NDJSON: one `{"type":"auditAdvisory","data":
  // {"advisory":{…}}}` per finding PATH (same advisory repeated), between
  // warning lines. Yarn 2+ `npm audit --json` is NDJSON too, one
  // `{"value":pkg,"children":{"ID","Issue","URL","Severity",…}}` per advisory —
  // and with ONE advisory that is a valid single JSON document. Collect either
  // into an npm v6-style `advisories` map.
  const berryDocument =
    typeof root === 'object' && root !== null && 'value' in root && 'children' in root;
  if (root === undefined || berryDocument) {
    const fromLines: Record<string, unknown> = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('"auditAdvisory"') && !line.includes('"children"')) continue;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          data?: { advisory?: { id?: unknown } };
          value?: unknown;
          children?: { ID?: unknown; Issue?: unknown; URL?: unknown; Severity?: unknown };
        };
        const advisory = event.data?.advisory;
        if (event.type === 'auditAdvisory' && advisory) {
          fromLines[String(advisory.id ?? Object.keys(fromLines).length)] = advisory;
        } else if (typeof event.value === 'string' && event.children) {
          const child = event.children;
          fromLines[String(child.ID ?? `${event.value}-${Object.keys(fromLines).length}`)] = {
            name: event.value,
            title: child.Issue,
            severity: typeof child.Severity === 'string' ? child.Severity.toLowerCase() : undefined,
            url: child.URL,
          };
        }
      } catch {
        // not a JSON line
      }
    }
    if (Object.keys(fromLines).length === 0) {
      return { diagnostics, vulnerabilities: advisories, outdated: [] };
    }
    root = { advisories: fromLines };
  }
  const vulnerabilities =
    (root as { vulnerabilities?: Record<string, unknown> })?.vulnerabilities ?? {};
  let advisoriesRecord: Record<string, unknown> =
    (root as { advisories?: Record<string, unknown> })?.advisories ?? vulnerabilities;
  // `bun audit --json` has neither key: it maps each package name to an ARRAY
  // of advisories (`{"lodash":[{id,url,title,severity,…}]}`).
  if (
    root &&
    typeof root === 'object' &&
    !('vulnerabilities' in root) &&
    !('advisories' in root) &&
    Object.values(root).every(Array.isArray)
  ) {
    advisoriesRecord = {};
    for (const [name, list] of Object.entries(root as Record<string, unknown[]>)) {
      for (const entry of list) {
        if (!entry || typeof entry !== 'object') continue;
        const id = String((entry as { id?: unknown }).id ?? `${name}-${list.indexOf(entry)}`);
        advisoriesRecord[id] = { ...(entry as object), name };
      }
    }
  }
  for (const [id, value] of Object.entries(
    advisoriesRecord && typeof advisoriesRecord === 'object' && !Array.isArray(advisoriesRecord)
      ? advisoriesRecord
      : {},
  )) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const advisory = value as {
      module_name?: string;
      package_name?: string;
      name?: string;
      title?: string;
      severity?: string;
      url?: string;
      range?: string;
      patched_versions?: string;
    };
    const name = advisory.module_name ?? advisory.package_name ?? advisory.name ?? id;
    advisories.push({
      package: name,
      ...(advisory.title ? { advisory: advisory.title } : { advisory: id }),
      severity: mapSeverity(advisory.severity),
      ...(advisory.patched_versions ? { fixedIn: advisory.patched_versions } : {}),
      ...(advisory.url ? { url: advisory.url } : {}),
    });
    diagnostics.push({
      severity:
        mapSeverity(advisory.severity) === 'critical' || mapSeverity(advisory.severity) === 'high'
          ? 'error'
          : 'warning',
      code: id,
      message: advisory.title ?? `Vulnerability reported for ${name}.`,
      source: 'npm-audit',
    });
  }
  return { diagnostics, vulnerabilities: advisories, outdated: [] };
}

export function parseNpmOutdated(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const outdated: LanguagePackageMutation[] = [];
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // `bun outdated` ignores --json and prints a box table:
    // `| minimist        | 0.0.8   | 0.0.8  | 1.2.8  |`, `| is-number (dev) | …`.
    for (const line of text.split(/\r?\n/)) {
      const row =
        /^\|\s*(\S+?)(?:\s+\((dev|optional|peer)\))?\s*\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*([^|\s]+)\s*\|\s*$/.exec(
          line,
        );
      if (!row || row[1] === 'Package' || /^-+$/.test(row[1]!)) continue;
      payload[row[1]!] = {
        current: row[3],
        wanted: row[4],
        latest: row[5],
        type: row[2] === 'dev' ? 'development' : row[2] === 'optional' ? 'optional' : undefined,
      };
    }
  }
  const seen = new Set<string>();
  // npm turns a package's value into an ARRAY when several dependents have it
  // outdated (workspaces, nested copies); read as one object it had no
  // `latest`, so exactly those packages vanished from the report.
  const rows = Object.entries(payload).flatMap(([name, info]) =>
    (Array.isArray(info) ? info : [info]).map((item) => [name, item] as const),
  );
  for (const [name, info] of rows) {
    const entry = (info ?? {}) as {
      current?: string;
      latest?: string;
      wanted?: string;
      type?: string;
      // pnpm names the manifest section `dependencyType`; npm uses `type`.
      dependencyType?: string;
      location?: string;
    };
    if (!entry.latest || entry.latest === entry.current) continue;
    const key = `${name}\0${entry.current ?? ''}\0${entry.latest}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outdated.push({
      name,
      previous: entry.current,
      resolved: entry.latest,
      kind: mapOutdatedKind(entry.type ?? entry.dependencyType),
    });
    diagnostics.push({
      severity: 'info',
      code: 'outdated',
      message: `${name}: ${entry.current ?? '?'} → ${entry.latest}`,
      source: 'npm-outdated',
    });
  }
  return { diagnostics, vulnerabilities: [], outdated };
}
