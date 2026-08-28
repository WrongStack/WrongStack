import * as path from 'node:path';
import type {
  LanguageDiagnostic,
  LanguagePackageMutation,
  LanguagePackageVulnerability,
  LanguageProfileId,
  LanguageRunSummary,
} from './types.js';

const MAX_DIAGNOSTICS = 200;

interface ParsedDiagnostics {
  diagnostics: readonly LanguageDiagnostic[];
  omitted: number;
  summary: LanguageRunSummary;
}

export function parseLanguageDiagnostics(
  parser: string,
  stdout: string,
  stderr: string,
  workspaceRoot: string,
): ParsedDiagnostics {
  const text = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`;
  let diagnostics: LanguageDiagnostic[];
  switch (parser) {
    case 'typescript':
      diagnostics = parseTypeScript(text, workspaceRoot);
      break;
    case 'cargo-json':
      diagnostics = parseCargoJson(text, workspaceRoot);
      break;
    case 'php-lint':
      diagnostics = parsePhpLint(text, workspaceRoot);
      break;
    case 'dotnet-build':
    case 'dotnet-format':
    case 'dotnet-test':
      diagnostics = parseDotnet(text, workspaceRoot);
      break;
    case 'go-test':
    case 'go-compiler':
    case 'gofmt':
      diagnostics = parseGo(text, workspaceRoot);
      break;
    case 'biome':
      diagnostics = parseBiome(text, workspaceRoot);
      break;
    default:
      diagnostics = parseGeneric(text, parser, workspaceRoot);
      break;
  }
  const sorted = dedupeDiagnostics(diagnostics).sort(compareDiagnostics);
  const omitted = Math.max(0, sorted.length - MAX_DIAGNOSTICS);
  const kept = Object.freeze(sorted.slice(0, MAX_DIAGNOSTICS).map((item) => Object.freeze(item)));
  return {
    diagnostics: kept,
    omitted,
    summary: summarize(kept),
  };
}

export function diagnosticsForInternalSyntax(
  language: LanguageProfileId,
  target: string,
  sourceText: string,
): Promise<ParsedDiagnostics> {
  if (language !== 'typescript' && language !== 'javascript') {
    return Promise.resolve({ diagnostics: [], omitted: 0, summary: emptySummary() });
  }
  return import('@typescript/typescript6').then((tsModule) => {
    const ts = ((tsModule as unknown as { default?: typeof tsModule }).default ??
      tsModule) as typeof tsModule;
    const extension = path.extname(target).toLowerCase();
    const scriptKind =
      extension === '.tsx'
        ? ts.ScriptKind.TSX
        : extension === '.ts' || extension === '.mts' || extension === '.cts'
          ? ts.ScriptKind.TS
          : ts.ScriptKind.JSX;
    const sourceFile = ts.createSourceFile(
      path.basename(target),
      sourceText,
      ts.ScriptTarget.Latest,
      false,
      scriptKind,
    );
    const native =
      (
        sourceFile as unknown as {
          parseDiagnostics?: import('@typescript/typescript6').Diagnostic[];
        }
      ).parseDiagnostics ?? [];
    const diagnostics = native.map<LanguageDiagnostic>((diagnostic) => {
      const start = diagnostic.start ?? 0;
      const location = sourceFile.getLineAndCharacterOfPosition(start);
      return {
        severity: diagnostic.category === ts.DiagnosticCategory.Warning ? 'warning' : 'error',
        ...(diagnostic.code ? { code: `TS${diagnostic.code}` } : {}),
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        file: target,
        range: { start: { line: location.line + 1, column: location.character + 1 } },
        source: 'typescript-parser',
      };
    });
    const sorted = dedupeDiagnostics(diagnostics).sort(compareDiagnostics);
    const omitted = Math.max(0, sorted.length - MAX_DIAGNOSTICS);
    const kept = Object.freeze(sorted.slice(0, MAX_DIAGNOSTICS).map((item) => Object.freeze(item)));
    return { diagnostics: kept, omitted, summary: summarize(kept) };
  });
}

function parseTypeScript(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/gm;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: match[4] === 'warning' ? 'warning' : 'error',
      code: match[5],
      message: match[6]!.trim(),
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source: 'typescript',
    });
  }
  return diagnostics;
}

function parseCargoJson(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as {
        reason?: string;
        message?: {
          level?: string;
          code?: { code?: string };
          message?: string;
          spans?: Array<{
            file_name?: string;
            line_start?: number;
            column_start?: number;
            is_primary?: boolean;
          }>;
        };
      };
      if (value.reason !== 'compiler-message' || !value.message?.message) continue;
      const primary =
        value.message.spans?.find((span) => span.is_primary) ?? value.message.spans?.[0];
      diagnostics.push({
        severity: normalizeSeverity(value.message.level),
        ...(value.message.code?.code ? { code: value.message.code.code } : {}),
        message: value.message.message,
        ...(primary?.file_name ? { file: normalizeDiagnosticPath(primary.file_name, root) } : {}),
        ...(primary?.line_start
          ? { range: { start: { line: primary.line_start, column: primary.column_start ?? 1 } } }
          : {}),
        source: 'rustc',
      });
    } catch {
      // Non-JSON build output is retained as raw output, not fabricated into diagnostics.
    }
  }
  return diagnostics;
}

function parseGo(text: string, root: string): LanguageDiagnostic[] {
  return parseLinePattern(
    text,
    /^(.*?\.go):(\d+):(\d+):\s*(.+)$/gm,
    root,
    'go',
    (_match, message) => ({ message, severity: /warning/i.test(message) ? 'warning' : 'error' }),
  );
}

function parsePhpLint(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /(?:PHP\s+)?(?:Parse|Fatal) error:\s*(.+?)\s+in\s+(.+?)\s+on line\s+(\d+)/gi;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: 'error',
      message: match[1]!.trim(),
      file: normalizeDiagnosticPath(match[2]!, root),
      range: { start: { line: toPositiveInt(match[3]), column: 1 } },
      source: 'php',
    });
  }
  return diagnostics;
}

function parseDotnet(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[.+\])?$/gm;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: match[4] === 'warning' ? 'warning' : 'error',
      code: match[5],
      message: match[6]!.trim(),
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source: 'dotnet',
    });
  }
  return diagnostics;
}

function parseBiome(text: string, root: string): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  const regex = /^(.+?):(\d+):(\d+)\s+(lint\/[^\s]+|format)\s+(.+)$/gm;
  for (const match of text.matchAll(regex)) {
    diagnostics.push({
      severity: 'warning',
      code: match[4],
      message: match[5]!.trim(),
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source: 'biome',
    });
  }
  return diagnostics;
}

function parseGeneric(text: string, source: string, root: string): LanguageDiagnostic[] {
  return parseLinePattern(
    text,
    /^(.+?):(\d+):(\d+):\s*(?:(error|warning|info):\s*)?(.+)$/gm,
    root,
    source,
    (match, fallback) => ({
      severity: normalizeSeverity(match[4]),
      message: match[5]?.trim() || fallback,
    }),
  );
}

export interface ParsedPackageReports {
  diagnostics: readonly LanguageDiagnostic[];
  vulnerabilities: readonly LanguagePackageVulnerability[];
  outdated: readonly LanguagePackageMutation[];
}

export function parsePackageReports(
  parser: string,
  stdout: string,
  stderr: string,
): ParsedPackageReports {
  const text = `${stdout}${stdout && stderr ? '\n' : ''}${stderr}`;
  switch (parser) {
    case 'npm-audit':
      return parseNpmAudit(text);
    case 'npm-outdated':
      return parseNpmOutdated(text);
    case 'cargo-audit':
      return parseCargoAudit(text);
    case 'composer-audit':
      return parseComposerAudit(text);
    case 'composer-outdated':
      return parseComposerOutdated(text);
    case 'dotnet-package':
      return parseDotnetPackage(text);
    default:
      return { diagnostics: [], vulnerabilities: [], outdated: [] };
  }
}

function parseNpmAudit(text: string): ParsedPackageReports {
  const advisories: LanguagePackageVulnerability[] = [];
  const diagnostics: LanguageDiagnostic[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { diagnostics, vulnerabilities: advisories, outdated: [] };
  }
  const vulnerabilities =
    (root as { vulnerabilities?: Record<string, unknown> })?.vulnerabilities ?? {};
  const advisoriesRecord =
    (root as { advisories?: Record<string, unknown> })?.advisories ?? vulnerabilities;
  for (const [id, value] of Object.entries(advisoriesRecord)) {
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

function parseNpmOutdated(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const outdated: LanguagePackageMutation[] = [];
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text);
  } catch {
    return { diagnostics, vulnerabilities: [], outdated };
  }
  for (const [name, info] of Object.entries(payload)) {
    const entry = info as {
      current?: string;
      latest?: string;
      wanted?: string;
      type?: string;
      location?: string;
    };
    if (!entry.latest || entry.latest === entry.current) continue;
    outdated.push({
      name,
      previous: entry.current,
      resolved: entry.latest,
      kind: mapOutdatedKind(entry.type),
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

function parseCargoAudit(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { diagnostics, vulnerabilities, outdated: [] };
  }
  const findings = (root as { vulnerabilities?: { found?: unknown } }).vulnerabilities?.found;
  if (!Array.isArray(findings)) return { diagnostics, vulnerabilities, outdated: [] };
  for (const finding of findings) {
    const item = finding as {
      id?: string;
      package?: string;
      title?: string;
      severity?: string;
      patched_versions?: string[];
      url?: { long?: string; short?: string };
      advisory?: { id?: string };
    };
    const name = item.package ?? 'unknown';
    const advisory = item.id ?? item.advisory?.id ?? 'cargo-audit';
    vulnerabilities.push({
      package: name,
      ...(item.title ? { advisory: item.title } : { advisory }),
      severity: mapSeverity(item.severity),
      ...(item.patched_versions && item.patched_versions.length > 0
        ? { fixedIn: item.patched_versions[0] }
        : {}),
      ...(item.url?.short ? { url: item.url.short } : {}),
    });
    diagnostics.push({
      severity:
        mapSeverity(item.severity) === 'critical' || mapSeverity(item.severity) === 'high'
          ? 'error'
          : 'warning',
      code: advisory,
      message: item.title ?? `${name} reported by cargo-audit.`,
      source: 'cargo-audit',
    });
  }
  return { diagnostics, vulnerabilities, outdated: [] };
}

function parseComposerAudit(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
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

function parseComposerOutdated(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const outdated: LanguagePackageMutation[] = [];
  const lines = text.split(/\r?\n/);
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

function parseDotnetPackage(text: string): ParsedPackageReports {
  const diagnostics: LanguageDiagnostic[] = [];
  const vulnerabilities: LanguagePackageVulnerability[] = [];
  const outdated: LanguagePackageMutation[] = [];
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { diagnostics, vulnerabilities, outdated };
  }
  const projects = (root as { projects?: Array<{ frameworks?: unknown; packages?: unknown }> })
    .projects;
  if (!Array.isArray(projects)) return { diagnostics, vulnerabilities, outdated };
  for (const project of projects) {
    const packages = Array.isArray(project.packages) ? project.packages : [];
    for (const pkg of packages as Array<Record<string, unknown>>) {
      const name = typeof pkg.name === 'string' ? pkg.name : 'unknown';
      const requested = typeof pkg.requestedVersion === 'string' ? pkg.requestedVersion : undefined;
      const resolved = typeof pkg.resolvedVersion === 'string' ? pkg.resolvedVersion : undefined;
      const vulnerabilitiesRaw = Array.isArray(pkg.vulnerabilities) ? pkg.vulnerabilities : [];
      for (const vuln of vulnerabilitiesRaw as Array<Record<string, unknown>>) {
        const advisory =
          typeof vuln.advisoryUrl === 'string' ? vuln.advisoryUrl : 'dotnet-vulnerable';
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

function mapSeverity(value: string | undefined): LanguagePackageVulnerability['severity'] {
  switch (value?.toLowerCase()) {
    case 'critical':
    case 'high':
      return 'high';
    case 'medium':
    case 'moderate':
      return 'moderate';
    case 'low':
      return 'low';
    case 'unknown':
      return 'unknown';
    default:
      return 'unknown';
  }
}

function mapOutdatedKind(value: string | undefined): 'runtime' | 'development' | 'optional' {
  switch (value?.toLowerCase()) {
    case 'devdependencies':
    case 'development':
      return 'development';
    case 'optionaldependencies':
    case 'optional':
      return 'optional';
    default:
      return 'runtime';
  }
}

function parseLinePattern(
  text: string,
  regex: RegExp,
  root: string,
  source: string,
  details: (
    match: RegExpMatchArray,
    fallback: string,
  ) => { severity: LanguageDiagnostic['severity']; message: string },
): LanguageDiagnostic[] {
  const diagnostics: LanguageDiagnostic[] = [];
  for (const match of text.matchAll(regex)) {
    const parsed = details(match, match.at(-1)?.trim() ?? 'Diagnostic');
    diagnostics.push({
      severity: parsed.severity,
      message: parsed.message,
      file: normalizeDiagnosticPath(match[1]!, root),
      range: { start: { line: toPositiveInt(match[2]), column: toPositiveInt(match[3]) } },
      source,
    });
  }
  return diagnostics;
}

function normalizeDiagnosticPath(value: string, root: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/g, '');
  return path.resolve(root, clean);
}

function normalizeSeverity(value: string | undefined): LanguageDiagnostic['severity'] {
  if (value === 'warning' || value === 'warn') return 'warning';
  if (value === 'info' || value === 'note' || value === 'help') return 'info';
  if (value === 'hint') return 'hint';
  return 'error';
}

function toPositiveInt(value: string | undefined): number {
  return Math.max(1, Number.parseInt(value ?? '1', 10) || 1);
}

function summarize(diagnostics: readonly LanguageDiagnostic[]): LanguageRunSummary {
  return {
    errors: diagnostics.filter((item) => item.severity === 'error').length,
    warnings: diagnostics.filter((item) => item.severity === 'warning').length,
    infos: diagnostics.filter((item) => item.severity === 'info' || item.severity === 'hint')
      .length,
  };
}

function emptySummary(): LanguageRunSummary {
  return { errors: 0, warnings: 0, infos: 0 };
}

function dedupeDiagnostics(items: readonly LanguageDiagnostic[]): LanguageDiagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = [
      item.source,
      item.code ?? '',
      item.file ?? '',
      item.range?.start.line ?? 0,
      item.range?.start.column ?? 0,
      item.message,
    ].join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareDiagnostics(a: LanguageDiagnostic, b: LanguageDiagnostic): number {
  return (
    (a.file ?? '').localeCompare(b.file ?? '') ||
    (a.range?.start.line ?? 0) - (b.range?.start.line ?? 0) ||
    (a.range?.start.column ?? 0) - (b.range?.start.column ?? 0) ||
    severityRank(a.severity) - severityRank(b.severity) ||
    (a.code ?? '').localeCompare(b.code ?? '') ||
    a.message.localeCompare(b.message)
  );
}

function severityRank(value: LanguageDiagnostic['severity']): number {
  return value === 'error' ? 0 : value === 'warning' ? 1 : value === 'info' ? 2 : 3;
}
