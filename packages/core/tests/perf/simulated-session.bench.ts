import { bench, describe } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DefaultSessionStore,
  estimateRequestTokens,
  estimateRequestTokensCalibrated,
  getCalibrationState,
  recordActualUsage,
  type SessionEvent,
  type Message,
} from '../../src/index.js';
import { repairToolUseAdjacency } from '../../src/utils/message-invariants.js';

// ── Simulated Agent Iteration — CPU-Only Hot Path ─────────────────────────
//
// Replicates the CPU-bound work of ONE agent iteration (everything except
// the LLM provider call itself). Each iteration:
//   1. Build request pipeline (inc. adjacency repair if dirty)
//   2. Append llm_request to session log (inc. token estimate)
//   3. Process response — append assistant message to session
//   4. Execute tools — batch-append tool results to session
//   5. Emit context pct event (inc. token estimate)
//
// We run 50 iterations with 300-message contexts and 5-tool batches to
// match a realistic long session. The session I/O is directed to a tmp
// directory (B1 still applies — we want to measure CPU improvement from
// B2-B4 on top of the already-deployed buffer).

const TOOLS = Array.from({ length: 50 }, (_, i) => ({
  name: `tool-${i}`,
  description: `Tool ${i} for realistic context `.repeat(5),
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}));
const SYSTEM = [{ type: 'text' as const, text: 'You are a coding agent. '.repeat(100) }];

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      msgs.push({
        role: 'user',
        content: `user request ${i}: `.repeat(40),
      });
    } else {
      msgs.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `response ${i}: `.repeat(120) },
          { type: 'tool_use', id: `tu-${i}`, name: 'read', input: { path: `src/file-${i}.ts` } },
        ],
      });
    }
  }
  return msgs;
}

function makeToolResultEvents(count: number): SessionEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'tool_result' as const,
    ts: new Date().toISOString(),
    id: `tu-${i}`,
    content: `tool output ${i}: `.repeat(80),
    isError: false,
  }));
}

async function runSimulatedSession(
  iterations: number,
  messageCount: number,
  toolsPerIteration: number,
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-sim-'));
  try {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await store.create({ id: 'sim', model: 'test', provider: 'test' });

    const messages = makeMessages(messageCount);
    // Track adjacency dirty flag (simulates Context.toolAdjacencyDirty)
    let dirty = false;

    for (let i = 0; i < iterations; i++) {
      // ── Build request pipeline (B4: adjacency repair guard) ──────────
      if (dirty) {
        const repaired = repairToolUseAdjacency(messages);
        if (repaired.report.changed) {
          // In production: ctx.state.replaceMessages(repaired.messages)
          // For benchmark: just verify correctness
        }
        dirty = false;
      }

      // ── Append llm_request to session (B3: preFlight token estimate) ──
      const preFlight = estimateRequestTokens(messages, SYSTEM, TOOLS);
      await w.append({
        type: 'llm_request',
        ts: new Date().toISOString(),
        model: 'test',
        messageCount: messages.length,
        estimatedInputTokens: preFlight.total,
        toolCount: TOOLS.length,
      });

      // ── Record calibration (B3: derived from preFlight) ─────────────
      const cal = getCalibrationState('sim/test');
      const calibratedTotal = cal.calibrated
        ? Math.round(preFlight.total * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : preFlight.total;
      recordActualUsage(preFlight.total, calibratedTotal, 'sim/test');

      // ── Append assistant response (simulate processResponse) ────────
      const hasTools = i % 3 !== 0; // ~67% of iterations have tool calls
      const assistantContent: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
      > = [{ type: 'text', text: `iteration ${i} response `.repeat(80) }];
      if (hasTools) {
        for (let t = 0; t < toolsPerIteration; t++) {
          assistantContent.push({
            type: 'tool_use',
            id: `tu-${i}-${t}`,
            name: 'read',
            input: { path: `src/file-${i}-${t}.ts` },
          });
        }
        dirty = true; // tool_use blocks → adjacency may be dirty
      }

      await w.append({
        type: 'llm_response',
        ts: new Date().toISOString(),
        content: assistantContent,
        stopReason: 'end_turn',
        usage: { input: preFlight.total, output: 500 },
      });

      // ── Execute tools + batch-append results (B2) ───────────────────
      if (hasTools) {
        const toolResults = makeToolResultEvents(toolsPerIteration);
        // B2: batch-append all tool results in one call
        await w.appendBatch(toolResults);
        dirty = true; // tool results → adjacency may be dirty
      }

      // ── Emit context pct (B3: expensive token estimate) ─────────────
      estimateRequestTokens(messages, SYSTEM, TOOLS).total;
    }

    await w.close();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('Simulated 50-iteration agent session (CPU hot path)', () => {
  bench('50 iter × 300 msgs × 5 tools (optimized — B2+B3+B4)', async () => {
    await runSimulatedSession(50, 300, 5);
  });

  bench('100 iter × 500 msgs × 10 tools (heavy, optimized)', async () => {
    await runSimulatedSession(100, 500, 10);
  });
});

// ── Old-path comparison: simulates the pre-optimization code paths ────────

async function runOldPathSession(
  iterations: number,
  messageCount: number,
  toolsPerIteration: number,
): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-old-'));
  try {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await store.create({ id: 'old', model: 'test', provider: 'test' });
    const messages = makeMessages(messageCount);

    for (let i = 0; i < iterations; i++) {
      // OLD B4: always scan adjacency regardless of dirty state
      const repaired = repairToolUseAdjacency(messages);
      if (repaired.report.changed) {
        /* apply */
      }

      // OLD B3: two separate estimateRequestTokens calls
      const est1 = estimateRequestTokens(messages, SYSTEM, TOOLS).total;
      await w.append({
        type: 'llm_request',
        ts: new Date().toISOString(),
        model: 'test',
        messageCount: messages.length,
        estimatedInputTokens: est1,
        toolCount: TOOLS.length,
      });

      // OLD B3: second call via estimateRequestTokensCalibrated
      const calEst = estimateRequestTokensCalibrated(messages, SYSTEM, TOOLS, 'old/test').total;
      recordActualUsage(est1, calEst, 'old/test');

      const hasTools = i % 3 !== 0;
      const assistantContent = hasTools
        ? [
            { type: 'text' as const, text: `iter ${i} `.repeat(80) },
            ...Array.from({ length: toolsPerIteration }, (_, t) => ({
              type: 'tool_use' as const,
              id: `tu-${i}-${t}`,
              name: 'read',
              input: { path: `src/file-${i}-${t}.ts` },
            })),
          ]
        : [{ type: 'text' as const, text: `iter ${i} `.repeat(80) }];

      await w.append({
        type: 'llm_response',
        ts: new Date().toISOString(),
        content: assistantContent,
        stopReason: 'end_turn',
        usage: { input: est1, output: 500 },
      });

      // OLD B2: sequential append() calls for each tool result
      if (hasTools) {
        for (let t = 0; t < toolsPerIteration; t++) {
          await w.append({
            type: 'tool_result',
            ts: new Date().toISOString(),
            id: `tu-${i}-${t}`,
            content: `tool output ${i}-${t}: `.repeat(80),
            isError: false,
          });
        }
        // Still dirty for next iteration's adjacency check (same as new path)
      }

      // OLD B3: emitContextPct calls estimateRequestTokensCalibrated
      estimateRequestTokensCalibrated(messages, SYSTEM, TOOLS, 'old/pct').total;
    }

    await w.close();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('Old path comparison (pre-B2/B3/B4)', () => {
  bench(
    '50 iter × 300 msgs × 5 tools (old — always scan, double estimate, sequential appends)',
    async () => {
      await runOldPathSession(50, 300, 5);
    },
  );

  bench('100 iter × 500 msgs × 10 tools (heavy, old path)', async () => {
    await runOldPathSession(100, 500, 10);
  });
});
