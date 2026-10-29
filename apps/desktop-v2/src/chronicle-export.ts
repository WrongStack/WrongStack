import { eventTitle } from './chronicle-model';
import { record } from './engine-values';

type ChronicleEvent = Record<string, unknown>;

/** One journal event per line, exactly as the engine returned it. */
export function chronicleJsonl(events: readonly ChronicleEvent[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
}

/** Inline code that its own backticks cannot close. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Table cells cannot contain line breaks or unescaped pipes. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replaceAll('|', '\\|').trim();
}

/**
 * Readable export of the loaded timeline. Titles and paths are recorded text, so they are
 * escaped for the table rather than rendered as Markdown.
 */
export function chronicleMarkdown(
  events: readonly ChronicleEvent[],
  scope: { filters: string; exportedAt: string; total: unknown },
): string {
  const lines = [
    '# WrongStack Chronicle',
    '',
    `Exported ${scope.exportedAt} · ${events.length} of ${typeof scope.total === 'number' ? scope.total : 'unknown'} matching events · ${scope.filters}`,
    '',
    '| Time (UTC) | Event | Title | Subject | Outcome |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const event of events) {
    const resource = record(event['resource']),
      scopeInfo = record(event['scope']),
      runtime = record(event['runtime']);
    const subject = String(
      resource['path'] ?? resource['id'] ?? runtime['modelId'] ?? scopeInfo['agentId'] ?? '',
    );
    lines.push(
      `| ${cell(String(event['occurredAt'] ?? ''))} | ${cell(String(event['eventType'] ?? ''))} | ${cell(eventTitle(event))} | ${subject ? code(cell(subject)) : ''} | ${cell(String(event['outcome'] ?? 'unknown'))} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

export function chronicleFileName(
  exportedAt: string,
  extension: 'md' | 'jsonl' | 'json',
  kind: 'timeline' | 'lineage' = 'timeline',
) {
  const stamp = exportedAt.replaceAll(':', '-').replaceAll('.', '-');
  return `wrongstack-chronicle-${kind === 'lineage' ? 'lineage-' : ''}${stamp}.${extension}`;
}

/**
 * The traced lineage as Markdown: events with their recorded titles, then each relationship
 * with its kind and the engine's confidence classification, unchanged.
 */
export function chronicleLineageMarkdown(
  graph: Record<string, unknown>,
  scope: { seed: string; exportedAt: string },
): string {
  const nodes = Array.isArray(graph['nodes'])
    ? (graph['nodes'] as ChronicleEvent[]).filter((node) => typeof node['eventId'] === 'string')
    : [];
  const titles = new Map(nodes.map((node) => [String(node['eventId']), eventTitle(node)]));
  const edges = (Array.isArray(graph['edges']) ? (graph['edges'] as ChronicleEvent[]) : []).filter(
    (edge) => titles.has(String(edge['from'])) && titles.has(String(edge['to'])),
  );
  const lines = [
    '# WrongStack Chronicle lineage',
    '',
    `Exported ${scope.exportedAt} · seed ${code(scope.seed)} · ${nodes.length} events · ${edges.length} relationships${graph['truncated'] === true ? ' · truncated at the engine limit' : ''}`,
    '',
    '## Events',
    '',
    '| Time (UTC) | Event | Title | Outcome |',
    '| --- | --- | --- | --- |',
    ...nodes.map(
      (node) =>
        `| ${cell(String(node['occurredAt'] ?? ''))} | ${cell(String(node['eventType'] ?? ''))} | ${cell(eventTitle(node))} | ${cell(String(node['outcome'] ?? 'unknown'))} |`,
    ),
    '',
    '## Relationships',
    '',
    '| From | Relationship | Confidence | To |',
    '| --- | --- | --- | --- |',
    ...edges.map(
      (edge) =>
        `| ${cell(titles.get(String(edge['from']))!)} | ${cell(String(edge['kind'] ?? '').replaceAll('_', ' '))} | ${cell(String(edge['confidence'] ?? 'unknown'))} | ${cell(titles.get(String(edge['to']))!)} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
