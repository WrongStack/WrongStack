import type { ParsedPackageReports } from './package-report-types.js';
import { mapSeverity, parseJsonDocument } from './package-report-utils.js';
import type {
  LanguageDiagnostic,
  LanguagePackageMutation,
  LanguagePackageVulnerability,
} from './types.js';

/** `pip-audit --format json`: `{dependencies: [{name, version, vulns: [{id, fix_versions, aliases}]}]}`. */
export function parsePipAudit(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  const document = parseJsonDocument(text) as {
    dependencies?: Array<{
      name?: string;
      version?: string;
      vulns?: Array<{ id?: string; fix_versions?: string[]; aliases?: string[] }>;
    }>;
  } | null;
  for (const dep of document?.dependencies ?? []) {
    for (const vuln of dep.vulns ?? []) {
      if (!dep.name || !vuln.id) continue;
      const fixedIn = vuln.fix_versions?.[0];
      vulnerabilities.push({
        package: dep.name,
        advisory: vuln.id,
        // pip-audit reports no severity.
        severity: 'unknown',
        ...(fixedIn ? { fixedIn } : {}),
      });
      diagnostics.push({
        severity: 'warning',
        code: vuln.id,
        message: `${dep.name} ${dep.version ?? ''} is affected by ${vuln.id}${fixedIn ? ` (fixed in ${fixedIn})` : ''}.`,
        source: 'pip-audit',
      });
    }
  }
  return { diagnostics, vulnerabilities, outdated: [] };
}

/**
 * `bundle audit --format=json` (bundler-audit `Report#to_h`):
 * `{results: [{type: 'unpatched_gem', gem: {name, version}, advisory: {id, url,
 * title, patched_versions, criticality}}, {type: 'insecure_source', source}]}`.
 * The Ruby profile named this parser but no case handled it, so every finding
 * was dropped and the run (bundle-audit exits 1 on findings) read as failed.
 */
export function parseBundlerAudit(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  const document = parseJsonDocument(text) as { results?: unknown } | null;
  const results = Array.isArray(document?.results) ? document.results : [];
  for (const raw of results) {
    const result = raw as {
      type?: string;
      source?: string;
      gem?: { name?: string; version?: string };
      advisory?: {
        id?: string;
        url?: string;
        title?: string;
        patched_versions?: unknown[];
        criticality?: string | null;
      };
    };
    if (result.type === 'insecure_source') {
      diagnostics.push({
        severity: 'warning',
        code: 'insecure-source',
        message: `Insecure gem source: ${result.source ?? 'unknown'}.`,
        source: 'bundler-audit',
      });
      continue;
    }
    const name = result.gem?.name;
    const advisory = result.advisory;
    if (!name || !advisory?.id) continue;
    const fixedIn = advisory.patched_versions?.find((v): v is string => typeof v === 'string');
    vulnerabilities.push({
      package: name,
      advisory: advisory.title ?? advisory.id,
      severity: mapSeverity(advisory.criticality ?? undefined),
      ...(fixedIn ? { fixedIn } : {}),
      ...(advisory.url ? { url: advisory.url } : {}),
    });
    diagnostics.push({
      severity: 'warning',
      code: advisory.id,
      message: `${name} ${result.gem?.version ?? ''} is affected by ${advisory.id}${fixedIn ? ` (fixed in ${fixedIn})` : ''}.`,
      source: 'bundler-audit',
    });
  }
  return { diagnostics, vulnerabilities, outdated: [] };
}

export function parseCargoAudit(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { diagnostics, vulnerabilities, outdated: [] };
  }
  if (!root || typeof root !== 'object') return { diagnostics, vulnerabilities, outdated: [] };
  // Real `cargo audit --json` (rustsec `Report`) carries `vulnerabilities:
  // {found: boolean, count, list: [{advisory: {id, package, title, url}, versions:
  // {patched}, package: {name}}]}`. Reading only `found` as the array parsed
  // every real report as clean; the flat `found: [...]` shape is kept as well.
  const info = (root as { vulnerabilities?: { found?: unknown; list?: unknown } }).vulnerabilities;
  const findings = Array.isArray(info?.list)
    ? info.list
    : Array.isArray(info?.found)
      ? info.found
      : undefined;
  if (!findings) return { diagnostics, vulnerabilities, outdated: [] };
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const item = finding as {
      id?: string;
      package?: string | { name?: string };
      title?: string;
      severity?: string;
      patched_versions?: string[];
      url?: string | { long?: string; short?: string };
      advisory?: { id?: string; package?: string; title?: string; url?: string };
      versions?: { patched?: string[] };
    };
    const name =
      (typeof item.package === 'string' ? item.package : item.package?.name) ??
      item.advisory?.package ??
      'unknown';
    const advisory = item.id ?? item.advisory?.id ?? 'cargo-audit';
    const title = item.title ?? item.advisory?.title;
    const patched = item.patched_versions ?? item.versions?.patched;
    const url = typeof item.url === 'string' ? item.url : (item.url?.short ?? item.advisory?.url);
    vulnerabilities.push({
      package: name,
      ...(title ? { advisory: title } : { advisory }),
      severity: mapSeverity(item.severity),
      ...(patched && patched.length > 0 ? { fixedIn: patched[0] } : {}),
      ...(url ? { url } : {}),
    });
    diagnostics.push({
      severity:
        mapSeverity(item.severity) === 'critical' || mapSeverity(item.severity) === 'high'
          ? 'error'
          : 'warning',
      code: advisory,
      message: title ?? `${name} reported by cargo-audit.`,
      source: 'cargo-audit',
    });
  }
  return { diagnostics, vulnerabilities, outdated: [] };
}

export function parseComposerAudit(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  // Real `composer audit --format=json` is ONE pretty-printed document
  // (`{"advisories": {"vendor/pkg": [ … ]}, "abandoned": …}`); no line of it
  // parses alone, so the per-line reader below found nothing.
  const document = parseJsonDocument(text) as {
    advisories?: Record<string, unknown> | unknown[];
  } | null;
  if (document?.advisories && typeof document.advisories === 'object') {
    for (const [pkg, entries] of Object.entries(document.advisories)) {
      const list = Array.isArray(entries) ? entries : Object.values(entries ?? {});
      for (const raw of list) {
        const entry = raw as {
          advisoryId?: string;
          packageName?: string;
          title?: string;
          cve?: string | null;
          link?: string;
          severity?: string | null;
        };
        const id = entry.cve ?? entry.advisoryId ?? 'composer-audit';
        vulnerabilities.push({
          package: entry.packageName ?? pkg,
          advisory: entry.title ?? id,
          severity: mapSeverity(entry.severity ?? undefined),
          ...(entry.link ? { url: entry.link } : {}),
        });
        diagnostics.push({
          severity: 'warning',
          code: id,
          message: entry.title ?? `${entry.packageName ?? pkg} reported by composer audit.`,
          source: 'composer-audit',
        });
      }
    }
    return { diagnostics, vulnerabilities, outdated: [] };
  }
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as {
        package?: string;
        advisory?: string;
        title?: string;
        severity?: string;
        affectedVersions?: string;
        url?: string;
      };
      if (!entry.package) continue;
      vulnerabilities.push({
        package: entry.package,
        ...(entry.advisory ? { advisory: entry.advisory } : {}),
        ...(entry.title
          ? { advisory: entry.title }
          : { advisory: entry.advisory ?? 'composer-audit' }),
        severity: mapSeverity(entry.severity),
        ...(entry.affectedVersions ? { fixedIn: entry.affectedVersions } : {}),
        ...(entry.url ? { url: entry.url } : {}),
      });
      diagnostics.push({
        severity: 'warning',
        code: entry.advisory ?? 'composer-audit',
        message: entry.title ?? `${entry.package} reported by composer audit.`,
        source: 'composer-audit',
      });
    } catch {
      // Ignore malformed composer audit lines; raw output is preserved.
    }
  }
  return { diagnostics, vulnerabilities, outdated: [] };
}

export function parseComposerOutdated(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const outdated: LanguagePackageMutation[] = [];
  // Real `composer outdated --format=json` is ONE document keyed by what was
  // checked (`{"locked": [...]}` / `{"installed": [...]}`); no single line of
  // it parses, so the per-line reader below never saw a package.
  const document = parseJsonDocument(text) as {
    locked?: unknown[];
    installed?: unknown[];
  } | null;
  const rows = document ? (document.locked ?? document.installed) : undefined;
  const lines = Array.isArray(rows) ? rows.map((row) => JSON.stringify(row)) : text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const entry = JSON.parse(line) as {
        name?: string;
        version?: string;
        latest?: string;
        description?: string;
      };
      if (!entry.name || entry.version === entry.latest) continue;
      outdated.push({
        name: entry.name,
        previous: entry.version,
        resolved: entry.latest ?? entry.version,
      });
      diagnostics.push({
        severity: 'info',
        code: 'outdated',
        message: `${entry.name}: ${entry.version ?? '?'} → ${entry.latest ?? '?'}`,
        source: 'composer-outdated',
      });
    } catch {
      // Skip malformed line; the raw output remains available.
    }
  }
  return { diagnostics, vulnerabilities: [], outdated };
}

export function parseDotnetPackage(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  const outdated: LanguagePackageMutation[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { diagnostics, vulnerabilities, outdated };
  }
  if (!root || typeof root !== 'object') return { diagnostics, vulnerabilities, outdated };
  const projects = (root as { projects?: Array<{ frameworks?: unknown; packages?: unknown }> })
    .projects;
  if (!Array.isArray(projects)) return { diagnostics, vulnerabilities, outdated };
  for (const project of projects) {
    if (!project || typeof project !== 'object') continue;
    // The SDK's report nests packages per target framework
    // (`frameworks[].topLevelPackages[]` / `transitivePackages[]`, keyed `id`);
    // reading only a flat `packages[]` found nothing in a real report.
    const frameworks = Array.isArray(project.frameworks)
      ? (project.frameworks as Array<Record<string, unknown>>)
      : [];
    const packages = [
      ...(Array.isArray(project.packages) ? project.packages : []),
      ...frameworks.flatMap((framework) => [
        ...(Array.isArray(framework.topLevelPackages) ? framework.topLevelPackages : []),
        ...(Array.isArray(framework.transitivePackages) ? framework.transitivePackages : []),
      ]),
    ];
    for (const pkg of packages as Array<Record<string, unknown>>) {
      if (!pkg || typeof pkg !== 'object') continue;
      const name =
        typeof pkg.id === 'string' ? pkg.id : typeof pkg.name === 'string' ? pkg.name : 'unknown';
      const requested = typeof pkg.requestedVersion === 'string' ? pkg.requestedVersion : undefined;
      const resolved = typeof pkg.resolvedVersion === 'string' ? pkg.resolvedVersion : undefined;
      const latest = typeof pkg.latestVersion === 'string' ? pkg.latestVersion : undefined;
      if (latest && resolved && latest !== resolved) {
        outdated.push({
          name,
          ...(requested ? { requested } : {}),
          previous: resolved,
          resolved: latest,
        });
        diagnostics.push({
          severity: 'info',
          code: 'outdated',
          message: `${name}: ${resolved} → ${latest}`,
          source: 'dotnet-package',
        });
        continue;
      }
      const vulnerabilitiesRaw = Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : [];
      for (const vuln of vulnerabilitiesRaw as Array<Record<string, unknown>>) {
        // The SDK spells the field `advisoryurl` (all lower case).
        const url = vuln.advisoryurl ?? vuln.advisoryUrl;
        const advisory = typeof url === 'string' ? url : 'dotnet-vulnerable';
        vulnerabilities.push({
          package: name,
          advisory,
          severity: mapSeverity(typeof vuln.severity === 'string' ? vuln.severity : undefined),
        });
      }
      if (vulnerabilitiesRaw.length > 0) {
        diagnostics.push({
          severity: 'warning',
          code: 'dotnet-vulnerable',
          message: `${name} has ${vulnerabilitiesRaw.length} known vulnerability entry/entries.`,
          source: 'dotnet-package',
        });
      }
      if (
        requested &&
        resolved &&
        requested.startsWith('>') &&
        requested.split('>')[1]!.split('.').slice(0, 2).join('.') !==
          resolved.split('.').slice(0, 2).join('.')
      ) {
        outdated.push({ name, requested, resolved });
        diagnostics.push({
          severity: 'info',
          code: 'outdated',
          message: `${name}: ${requested} → ${resolved}`,
          source: 'dotnet-package',
        });
      }
    }
  }
  return { diagnostics, vulnerabilities, outdated };
}
