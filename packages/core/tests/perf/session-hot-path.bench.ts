import { bench, describe } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DefaultSessionStore,
  estimateRequestTokens,
  estimateRequestTokensCalibrated,
  getCalibrationState,
} from '../../src/index.js';
import { repairToolUseAdjacency } from '../../src/utils/message-invariants.js';
import type { Message, SessionEvent } from '../../src/index.js';

// ── B1: Write buffer — session append/close throughput ───────────────────
//
// Measures the end-to-end cost of appending N events and closing a session.
// With the write buffer (B1), individual append() calls push to an in-memory
// buffer and close() flushes them in one batch. Without the buffer, each
// append() would be a synchronous appendFile() call.
//
// The benchmark creates a fresh session, appends synthetic user_input +
// llm_response pairs, then closes. We measure wall time per event for
// realistic iteration counts (1, 5, 10 events).

async function sessionThroughput(eventCount: number): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bench-'));
  try {
    const store = new DefaultSessionStore({ dir: tmp });
    const w = await store.create({ id: 'bench', model: 'm', provider: 'p' });
    for (let i = 0; i < eventCount; i++) {
      await w.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: `bench event ${i}: lorem ipsum dolor sit amet `.repeat(5),
      });
    }
    await w.close();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

describe('B1 — session write buffer throughput', () => {
  bench('1 event → close', async () => {
    await sessionThroughput(1);
  });

  bench('5 events → close', async () => {
    await sessionThroughput(5);
  });

  bench('10 events → close', async () => {
    await sessionThroughput(10);
  });

  bench('50 events → close', async () => {
    await sessionThroughput(50);
  });
});

// ── B2: Batch tool result appends ─────────────────────────────────────────
//
// Measures appendBatch() vs N individual append() calls. With B2, all
// tool_result events for an iteration are collected and appended in one
// batch call instead of N sequential calls.

function makeToolResult(id: string, content: string): SessionEvent {
  return {
    type: 'tool_result',
    ts: new Date().toISOString(),
    id,
    content,
    isError: false,
  };
}

async function sequentialAppends(
  store: DefaultSessionStore,
  events: SessionEvent[],
): Promise<void> {
  const w = await store.create({ id: 'seq', model: 'm', provider: 'p' });
  for (const e of events) await w.append(e);
  await w.close();
}

async function batchAppend(store: DefaultSessionStore, events: SessionEvent[]): Promise<void> {
  const w = await store.create({ id: 'batch', model: 'm', provider: 'p' });
  await w.appendBatch(events);
  await w.close();
}

describe('B2 — batch vs sequential tool result appends', () => {
  const toolCounts = [1, 5, 10, 20];

  for (const n of toolCounts) {
    const events = Array.from({ length: n }, (_, i) =>
      makeToolResult(`tu-${i}`, `tool result ${i}: `.repeat(20)),
    );

    bench(`${n} tools — sequential append()`, async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bench-'));
      try {
        await sequentialAppends(new DefaultSessionStore({ dir: tmp }), events);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });

    bench(`${n} tools — batch appendBatch()`, async () => {
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-bench-'));
      try {
        await batchAppend(new DefaultSessionStore({ dir: tmp }), events);
      } finally {
        await fs.rm(tmp, { recursive: true, force: true });
      }
    });
  }
});

// ── B3: Token estimation — preFlight reuse ────────────────────────────────
//
// Before B3, estimateRequestTokens() was called twice per provider request:
// once for the session audit log and once inside estimateRequestTokensCalibrated
// for calibration. Now we compute once and derive the calibrated value.
//
// This benchmark compares the two approaches on realistic message arrays.

function makeMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 2 === 0) {
      msgs.push({
        role: 'user',
        content: `user message ${i}: `.repeat(30),
      });
    } else {
      msgs.push({
        role: 'assistant',
        content: [
          { type: 'text', text: `assistant response ${i}: `.repeat(100) },
          { type: 'tool_use', id: `tu-${i}`, name: 'read', input: { path: `src/file-${i}.ts` } },
        ],
      });
    }
  }
  return msgs;
}

const systemPrompt = [{ type: 'text' as const, text: 'You are a helpful assistant. '.repeat(50) }];
const tools = Array.from({ length: 40 }, (_, i) => ({
  name: `tool-${i}`,
  description: `Tool ${i} for benchmarking `.repeat(5),
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}));

describe('B3 — preFlight token estimate reuse', () => {
  const messageCounts = [10, 50, 200];

  for (const n of messageCounts) {
    const messages = makeMessages(n);

    bench(`${n} messages — double call (old)`, () => {
      // Old pattern: two separate calls
      const est1 = estimateRequestTokens(messages, systemPrompt, tools).total;
      const est2 = estimateRequestTokensCalibrated(
        messages,
        systemPrompt,
        tools,
        'bench/probe',
      ).total;
      return est1 + est2; // prevent dead-code elimination
    });

    bench(`${n} messages — preFlight reuse (new)`, () => {
      // New pattern: one call, derive calibrated
      const preFlight = estimateRequestTokens(messages, systemPrompt, tools);
      const cal = getCalibrationState('bench/probe');
      const calibratedTotal = cal.calibrated
        ? Math.round(preFlight.total * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : preFlight.total;
      return preFlight.total + calibratedTotal;
    });
  }
});

// ── B4: Tool adjacency repair — dirty flag skip ────────────────────────────
//
// Before B4, repairToolUseAdjacency() ran unconditionally before every provider
// request. Now it's guarded by a dirty flag and skipped on pure-text iterations.
//
// This benchmark measures the scan cost on increasing message counts, and
// compares it to the (near-zero) cost of a dirty flag check + skip.

function makeCleanMessages(count: number): Message[] {
  // Pure text — no tool_use/tool_result blocks, so adjacency is always clean.
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message ${i}: `.repeat(80),
    });
  }
  return msgs;
}

describe('B4 — repairToolUseAdjacency skip on clean messages', () => {
  const messageCounts = [20, 80, 300];

  for (const n of messageCounts) {
    const messages = makeCleanMessages(n);

    bench(`${n} clean messages — always scan (old)`, () => {
      const repaired = repairToolUseAdjacency(messages);
      return repaired.messages.length; // prevent dead-code elimination
    });

    bench(`${n} clean messages — dirty flag skip (new)`, () => {
      // Simulate the dirty-flag guard: skip the scan entirely
      const dirty = false;
      if (dirty) {
        const repaired = repairToolUseAdjacency(messages);
        return repaired.messages.length;
      }
      return messages.length;
    });
  }
});

// ── B5: emitContextPct elision on idle loops ───────────────────────────────
//
// In autonomous mode, the agent loops without adding messages — calling
// estimateRequestTokensCalibrated() every iteration is wasted work when the
// context hasn't changed. B5 tracks the last-emitted message + tool count
// and returns early when nothing changed.
//
// This benchmark simulates the cost of emitContextPct() at 200, 500, and
// 1000 messages, comparing the old (always compute) vs new (skip-on-same)
// paths.

const IDLE_TOOLS = Array.from({ length: 40 }, (_, i) => ({
  name: `t-${i}`,
  description: `Tool ${i}`.repeat(5),
  inputSchema: { type: 'object', properties: {} },
}));

function makeIdleMessages(count: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `msg ${i} `.repeat(60) });
  }
  return msgs;
}

describe('B5 — emitContextPct elision on idle autonomous loops', () => {
  const counts = [200, 500, 1000];

  for (const n of counts) {
    const messages = makeIdleMessages(n);

    bench(`${n} msgs — always compute (old)`, () => {
      // Old: unconditionally compute and emit
      const { total } = estimateRequestTokens(messages, systemPrompt, IDLE_TOOLS);
      return total; // prevent dead-code elimination
    });

    bench(`${n} msgs — skip on same count (new)`, () => {
      // New: check dirty-guard first. In an idle loop the count is unchanged,
      // so we return immediately. This bench simulates the HIT path (skip).
      const msgCount = messages.length;
      // Simulated cache — initialized before the idle loop
      const cached = n; // same as current
      if (msgCount === cached) {
        return 0; // early return — no compute, no emit
      }
      const { total } = estimateRequestTokens(messages, systemPrompt, IDLE_TOOLS);
      return total;
    });
  }
});
