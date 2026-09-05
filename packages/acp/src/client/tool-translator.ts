import type { TaskResult, TaskSpec } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
/**
 * ToolTranslator — bidirectional translation between WrongStack tools and
 * ACP tool representations.
 *
 * Used by DIR-1 (WrongStack as ACP client) to:
 *   - Map WrongStack TaskSpec → ACP task payload
 *   - Map ACP tool responses → TaskResult
 *
 * Used by DIR-2 (WrongStack as ACP server) to:
 *   - Convert the WrongStack Tool.inputSchema → ACPToolDefinition.inputSchema
 *   - (handled by tools-registry.ts — same logic lives there)
 *
 * For DIR-1 async tool calls: ACP agents send progress notifications while
 * a tool is running, then send a final result. The translator handles this
 * by polling for the final [result] notification on the transport.
 */
import type {
  ACPMessage,
  ACPToolCallResponse,
  ACPToolDefinition,
  ContentBlock,
} from '../types/acp-messages.js';
export interface ToolTranslatorOptions {
  /**
   * If true (default), wrap tool calls in an async poll loop that waits
   * for progress notifications until a final result arrives.
   */
  asyncTools?: boolean | undefined;
  pollIntervalMs?: number | undefined;
  totalTimeoutMs?: number | undefined;
}

const DEFAULT_OPTIONS: Required<ToolTranslatorOptions> = {
  asyncTools: true,
  pollIntervalMs: 500,
  totalTimeoutMs: 120_000,
};

/** Convert an ACP ACPToolDefinition → a JSON schema object recognisable by WrongStack */
export function acpToolToSchema(def: ACPToolDefinition): Record<string, unknown> {
  if (!def.inputSchema) return { type: 'object', properties: {} };
  return def.inputSchema as Record<string, unknown>;
}

/** Extract tool result text from ACP ContentBlock[] */
export function extractTextFromContent(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'resource') parts.push(`[resource: ${b.resource.uri}]`);
    else if (b.type === 'image') parts.push(`[image: ${b.data.slice(0, 20)}...]`);
    else if (b.type === 'progress') {
      if (b.messages?.length) parts.push(b.messages.join('\n'));
    }
  }
  return parts.join('\n');
}

/** Build a TaskSpec from an ACP task payload */
export function buildTaskSpec(payload: {
  taskId: string;
  task: string;
  subagentId?: string | undefined;
}): TaskSpec {
  return {
    id: payload.taskId,
    description: payload.task,
    subagentId: payload.subagentId,
  };
}

/** Parse an ACP tools/call response → TaskResult */
export function parseToolResponse(
  taskId: string,
  subagentId: string,
  response: ACPToolCallResponse,
): TaskResult {
  const blocks = response.result.content;
  const text = extractTextFromContent(blocks);

  // Detect error state from the structured isError flag only.
  // Textual heuristics (e.g. "0 errors") produce false positives for
  // normal tool output that merely mentions the word "error" in context.
  const isError = response.result.isError === true;

  return {
    taskId,
    subagentId,
    status: isError ? 'failed' : 'success',
    result: text,
    iterations: 1,
    toolCalls: 1,
    durationMs: 0,
  };
}

/** ToolTranslator for DIR-1 — wraps ACP client transport, adds task semantics */
export class ToolTranslator {
  private readonly opts: Required<ToolTranslatorOptions>;
  private readonly pending = new Map<
    string | number,
    {
      resolve: (v: ACPToolCallResponse) => void;
      reject: (e: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(opts: ToolTranslatorOptions = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  /**
   * Start listening to a transport for tool responses and cancellations.
   * Call this once after constructing the translator and before sending tasks.
   */
  attachToTransport(transport: {
    onMessage: (h: (msg: ACPMessage) => void) => () => void;
    send: (msg: ACPMessage) => Promise<void>;
  }): void {
    transport.onMessage((msg) => {
      if (msg.method === 'tools/call' && msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(expectDefined(msg.id));
          pending.resolve(msg as never as ACPToolCallResponse);
        }
      }

      // Handle cancellation notifications
      if (msg.method === 'cancel' && msg.id !== undefined) {
        const pending = this.pending.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(expectDefined(msg.id));
          pending.reject(new Error('Call cancelled by client'));
        }
      }
    });
  }

  /**
   * Send a tool call over the transport and wait for a response.
   * If asyncTools is true, polls for progress and resolves when the final
   * response arrives.
   */
  async callTool(
    transport: { send: (msg: ACPMessage) => Promise<void> },
    name: string,
    args: Record<string, unknown>,
    callId: string | number = crypto.randomUUID(),
  ): Promise<ACPToolCallResponse> {
    await transport.send({
      jsonrpc: '2.0',
      method: 'tools/call',
      id: callId,
      params: { name, arguments: args },
    } as never as ACPMessage);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error(`Tool call ${name} timed out after ${this.opts.totalTimeoutMs}ms`));
      }, this.opts.totalTimeoutMs);

      this.pending.set(callId, { resolve, reject, timeout });
    });
  }

  cancelAll(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timeout);
      // Settle every waiter the way the single-call cancellation path does.
      // Clearing the timer alone would leave the callTool() promise pending
      // FOREVER — the timer was the only thing that could ever reject it.
      p.reject(new Error('Call cancelled by client'));
    }
    this.pending.clear();
  }
}
