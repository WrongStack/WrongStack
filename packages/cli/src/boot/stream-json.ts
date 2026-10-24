/**
 * `--output-format stream-json`: single-shot progress as JSON Lines on stdout.
 *
 * One object per line, each with a `type`:
 *   init         session id, provider/model, cwd, tool names — first line
 *   text_delta   streamed answer text (only with --include-partial-messages)
 *   assistant    one model response: text and tool_use blocks, stop reason, usage
 *   tool_result  one finished tool call: id, name, ok, duration, output preview
 *   result       the `--output-json` payload — always the last line
 *
 * Only the leader's own activity is streamed. Subagents report through their
 * `subagent.*` events; the ones that reach the host bus under the plain names
 * carry a non-leader `agentId` and are dropped, so a delegating run does not
 * interleave several conversations on one stream.
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { ContentBlock } from '@wrongstack/contracts/types';

export type OutputFormat = 'text' | 'json' | 'stream-json';

/** `undefined` when the flag is absent. Throws on an unknown format. */
export function parseOutputFormat(value: string | boolean | undefined): OutputFormat | undefined {
  if (value === undefined) return undefined;
  if (value === 'text' || value === 'json' || value === 'stream-json') return value;
  throw new Error(
    `--output-format must be text, json or stream-json (got ${value === true ? 'nothing' : `"${value}"`})`,
  );
}

const LEADER = 'leader';

function isLeader(agentId: string | undefined): boolean {
  return agentId === undefined || agentId === LEADER;
}

function simplifyBlocks(content: readonly ContentBlock[] | undefined): unknown[] {
  const out: unknown[] = [];
  for (const block of content ?? []) {
    if (block.type === 'text') out.push({ type: 'text', text: block.text });
    else if (block.type === 'tool_use') {
      out.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
    }
  }
  return out;
}

export interface StreamJsonOptions {
  events: Pick<EventBus, 'on'>;
  /** Writes one line (the caller adds nothing; this function appends `\n`). */
  write: (line: string) => void;
  includePartialMessages: boolean;
}

/** Subscribe and start writing. Returns the unsubscribe function. */
export function startStreamJson(opts: StreamJsonOptions): () => void {
  const emit = (payload: Record<string, unknown>): void => {
    opts.write(`${JSON.stringify(payload)}\n`);
  };
  const offs: Array<() => void> = [];

  if (opts.includePartialMessages) {
    offs.push(
      opts.events.on('provider.text_delta', (e) => {
        if (isLeader(e.ctx?.agentId)) emit({ type: 'text_delta', text: e.text });
      }),
    );
  }
  offs.push(
    opts.events.on('provider.response', (e) => {
      if (!isLeader(e.ctx?.agentId)) return;
      emit({
        type: 'assistant',
        model: e.model,
        content: simplifyBlocks(e.content),
        stopReason: e.stopReason,
        usage: e.usage,
      });
    }),
  );
  offs.push(
    opts.events.on('tool.executed', (e) => {
      if (!isLeader(e.agentId)) return;
      emit({
        type: 'tool_result',
        id: e.id ?? null,
        name: e.name,
        ok: e.ok,
        durationMs: e.durationMs,
        output: e.output ?? null,
        outputBytes: e.outputBytes ?? null,
      });
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}

/** The first line of the stream. */
export function streamJsonInit(info: {
  sessionId: string | null;
  provider: string | null;
  model: string | null;
  cwd: string;
  tools: readonly string[];
}): string {
  return `${JSON.stringify({ type: 'init', ...info })}\n`;
}
