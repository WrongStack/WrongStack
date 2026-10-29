import { entries, record } from './engine-values';

export interface ManifestView {
  manifestId: string;
  messageCount: number | null;
  estimatedMessageTokens: number | null;
  contentBytes: number | null;
  roles: [string, number][];
  blockKinds: [string, number][];
  system: {
    blockCount: number | null;
    bytes: number | null;
    hash: string;
    blocks: { source: string; bytes: number | null; hash: string }[] | null;
  };
  messages: {
    index: number | null;
    role: string;
    bytes: number | null;
    estimatedTokens: number | null;
    hash: string;
  }[];
  /** Earlier messages Chronicle left out of the stored summary (the manifest ID covers them). */
  messagesOmitted: number;
  tools: {
    count: number | null;
    estimatedDefinitionTokens: number | null;
    manifestHash: string;
    /** Null when names were stored once on an earlier request with the same tool set. */
    names: string[] | null;
    namesRef: string;
    mutating: number | null;
    destructive: number | null;
  };
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const counts = (value: unknown): [string, number][] =>
  Object.entries(record(value))
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b));

/**
 * The prompt manifest Chronicle stored on a provider request event, as recorded. Missing
 * numbers stay null (shown as not recorded); nothing is recomputed from the prompt itself.
 */
export function chronicleManifest(attributes: unknown): ManifestView | null {
  const raw = record(record(attributes)['promptManifest']);
  if (!text(raw['manifestId'])) return null;
  const system = record(raw['system']),
    tools = record(raw['tools']);
  return {
    manifestId: text(raw['manifestId']),
    messageCount: count(raw['messageCount']),
    estimatedMessageTokens: count(raw['estimatedMessageTokens']),
    contentBytes: count(raw['contentBytes']),
    roles: counts(raw['roleCounts']),
    blockKinds: counts(raw['blockCounts']),
    system: {
      blockCount: count(system['blockCount']),
      bytes: count(system['bytes']),
      hash: text(system['hash']),
      blocks: Array.isArray(system['blocks'])
        ? entries(system['blocks']).map((block) => ({
            source: text(block['source']) || 'unlabelled',
            bytes: count(block['bytes']),
            hash: text(block['hash']),
          }))
        : null,
    },
    messages: entries(raw['messages']).map((message) => ({
      index: count(message['index']),
      role: text(message['role']) || 'unknown',
      bytes: count(message['bytes']),
      estimatedTokens: count(message['estimatedTokens']),
      hash: text(message['hash']),
    })),
    messagesOmitted: count(raw['messagesTruncated']) ?? 0,
    tools: {
      count: count(tools['count']),
      estimatedDefinitionTokens: count(tools['estimatedDefinitionTokens']),
      manifestHash: text(tools['manifestHash']),
      names: Array.isArray(tools['names']) ? tools['names'].map(String) : null,
      namesRef: text(tools['namesRef']),
      mutating: count(tools['mutating']),
      destructive: count(tools['destructive']),
    },
  };
}

/** Attributes shown in the generic evidence list once the manifest has its own section. */
export function withoutManifest(attributes: unknown): Record<string, unknown> {
  const { promptManifest: _manifest, ...rest } = record(attributes);
  return chronicleManifest(attributes) ? rest : record(attributes);
}
