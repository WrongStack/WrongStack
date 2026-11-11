import { toolFlowInput } from '@wrongstack/tools/tool-summary';
import {
  CheckCircle2,
  Code2,
  FileCode2,
  FileText,
  GitBranch,
  Globe,
  Info,
  Library,
  ListTodo,
  Network,
  Package,
  Palette,
  Search,
  ShieldCheck,
  Terminal,
  Wrench,
} from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import type { ToolOverviewMessage } from './tool-overview-types';

export type { ToolOverviewMessage } from './tool-overview-types';

import { ToolFlowOverview } from './ToolFlowOverview.js';

type OverviewKind =
  | 'file'
  | 'filesystem'
  | 'command'
  | 'vcs'
  | 'verify'
  | 'web'
  | 'workflow'
  | 'clarify'
  | 'structured'
  | 'codebase'
  | 'browser'
  | 'e2e'
  | 'language'
  | 'packages'
  | 'observability'
  | 'security'
  | 'design'
  | 'catalog'
  | 'generic';

type SignalTone = 'neutral' | 'success' | 'warning' | 'danger';

interface ToolSignal {
  label: string;
  value: string;
  tone?: SignalTone | undefined;
}

/**
 * Rich transcript views for the complete static built-in catalog. Exact names
 * make coverage auditable; unknown/custom tools intentionally retain the
 * generic summary instead of pretending to understand their output.
 */
export const TOOL_OVERVIEW_REGISTRY: Readonly<Record<string, OverviewKind>> = {
  read: 'file',
  write: 'file',
  edit: 'file',
  replace: 'file',
  patch: 'file',
  grep: 'filesystem',
  glob: 'filesystem',
  tree: 'filesystem',
  bash: 'command',
  exec: 'command',
  pwsh: 'command',
  git: 'vcs',
  diff: 'vcs',
  test: 'verify',
  lint: 'verify',
  typecheck: 'verify',
  format: 'verify',
  search: 'web',
  fetch: 'web',
  read_url_content: 'web',
  todo: 'workflow',
  plan: 'workflow',
  kanban: 'workflow',
  task: 'workflow',
  clarify: 'clarify',
  json: 'structured',
  'codebase-search': 'codebase',
  'codebase-context': 'codebase',
  'codebase-repo-map': 'codebase',
  'codebase-impact-analysis': 'codebase',
  browser_open: 'browser',
  browser_status: 'browser',
  browser_list: 'browser',
  browser_navigate: 'browser',
  browser_snapshot: 'browser',
  browser_screenshot: 'browser',
  browser_click: 'browser',
  browser_type: 'browser',
  browser_select: 'browser',
  browser_press: 'browser',
  browser_hover: 'browser',
  browser_drag: 'browser',
  browser_wait: 'browser',
  browser_evaluate: 'browser',
  browser_upload: 'browser',
  browser_close: 'browser',
  e2e_plan: 'e2e',
  'codebase-ast-replace': 'file',
  'codebase-read-symbol': 'file',
  'codebase-invariant-check': 'codebase',
  'codebase-stats': 'codebase',
  'codebase-skeleton': 'codebase',
  'codebase-targeted-test': 'verify',
  'security-ast-scan': 'security',
  'codebase-incoming-calls': 'codebase',
  'codebase-outgoing-calls': 'codebase',
  'codebase-index': 'codebase',
  'dead-code-scan': 'codebase',
  language_info: 'language',
  language: 'language',
  language_package: 'packages',
  install: 'packages',
  audit: 'packages',
  outdated: 'packages',
  logs: 'observability',
  design: 'design',
  design_reference: 'design',
  tool_search: 'catalog',
  tool_use: 'catalog',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function valueAt(input: unknown, names: readonly string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const name of names) {
    const value = text(input[name]);
    if (value) return /(?:token|secret|password|api[_-]?key)/i.test(name) ? '••••••' : value;
  }
  return undefined;
}

function listAt(input: unknown, names: readonly string[]): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const name of names) {
    const value = input[name];
    if (Array.isArray(value) && value.length > 0) {
      return value
        .slice(0, 3)
        .map((entry) => text(entry) ?? '…')
        .join(', ');
    }
  }
  return undefined;
}

function outputShape(
  result: string | undefined,
  outputBytes: number | undefined,
  outputLines: number | undefined,
): string | undefined {
  if (result === undefined) return undefined;
  const lines = outputLines ?? (result ? result.split('\n').length : 0);
  const bytes = outputBytes ?? new TextEncoder().encode(result).length;
  return `${lines} ${lines === 1 ? 'line' : 'lines'} · ${bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`}`;
}

function countMatches(result: string, pattern: RegExp): number | undefined {
  const match = result.match(pattern);
  if (!match?.[1]) return undefined;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : undefined;
}

function singular(value: number, word: string): string {
  return `${value} ${value === 1 ? word : `${word}s`}`;
}

function translationSegment(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * A few trusted, presentation-only signals make a completed call scannable
 * without re-rendering (or exposing) its raw result. They deliberately derive
 * only from explicit counts/statuses; the Details body remains authoritative.
 */
function signalsFor(
  kind: OverviewKind,
  result: string | undefined,
  outputLines: number | undefined,
): ToolSignal[] {
  if (result === undefined || !result.trim()) return [];
  const lines = outputLines ?? result.split('\n').length;
  const errors = countMatches(result, /\b(\d+)\s+errors?\b/i);
  const warnings = countMatches(result, /\b(\d+)\s+warnings?\b/i);
  const findings = countMatches(
    result,
    /\b(\d+)\s+(?:findings?|issues?|vulnerabilit(?:y|ies)|advisories)\b/i,
  );
  const http = result.match(/\b(?:HTTP\s*)?([1-5]\d\d)\b/)?.[1];
  const signals: ToolSignal[] = [];

  if (kind === 'filesystem') {
    signals.push({ label: 'Result', value: singular(lines, 'line') });
  } else if (kind === 'codebase') {
    const symbols = countMatches(result, /\b(\d+)\s+(?:symbols?|callers?|references?)\b/i);
    signals.push(
      symbols === undefined
        ? { label: 'Result', value: singular(lines, 'line') }
        : { label: 'Analysis', value: singular(symbols, 'result') },
    );
  } else if (kind === 'verify') {
    if (errors !== undefined)
      signals.push({ label: 'Errors', value: String(errors), tone: errors ? 'danger' : 'success' });
    if (warnings !== undefined)
      signals.push({
        label: 'Warnings',
        value: String(warnings),
        tone: warnings ? 'warning' : 'success',
      });
    if (signals.length === 0) signals.push({ label: 'Output', value: singular(lines, 'line') });
  } else if (kind === 'security' || kind === 'packages') {
    if (findings !== undefined) {
      signals.push({
        label: kind === 'security' ? 'Findings' : 'Advisories',
        value: String(findings),
        tone: findings ? 'danger' : 'success',
      });
    } else {
      signals.push({ label: 'Output', value: singular(lines, 'line') });
    }
  } else if (kind === 'web' || kind === 'browser') {
    if (http)
      signals.push({
        label: 'HTTP',
        value: http,
        tone: http.startsWith('2') || http.startsWith('3') ? 'success' : 'danger',
      });
    signals.push({ label: 'Result', value: singular(lines, 'line') });
  } else if (kind === 'observability') {
    signals.push(
      errors === undefined
        ? { label: 'Events', value: singular(lines, 'line') }
        : { label: 'Errors', value: String(errors), tone: errors ? 'danger' : 'success' },
    );
  } else if (kind === 'design') {
    const pagesAnalyzed = countMatches(result, /\b(\d+)\s+page\(s\)\s+analyzed\b/i);
    const hasDesignMd = /\bDESIGN\.md\b/.test(result);
    const overallMatch = result.match(/overall\s+(?:fidelity\s+)?(\d+(?:\.\d+)?)%/i)?.[1];
    if (pagesAnalyzed !== undefined) {
      signals.push({
        label: 'Analyzed',
        value: singular(pagesAnalyzed, 'page'),
        tone: 'success',
      });
    }
    if (hasDesignMd) {
      signals.push({ label: 'Spec', value: 'DESIGN.md (10 sections)', tone: 'success' });
    } else if (overallMatch) {
      signals.push({ label: 'Fidelity', value: `${overallMatch}%`, tone: 'success' });
    }
    if (signals.length === 0) signals.push({ label: 'Output', value: singular(lines, 'line') });
  } else if (kind !== 'generic') {
    signals.push({ label: 'Output', value: singular(lines, 'line') });
  }
  return signals;
}

function kindFor(toolName: string | undefined): OverviewKind {
  if (!toolName) return 'generic';
  return TOOL_OVERVIEW_REGISTRY[toolName] ?? 'generic';
}

function titleFor(kind: OverviewKind): string {
  switch (kind) {
    case 'file':
      return 'File operation';
    case 'filesystem':
      return 'File discovery';
    case 'command':
      return 'Command run';
    case 'vcs':
      return 'Version control';
    case 'verify':
      return 'Verification';
    case 'web':
      return 'Web activity';
    case 'workflow':
      return 'Work tracking';
    case 'clarify':
      return 'Decision request';
    case 'structured':
      return 'Structured data';
    case 'codebase':
      return 'Codebase analysis';
    case 'browser':
      return 'Browser activity';
    case 'e2e':
      return 'E2E plan';
    case 'language':
      return 'Language tooling';
    case 'packages':
      return 'Dependency operation';
    case 'observability':
      return 'Runtime logs';
    case 'security':
      return 'Security scan';
    case 'design':
      return 'Design system';
    case 'catalog':
      return 'Tool catalog';
    default:
      return 'Tool activity';
  }
}

function widgetFor(kind: OverviewKind) {
  if (kind === 'verify') {
    return {
      Icon: CheckCircle2,
      card: 'border-success/25 bg-success/[0.035]',
      icon: 'border-success/25 bg-success/[0.1] text-success',
      glow: 'from-success/[0.14]',
    };
  }
  if (kind === 'security') {
    return {
      Icon: ShieldCheck,
      card: 'border-warning/30 bg-warning/[0.04]',
      icon: 'border-warning/30 bg-warning/[0.1] text-warning',
      glow: 'from-warning/[0.16]',
    };
  }
  if (kind === 'web' || kind === 'browser') {
    return {
      Icon: Globe,
      card: 'border-info/25 bg-info/[0.035]',
      icon: 'border-info/25 bg-info/[0.1] text-info',
      glow: 'from-info/[0.14]',
    };
  }
  const Icon =
    kind === 'file'
      ? FileCode2
      : kind === 'filesystem'
        ? Search
        : kind === 'command' || kind === 'observability'
          ? Terminal
          : kind === 'vcs'
            ? GitBranch
            : kind === 'workflow'
              ? ListTodo
              : kind === 'clarify'
                ? Info
                : kind === 'structured'
                  ? FileText
                  : kind === 'codebase'
                    ? Network
                    : kind === 'language'
                      ? Code2
                      : kind === 'packages'
                        ? Package
                        : kind === 'design'
                          ? Palette
                          : kind === 'catalog'
                            ? Library
                            : kind === 'e2e'
                              ? CheckCircle2
                              : Wrench;
  return {
    Icon,
    card: 'border-primary/20 bg-primary/[0.03]',
    icon: 'border-primary/25 bg-primary/[0.1] text-primary',
    glow: 'from-primary/[0.13]',
  };
}

function fieldsFor(kind: OverviewKind, input: unknown): Array<[string, string]> {
  const path = valueAt(input, ['path', 'file', 'filePath', 'cwd', 'directory']);
  switch (kind) {
    case 'file':
      return [
        ['Target', path ?? 'Project file'],
        ['Change', valueAt(input, ['old_string', 'new_string', 'content', 'patch']) ?? 'Prepared'],
      ];
    case 'filesystem':
      return [
        ['Query', valueAt(input, ['pattern', 'query', 'glob', 'path']) ?? 'Project scan'],
        ['Scope', valueAt(input, ['path', 'cwd', 'root']) ?? 'Project'],
      ];
    case 'command':
      return [
        ['Command', valueAt(input, ['command', 'cmd', 'program']) ?? 'Command'],
        ['Directory', valueAt(input, ['cwd', 'workdir', 'path']) ?? 'Project'],
      ];
    case 'vcs':
      return [
        ['Operation', valueAt(input, ['action', 'command', 'operation']) ?? 'Inspect'],
        ['Target', valueAt(input, ['path', 'ref', 'branch', 'commit']) ?? 'Working tree'],
      ];
    case 'verify':
      return [
        ['Target', valueAt(input, ['path', 'target', 'files', 'config']) ?? 'Project'],
        [
          'Filter',
          valueAt(input, ['pattern', 'testNamePattern', 'command', 'symbol']) ?? 'Default',
        ],
      ];
    case 'web':
      return [
        ['Address', valueAt(input, ['url', 'query']) ?? 'Web request'],
        ['Mode', valueAt(input, ['method', 'extract', 'format']) ?? 'Read'],
      ];
    case 'workflow':
      return [
        ['Action', valueAt(input, ['action', 'operation', 'status']) ?? 'Update'],
        ['Item', valueAt(input, ['title', 'id', 'taskId', 'cardId']) ?? 'Workspace item'],
      ];
    case 'clarify':
      return [
        ['Question', valueAt(input, ['question', 'prompt', 'message']) ?? 'Clarification'],
        ['Choices', listAt(input, ['options', 'choices']) ?? 'Open response'],
      ];
    case 'structured':
      return [
        ['Document', valueAt(input, ['path', 'file']) ?? 'Structured file'],
        ['Query', valueAt(input, ['query', 'pathExpression', 'operation']) ?? 'Inspect'],
      ];
    case 'codebase':
      return [
        [
          'Subject',
          valueAt(input, ['query', 'symbol', 'name', 'description', 'path']) ?? 'Repository',
        ],
        ['Scope', valueAt(input, ['path', 'language', 'kind', 'force']) ?? 'Indexed project'],
      ];
    case 'browser':
      return [
        ['Target', valueAt(input, ['url', 'selector', 'sessionId']) ?? 'Browser session'],
        ['Action', valueAt(input, ['text', 'key', 'value', 'script']) ?? 'Inspect page'],
      ];
    case 'e2e':
      return [
        ['Framework', valueAt(input, ['framework']) ?? 'Detect automatically'],
        ['Scope', valueAt(input, ['cwd', 'maxDepth']) ?? 'Project'],
      ];
    case 'language':
      return [
        ['Action', valueAt(input, ['action', 'check']) ?? 'Inspect'],
        [
          'Workspace',
          valueAt(input, ['language', 'workspace', 'target', 'cwd']) ?? 'Detect automatically',
        ],
      ];
    case 'packages':
      return [
        ['Operation', valueAt(input, ['action', 'operation', 'manager']) ?? 'Inspect dependencies'],
        [
          'Packages',
          listAt(input, ['packages', 'names', 'dependencies']) ??
            valueAt(input, ['package', 'cwd']) ??
            'Project',
        ],
      ];
    case 'observability':
      return [
        ['Source', valueAt(input, ['source', 'service', 'container', 'path']) ?? 'Configured logs'],
        ['Mode', valueAt(input, ['tail', 'lines', 'follow']) ?? 'Bounded read'],
      ];
    case 'security':
      return [
        ['Target', valueAt(input, ['path', 'target', 'files']) ?? 'Project source'],
        [
          'Rules',
          listAt(input, ['rules', 'categories']) ??
            valueAt(input, ['mode']) ??
            'Supported patterns',
        ],
      ];
    case 'design': {
      const action = valueAt(input, ['action', 'operation']) ?? 'Preview';
      const refTarget = valueAt(input, ['url', 'file', 'reference']);
      if (refTarget) {
        const maxPages = valueAt(input, ['maxPages']);
        const against = valueAt(input, ['against']);
        const surface = valueAt(input, ['surface']);
        const scope = against
          ? `vs ${against}`
          : maxPages
            ? `Up to ${maxPages} pages · 5 breakpoints`
            : surface
              ? `${surface} profile`
              : '5-breakpoint matrix';
        return [
          ['Source', refTarget],
          ['Pipeline', `${action} · ${scope}`],
        ];
      }
      return [
        ['Action', action],
        ['Kit', valueAt(input, ['kit', 'name', 'out', 'path']) ?? 'Active stack'],
      ];
    }
    case 'catalog':
      return [
        ['Request', valueAt(input, ['query', 'name', 'toolName']) ?? 'Tool catalog'],
        ['Invocation', valueAt(input, ['arguments', 'input']) ?? 'Discover capability'],
      ];
    default:
      return [['Input', valueAt(input, ['path', 'query', 'command', 'action']) ?? 'Tool request']];
  }
}

/** A compact dashboard card shown before the lossless Details panel. */
export function ToolCallOverview({ message }: { message: ToolOverviewMessage }) {
  const { t } = useAppTranslation();
  if (toolFlowInput(message.toolName, message.toolInput))
    return <ToolFlowOverview message={message} />;
  const kind = kindFor(message.toolName);
  const fields = fieldsFor(kind, message.toolInput);
  const result = outputShape(message.toolResult, message.toolOutputBytes, message.toolOutputLines);
  const signals = signalsFor(kind, message.toolResult, message.toolOutputLines);
  const title = titleFor(kind);
  const widget = widgetFor(kind);
  const primary = fields[0] ?? ['Input', 'Tool request'];
  const secondary = fields.slice(1);
  const WidgetIcon = widget.Icon;

  return (
    <section
      aria-label={t('activity:toolOverview.label', '{{tool}} overview', {
        tool: message.toolName ?? 'Tool',
      })}
      data-tool-overview={kind}
      data-tool-widget={kind}
      className={cn(
        'relative overflow-hidden rounded-md border shadow-sm',
        'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-gradient-to-r before:via-transparent before:to-transparent',
        widget.card,
        widget.glow,
      )}
    >
      <div className="pointer-events-none absolute -right-5 -top-5 opacity-[0.07]" aria-hidden>
        <WidgetIcon className="size-24" />
      </div>
      <header className="relative flex items-center gap-2 border-b border-border/35 px-2.5 py-2">
        <div
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md border',
            widget.icon,
          )}
        >
          <WidgetIcon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/75">
            {t(`activity:toolOverview.titles.${kind}`, title)}
          </p>
          <p className="truncate font-mono text-xs font-medium text-foreground/90">
            {message.toolName ?? 'tool'}
          </p>
        </div>
        {result && (
          <span className="relative shrink-0 rounded border border-border/50 bg-background/70 px-1.5 py-1 font-mono text-[10px] tabular-nums text-muted-foreground">
            {result}
          </span>
        )}
      </header>
      <div className="relative grid gap-2 p-2.5 sm:grid-cols-[minmax(0,1.35fr)_minmax(9rem,0.65fr)]">
        <dl className="min-w-0 rounded-md border border-border/45 bg-background/45 px-2.5 py-2 shadow-xs">
          <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground/70">
            {t(`activity:toolOverview.fields.${translationSegment(primary[0])}`, primary[0])}
          </dt>
          <dd
            className="mt-1 truncate font-mono text-xs font-medium text-foreground"
            title={primary[1]}
          >
            {primary[1]}
          </dd>
        </dl>
        {secondary.length > 0 && (
          <dl className="grid min-w-0 gap-1.5">
            {secondary.map(([label, value]) => (
              <div
                key={label}
                className="min-w-0 rounded border border-border/35 bg-muted/20 px-2 py-1.5"
              >
                <dt className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground/65">
                  {t(`activity:toolOverview.fields.${translationSegment(label)}`, label)}
                </dt>
                <dd
                  className="mt-0.5 truncate font-mono text-[11px] text-foreground/85"
                  title={value}
                >
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {signals.length > 0 && (
          <div
            className="grid grid-cols-2 gap-1.5 sm:col-span-2"
            data-testid="tool-overview-signals"
          >
            {signals.map((signal) => (
              <fieldset
                aria-label={`${t(
                  `activity:toolOverview.signals.${translationSegment(signal.label)}`,
                  signal.label,
                )} ${signal.value}`}
                key={`${signal.label}:${signal.value}`}
                className={cn(
                  'min-w-0 rounded border px-2 py-1.5 font-mono',
                  signal.tone === 'danger'
                    ? 'border-destructive/35 bg-destructive/[0.07] text-destructive'
                    : signal.tone === 'warning'
                      ? 'border-warning/35 bg-warning/[0.07] text-warning'
                      : signal.tone === 'success'
                        ? 'border-success/35 bg-success/[0.07] text-success'
                        : 'border-border/50 bg-background/60 text-muted-foreground',
                )}
              >
                <p className="truncate text-[9px] uppercase tracking-wide opacity-75">
                  {t(
                    `activity:toolOverview.signals.${translationSegment(signal.label)}`,
                    signal.label,
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs font-semibold tabular-nums">{signal.value}</p>
              </fieldset>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
