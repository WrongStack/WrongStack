import { describe, expect, it } from 'vitest';
import { createToolOutputSerializer } from '../../core/src/utils/tool-output-serializer.js';
import { codebaseIncomingCallsTool } from '../src/codebase-index/codebase-incoming-calls-tool.js';
import { codebaseOutgoingCallsTool } from '../src/codebase-index/codebase-outgoing-calls-tool.js';
import type { CallSite } from '../src/codebase-index/schema.js';

describe('model-facing call graph output', () => {
  it.each([codebaseIncomingCallsTool, codebaseOutgoingCallsTool])(
    '$name shares symbol metadata without dropping call locations or long signatures',
    (tool) => {
      const symbol: CallSite['symbol'] = {
        id: 42,
        name: 'uniqueGraph',
        kind: 'function',
        lang: 'ts',
        file: 'src/graph.ts',
        line: 10,
        signature: `function uniqueGraph(${Array.from({ length: 200 }, (_, i) => `parameter${i}: string`).join(', ')}): void`,
      };
      const calls: CallSite[] = Array.from({ length: 200 }, (_, i) => ({
        symbol: { ...symbol },
        callType: 'call',
        line: 20 + i,
      }));
      // An identical id with different metadata must not be collapsed.
      calls.push({ symbol: { ...symbol, file: 'src/other.ts' }, callType: 'type_ref', line: 1 });
      const output = {
        symbol: 'target',
        calls,
        total: calls.length,
        stale: true,
        note: 'Index refreshing.',
      };
      const text = createToolOutputSerializer().serialize(output, {
        toolName: tool.name,
        tool: tool as never,
      });
      expect(text.split('parameter199: string').length - 1).toBe(2);
      const serialized = JSON.parse(text);
      expect(serialized.symbols).toHaveLength(2);
      expect(
        serialized.calls.map((call: { symbolIndex: number; callType: string; line: number }) => ({
          symbol: serialized.symbols[call.symbolIndex],
          callType: call.callType,
          line: call.line,
        })),
      ).toEqual(calls);
      expect(serialized.total).toBe(output.total);
      expect(serialized.stale).toBe(true);
      expect(serialized.note).toBe(output.note);
    },
  );
});
