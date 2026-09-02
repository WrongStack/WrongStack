import { createHash } from 'node:crypto';
import type { ContentBlock } from '../types/blocks.js';
import type { Message } from '../types/messages.js';
import type { Request } from '../types/provider.js';

export interface ChroniclePromptManifest {
  manifestId: string;
  messageCount: number;
  estimatedMessageTokens: number;
  contentBytes: number;
  roleCounts: Record<string, number>;
  blockCounts: Record<string, number>;
  system: { blockCount: number; bytes: number; hash: string };
  messages: Array<{
    index: number;
    role: string;
    bytes: number;
    estimatedTokens?: number;
    hash: string;
    blocks: Record<string, number>;
  }>;
  tools: {
    count: number;
    estimatedDefinitionTokens: number;
    manifestHash: string;
    names: string[];
    mutating: number;
    destructive: number;
  };
  request: Record<string, unknown>;
}

/** Content-addressed prompt composition manifest; raw prompt/tool prose never leaves this function. */
export function createChroniclePromptManifest(request: Request): ChroniclePromptManifest {
  const roleCounts: Record<string, number> = {},
    blockCounts: Record<string, number> = {};
  const messages = request.messages.map((message, index) =>
    messageSummary(message, index, roleCounts, blockCounts),
  );
  const systemText = (request.system ?? []).map((block) => block.text).join('\n');
  const toolRecords = (request.tools ?? []).map((tool) => ({
    name: tool.name,
    schemaHash: hash(stable(tool.inputSchema)),
    permission: tool.permission,
    mutating: tool.mutating,
    riskTier: tool.riskTier,
    capabilities: tool.capabilities,
    estimatedTokens: tool._estDefTokens ?? 0,
  }));
  const core = {
    systemHash: hash(systemText),
    messages: messages.map(({ hash: contentHash, ...rest }) => ({ ...rest, contentHash })),
    tools: toolRecords,
    model: request.model,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    topK: request.topK,
    seed: request.seed,
    toolChoice: request.toolChoice,
    reasoning: request.reasoning,
    cache: request.cache,
    responseFormat: request.responseFormat?.type,
  };
  return {
    manifestId: `prompt_${hash(stable(core))}`,
    messageCount: messages.length,
    estimatedMessageTokens: messages.reduce(
      (sum, message) => sum + (message.estimatedTokens ?? 0),
      0,
    ),
    contentBytes:
      messages.reduce((sum, message) => sum + message.bytes, 0) + Buffer.byteLength(systemText),
    roleCounts,
    blockCounts,
    system: {
      blockCount: request.system?.length ?? 0,
      bytes: Buffer.byteLength(systemText),
      hash: hash(systemText),
    },
    messages,
    tools: {
      count: toolRecords.length,
      estimatedDefinitionTokens: toolRecords.reduce((sum, tool) => sum + tool.estimatedTokens, 0),
      manifestHash: hash(stable(toolRecords)),
      names: toolRecords.map((tool) => tool.name),
      mutating: toolRecords.filter((tool) => tool.mutating).length,
      destructive: toolRecords.filter((tool) => tool.riskTier === 'destructive').length,
    },
    request: {
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      frequencyPenalty: request.frequencyPenalty,
      presencePenalty: request.presencePenalty,
      seed: request.seed,
      candidateCount: request.candidateCount,
      logprobs: request.logprobs,
      topLogprobs: request.topLogprobs,
      stopSequenceCount: request.stopSequences?.length ?? 0,
      toolChoice: request.toolChoice,
      reasoning: request.reasoning,
      cache: request.cache,
      responseFormat: request.responseFormat?.type,
      safetySettingCount: request.safetySettings?.length ?? 0,
      userHash: request.user ? hash(request.user) : undefined,
    },
  };
}

function messageSummary(
  message: Message,
  index: number,
  roles: Record<string, number>,
  totals: Record<string, number>,
) {
  roles[message.role] = (roles[message.role] ?? 0) + 1;
  const blocks = typeof message.content === 'string' ? { text: 1 } : countBlocks(message.content);
  for (const [type, count] of Object.entries(blocks)) totals[type] = (totals[type] ?? 0) + count;
  const content = contentIdentity(message.content);
  return {
    index,
    role: message.role,
    bytes: content.bytes,
    ...(message._estTokens !== undefined ? { estimatedTokens: message._estTokens } : {}),
    hash: content.hash,
    blocks,
  };
}
function countBlocks(blocks: ContentBlock[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const block of blocks) counts[block.type] = (counts[block.type] ?? 0) + 1;
  return counts;
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function contentIdentity(content: Message['content']): { hash: string; bytes: number } {
  if (typeof content === 'string')
    return { hash: hash(content), bytes: Buffer.byteLength(content) };
  const digest = createHash('sha256');
  let bytes = 0;
  const add = (value: string | undefined) => {
    if (!value) return;
    digest.update(value);
    bytes += Buffer.byteLength(value);
  };
  for (const block of content) {
    add(block.type);
    if (block.type === 'text') add(block.text);
    else if (block.type === 'thinking') {
      add(block.thinking);
      add(block.signature);
    } else if (block.type === 'tool_use') {
      add(block.id);
      add(block.name);
      add(stable(block.input));
    } else if (block.type === 'tool_result') {
      add(block.tool_use_id);
      add(block.name);
      add(block.content);
      add(String(block.is_error ?? false));
    } else if (block.type === 'image') {
      add(block.source.type);
      add(block.source.media_type);
      add(block.source.url);
      add(block.source.data);
    }
  }
  return { hash: digest.digest('hex'), bytes };
}
function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
    .join(',')}}`;
}
