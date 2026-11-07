import { readSessionLogEvents } from './session-metrics.js';
import type { RecallExpectation, TraceEvalResult, TranscriptEvalSpec } from './types.js';

/**
 * Evaluate a fresh benchmark-session trace against a transcript-mined case.
 *
 * No model judge is involved. Retrieval checks the successful tool result;
 * recall checks the exact edit intent emitted by the model; edit application
 * follows that same tool-use id through `tool_call_end.ok`. This correlation is
 * the important part: a generic successful edit must not hide the failure of a
 * correct intended edit, and a failed wrong edit must not be blamed on tooling.
 */
export async function evaluateTraceEval(opts: {
  homeDir: string;
  workdir: string;
  spec: TranscriptEvalSpec;
}): Promise<TraceEvalResult> {
  const events = await readSessionLogEvents(opts);
  type ToolUse = { name: string; input: unknown; applied: boolean };
  const toolUses = new Map<string, ToolUse>();
  const attempts: ToolUse[] = [];
  const toolResults: Array<{ name: string; content: unknown; isError: boolean }> = [];

  for (const event of events) {
    const type = event['type'];
    if (type === 'tool_use') {
      const id = toolKey(event);
      const name = stringValue(event['name']);
      if (id && name) {
        const use = { name, input: event['input'], applied: false };
        toolUses.set(id, use);
        attempts.push(use);
      }
      continue;
    }
    if (type === 'tool_call_end') {
      const id = toolKey(event);
      if (!id) continue;
      const use = toolUses.get(id);
      if (use && event['ok'] === true) use.applied = true;
      continue;
    }
    if (type === 'tool_result') {
      const id = toolKey(event);
      const use = id ? toolUses.get(id) : undefined;
      if (use) {
        toolResults.push({
          name: use.name,
          content: event['content'],
          isError: event['isError'] === true,
        });
      }
    }
  }

  const retrievalPassed = opts.spec.retrieval.every((expected) =>
    toolResults.some(
      (result) =>
        !result.isError &&
        matchesToolName(result.name, expected.toolNames) &&
        serialise(result.content).includes(expected.contains),
    ),
  );

  const correctIntents = attempts.filter((use) =>
    matchesRecall(use.name, use.input, opts.spec.recall),
  );
  const recallPassed = correctIntents.length > 0;
  const editApplicationPassed = correctIntents.some((use) => use.applied);

  return {
    sourceSessionId: opts.spec.source.sessionId,
    retrievalPassed,
    recallPassed,
    editApplicationPassed,
  };
}

function matchesRecall(name: string, input: unknown, expected: RecallExpectation): boolean {
  if (!matchesToolName(name, expected.toolNames)) return false;
  const text = serialise(input);
  return expected.inputContains.every((needle) => text.includes(needle));
}

function matchesToolName(name: string, allowList: string[] | undefined): boolean {
  if (!allowList || allowList.length === 0) return true;
  const normalised = name.toLowerCase().replace(/-/g, '_');
  return allowList.some((candidate) => candidate.toLowerCase().replace(/-/g, '_') === normalised);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function toolKey(event: Record<string, unknown>): string | undefined {
  const id = stringValue(event['id']);
  if (!id) return undefined;
  const actor = typeof event['agentId'] === 'string' ? event['agentId'] : '';
  return JSON.stringify([actor, id]);
}

function serialise(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
