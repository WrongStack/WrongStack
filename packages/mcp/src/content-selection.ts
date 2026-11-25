import type {
  MCPGetPromptResult,
  MCPPromptMessage,
  MCPReadResourceResult,
  MCPResourceContents,
} from './protocol.js';

export const DEFAULT_MCP_INSERTION_MAX_BYTES = 256 * 1024;
export const DEFAULT_MCP_RESOURCE_SCHEMES = [
  'file',
  'git',
  'http',
  'https',
  'mcp',
  'mem',
  'repo',
  'resource',
] as const;

export interface MCPInsertionPolicy {
  maxBytes?: number | undefined;
  allowedUriSchemes?: readonly string[] | undefined;
}

export interface MCPContentProvenance {
  origin: 'mcp';
  serverName: string;
  capability: 'resource' | 'prompt';
  resourceUri?: string | undefined;
  promptName?: string | undefined;
  promptArgumentNames?: string[] | undefined;
}

export interface MCPResourceInsertion {
  kind: 'resource';
  untrusted: true;
  byteSize: number;
  provenance: MCPContentProvenance;
  contents: MCPResourceContents[];
}

export interface MCPPromptInsertion {
  kind: 'prompt';
  untrusted: true;
  byteSize: number;
  provenance: MCPContentProvenance;
  description?: string | undefined;
  messages: MCPPromptMessage[];
}

export function prepareResourceInsertion(
  serverName: string,
  requestedUri: string,
  result: MCPReadResourceResult,
  policy: MCPInsertionPolicy = {},
): MCPResourceInsertion {
  requireIdentity(serverName, 'server name');
  validateUri(requestedUri, policy);
  if (result.contents.length > 64) {
    throw new Error('MCP resource insertion exceeds the limit of 64 content blocks');
  }
  let byteSize = 0;
  enforceSize(byteSize, policy);
  for (const content of result.contents) {
    validateUri(content.uri, policy);
    if (content.text !== undefined) byteSize += utf8Bytes(content.text);
    if (content.blob !== undefined) byteSize += base64DecodedBytes(content.blob);
    enforceSize(byteSize, policy);
  }
  return {
    kind: 'resource',
    untrusted: true,
    byteSize,
    provenance: {
      origin: 'mcp',
      serverName,
      capability: 'resource',
      resourceUri: requestedUri,
    },
    contents: structuredClone(result.contents),
  };
}

export function preparePromptInsertion(
  serverName: string,
  promptName: string,
  args: Record<string, string> | undefined,
  result: MCPGetPromptResult,
  policy: MCPInsertionPolicy = {},
): MCPPromptInsertion {
  requireIdentity(serverName, 'server name');
  requireIdentity(promptName, 'prompt name');
  if (result.messages.length > 128) {
    throw new Error('MCP prompt insertion exceeds the limit of 128 messages');
  }
  for (const message of result.messages) validateEmbeddedUris(message.content, policy, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(result.messages);
  } catch {
    throw new Error('MCP prompt insertion contains non-serializable content');
  }
  const byteSize = utf8Bytes(serialized);
  enforceSize(byteSize, policy);
  return {
    kind: 'prompt',
    untrusted: true,
    byteSize,
    provenance: {
      origin: 'mcp',
      serverName,
      capability: 'prompt',
      promptName,
      promptArgumentNames: Object.keys(args ?? {}).sort(),
    },
    description: result.description,
    messages: structuredClone(result.messages),
  };
}

function validateEmbeddedUris(value: unknown, policy: MCPInsertionPolicy, depth: number): void {
  if (depth > 32) throw new Error('MCP prompt insertion exceeds the nesting depth limit');
  if (Array.isArray(value)) {
    for (const item of value) validateEmbeddedUris(item, policy, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'uri' && typeof nested === 'string') validateUri(nested, policy);
    validateEmbeddedUris(nested, policy, depth + 1);
  }
}

function validateUri(uri: string, policy: MCPInsertionPolicy): void {
  if (uri.length === 0 || uri.length > 8_192) {
    throw new Error('MCP insertion URI must contain 1–8192 characters');
  }
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error('MCP insertion URI must be absolute');
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  const allowed = new Set(
    (policy.allowedUriSchemes ?? DEFAULT_MCP_RESOURCE_SCHEMES).map((value) => value.toLowerCase()),
  );
  if (!allowed.has(scheme)) {
    throw new Error(`MCP insertion URI scheme "${scheme}" is not allowed`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('MCP insertion URI must not contain credentials');
  }
}

function enforceSize(byteSize: number, policy: MCPInsertionPolicy): void {
  const maxBytes = policy.maxBytes ?? DEFAULT_MCP_INSERTION_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('MCP insertion maxBytes must be a positive safe integer');
  }
  if (byteSize > maxBytes) {
    throw new Error(`MCP insertion exceeds the ${maxBytes}-byte content limit`);
  }
}

function base64DecodedBytes(blob: string): number {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob)) {
    throw new Error('MCP resource insertion contains invalid base64 content');
  }
  const padding = blob.endsWith('==') ? 2 : blob.endsWith('=') ? 1 : 0;
  return (blob.length / 4) * 3 - padding;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function requireIdentity(value: string, label: string): void {
  if (value.length === 0 || value.length > 256) {
    throw new Error(`MCP insertion ${label} must contain 1–256 characters`);
  }
}
