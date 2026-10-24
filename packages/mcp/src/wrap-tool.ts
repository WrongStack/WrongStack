import type { Permission, Tool } from '@wrongstack/contracts/types';
import { createSandboxMcpGate } from '@wrongstack/core/sandbox';
import { ToolCapabilities } from '@wrongstack/core/security';
import { mcpQualifiedToolName } from '@wrongstack/core/utils';
import type { MCPClient } from './client.js';
import type { MCPTool, ToolCallResult } from './contracts.js';
import type { ElicitationRequester } from './elicitation.js';
import { renderStructuredResult } from './structured-result.js';
import type { MCPTaskContext as AgentContext } from './task-identity.js';

/**
 * Keywords that indicate a mutating operation.
 * Applied to both the tool name and its inputSchema property names.
 */
const MUTATING_RE = /create|update|delete|write|send|set|put|post|patch|remove|rename|move/i;

function isMutatingTool(mcpTool: MCPTool): boolean {
  if (MUTATING_RE.test(mcpTool.name)) return true;
  // Check property names in the input schema for mutating intent.
  // e.g. { properties: { createTable: {...}, dropIndex: {...} } }
  const schema = mcpTool.inputSchema;
  if (schema && typeof schema === 'object') {
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (props) {
      for (const key of Object.keys(props)) {
        if (MUTATING_RE.test(key)) return true;
      }
    }
  }
  return false;
}

/**
 * Resolves the live client for a tool call. A plain {@link MCPClient} for eager
 * servers, or a thunk that connects-on-demand for lazy/dormant servers (the
 * registry passes `() => this.ensureConnected(name)`).
 */
export type MCPClientResolver = MCPClient | (() => Promise<MCPClient>);

export interface MCPToolCallObserver {
  /** `caller` is the run making the call — who a server elicitation mid-call should ask. */
  onStart(caller?: ElicitationRequester | undefined): void;
  onFinish(
    result: { durationMs: number; ok: boolean },
    caller?: ElicitationRequester | undefined,
  ): void;
}

export function wrapMCPTool(
  serverName: string,
  mcpTool: MCPTool,
  client: MCPClientResolver,
  permission: Permission = 'confirm',
  sandboxTrust = false,
  observer?: MCPToolCallObserver | undefined,
  taskRunner?:
    | ((
        client: MCPClient,
        tool: MCPTool,
        input: unknown,
        context: AgentContext,
        signal?: AbortSignal,
      ) => Promise<ToolCallResult>)
    | undefined,
): Tool {
  // Sandbox gate (plan 28): MCP tool calls are DENIED under enforced tiers —
  // their effects run in the server process and cannot be routed (SDD
  // conflict analysis). mode 'off' (default) is a pure pass-through.
  // mcpServers.*.sandboxTrust (user-global only) bypasses it for this server.
  const sandboxGate = createSandboxMcpGate({ trusted: sandboxTrust });
  // Sanitized to the provider-wire pattern ^[a-zA-Z0-9_-]{1,128}$ — server
  // names and remote tool names may contain dots/colons/spaces that
  // Anthropic-family endpoints reject with a 400. The remote call below
  // still uses the original `mcpTool.name`.
  const qualifiedName = mcpQualifiedToolName(serverName, mcpTool.name);
  const tool: Tool = {
    name: qualifiedName,
    description: mcpTool.description ?? `${qualifiedName} (MCP tool)`,
    usageHint: `Tool provided by MCP server "${serverName}". ${mcpTool.description ?? ''}`,
    permission,
    mutating: isMutatingTool(mcpTool),
    capabilities: [ToolCapabilities.MCP_PROXY],
    inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    async execute(input, ctx, opts) {
      const startedAt = Date.now();
      observer?.onStart(ctx);
      let ok = false;
      try {
        // For a dormant lazy server this spawns the process + handshakes before
        // the first call; for an eager server it resolves to the fixed client.
        const live = typeof client === 'function' ? await client() : client;
        // Propagate the run's abort signal. Modern Tasks use cooperative
        // tasks/cancel; legacy requests use notifications/cancelled.
        const signal = opts?.signal ?? ctx?.signal;
        const res = taskRunner
          ? await taskRunner(live, mcpTool, input, ctx, signal)
          : await live.callTool(mcpTool.name, input, {
              ...(signal ? { signal } : {}),
              requester: ctx,
            });
        if (res.urlElicitations && res.urlElicitations.length > 0) {
          // Still inside the call, so the pages go to this run's user.
          const outcomes = await live.presentUrlElicitations(
            res.urlElicitations,
            signal ?? new AbortController().signal,
          );
          throw new Error(describeUrlOutcomes(serverName, qualifiedName, outcomes));
        }
        if (res.isError) {
          const errText = stringify(res.content);
          throw new Error(errText || `MCP tool "${qualifiedName}" failed`);
        }
        ok = true;
        return renderMcpToolResult(mcpTool, res);
      } finally {
        observer?.onFinish({ durationMs: Date.now() - startedAt, ok }, ctx);
      }
    },
  };
  return sandboxGate(tool);
}

export function renderMcpToolResult(tool: MCPTool, result: ToolCallResult): string {
  return renderStructuredResult(
    stringify(result.content),
    result.content,
    result.structuredContent,
    tool.outputSchema,
  );
}

/** What the model is told after a `-32042`: which pages, what the user chose, whether to retry. */
function describeUrlOutcomes(
  serverName: string,
  toolName: string,
  outcomes: Awaited<ReturnType<MCPClient['presentUrlElicitations']>>,
): string {
  const lines = outcomes.map(({ elicitation, action }) => {
    const site = new URL(elicitation.url).host;
    const choice =
      action === 'accept'
        ? 'the user agreed to open it'
        : action === 'decline'
          ? 'the user declined'
          : 'no answer';
    return `- ${site}: ${elicitation.message} (${choice})`;
  });
  const agreed = outcomes.length > 0 && outcomes.every((o) => o.action === 'accept');
  return [
    `MCP server "${serverName}" needs the user to finish a step in the browser before "${toolName}" can run:`,
    ...lines,
    agreed
      ? 'Ask the user to tell you when they have finished, then call the tool again.'
      : 'The user did not agree to every page, so do not call the tool again unless they ask.',
  ].join('\n');
}

/**
 * Render one MCP content block as model-facing text.
 *
 * Non-text blocks used to be JSON-stringified whole, so an `image`/`audio`
 * block landed in the context as megabytes of base64 the model cannot read —
 * burning the window and tripping truncation for nothing. Binary payloads are
 * summarized; embedded resource TEXT is kept because it is readable content.
 */
function renderContentBlock(item: Record<string, unknown>): string {
  const type = item['type'];
  if (type === 'text') return typeof item['text'] === 'string' ? item['text'] : '';
  if (type === 'image' || type === 'audio') {
    const mime = typeof item['mimeType'] === 'string' ? item['mimeType'] : 'unknown type';
    const data = typeof item['data'] === 'string' ? item['data'] : '';
    const kb = data.length === 0 ? 0 : Math.max(1, Math.round((data.length * 3) / 4 / 1024));
    return `[${type} content: ${mime}, ~${kb} KB — binary payload not inlined]`;
  }
  if (type === 'resource' && item['resource'] && typeof item['resource'] === 'object') {
    const resource = item['resource'] as Record<string, unknown>;
    const uri = typeof resource['uri'] === 'string' ? resource['uri'] : 'unknown';
    if (typeof resource['text'] === 'string') return `[resource ${uri}]\n${resource['text']}`;
    if (typeof resource['blob'] === 'string') {
      const mime = typeof resource['mimeType'] === 'string' ? `${resource['mimeType']}, ` : '';
      return `[resource ${uri}: ${mime}binary payload not inlined]`;
    }
    return JSON.stringify(item);
  }
  if (type === 'resource_link' && typeof item['uri'] === 'string') {
    return `[resource link: ${item['uri']}]`;
  }
  if ('text' in item) {
    return String(item['text'] ?? '');
  }
  return JSON.stringify(item);
}

function stringify(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((item) => {
        if (item && typeof item === 'object') {
          return renderContentBlock(item as Record<string, unknown>);
        }
        return String(item);
      })
      .join('\n');
  }
  if (c && typeof c === 'object') {
    return renderContentBlock(c as Record<string, unknown>);
  }
  return String(c ?? '');
}
