import { createHash } from 'node:crypto';
import type { HistoryEntry } from '../src/history-entry.js';

export const HEAP_SOAK_SEED = 0x5eedc0de;

interface HeapSoakWorkloadOptions {
  entryCount: number;
  seed?: number | undefined;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function words(random: () => number, count: number): string {
  const vocabulary = [
    'renderer',
    'history',
    'viewport',
    'terminal',
    'snapshot',
    'retained',
    'layout',
    'stream',
    'tool',
    'cache',
    'memory',
    'commit',
    'fiber',
    'virtual',
    'wrapped',
    'output',
  ];
  const result: string[] = [];
  for (let index = 0; index < count; index++) {
    result.push(vocabulary[Math.floor(random() * vocabulary.length)]!);
  }
  return result.join(' ');
}

function turnEntries(turn: number, firstId: number, random: () => number): HistoryEntry[] {
  const sourcePath = `packages/tui/src/components/history/fixture-${turn % 17}.tsx`;
  const prose = words(random, 42 + (turn % 19));
  const codeLines = Array.from(
    { length: 6 + (turn % 9) },
    (_, index) => `const row${index} = ${JSON.stringify(words(random, 8 + (index % 5)))};`,
  ).join('\n');
  const diffLines = Array.from({ length: 10 + (turn % 13) }, (_, index) => {
    const marker = index % 3 === 0 ? '+' : index % 3 === 1 ? '-' : ' ';
    return `${marker}${String(index + 1).padStart(3, ' ')} ${words(random, 7 + (index % 4))}`;
  }).join('\n');

  return [
    { id: firstId, kind: 'user', text: `Inspect render cycle ${turn}: ${words(random, 16)}` },
    { id: firstId + 1, kind: 'thinking', text: `Checking ${sourcePath}. ${words(random, 24)}` },
    {
      id: firstId + 2,
      kind: 'assistant',
      text: `## Render cycle ${turn}\n\n${prose}\n\n\`\`\`ts\n${codeLines}\n\`\`\``,
    },
    {
      id: firstId + 3,
      kind: 'tool',
      name: 'read',
      durationMs: 9 + (turn % 80),
      ok: true,
      input: { path: sourcePath, offset: turn % 50, limit: 80 },
      output: codeLines,
      outputBytes: codeLines.length,
      outputLines: codeLines.split('\n').length,
      resultRenderMode: 'extend',
    },
    {
      id: firstId + 4,
      kind: 'tool',
      name: 'read',
      durationMs: 11 + (turn % 60),
      ok: true,
      input: { path: sourcePath, offset: 80 + (turn % 50), limit: 80 },
      output: `${codeLines}\n${words(random, 20)}`,
      outputBytes: codeLines.length + 160,
      outputLines: codeLines.split('\n').length + 1,
      resultRenderMode: 'extend',
    },
    {
      id: firstId + 5,
      kind: 'tool',
      name: 'grep',
      durationMs: 7 + (turn % 40),
      ok: turn % 11 !== 0,
      input: { pattern: 'render|history|viewport', path: 'packages/tui/src' },
      output: `${sourcePath}:${10 + turn}:${words(random, 28)}`,
      outputBytes: 240,
      outputLines: 3,
      resultRenderMode: 'extend',
    },
    {
      id: firstId + 6,
      kind: 'tool',
      name: 'edit',
      durationMs: 15 + (turn % 120),
      ok: true,
      input: { path: sourcePath, old_string: 'before', new_string: 'after' },
      output: diffLines,
      outputBytes: diffLines.length,
      outputLines: diffLines.split('\n').length,
      resultRenderMode: 'extend',
    },
    {
      id: firstId + 7,
      kind: 'assistant',
      text: `Cycle ${turn} completed. ${words(random, 38 + (turn % 12))}`,
    },
    {
      id: firstId + 8,
      kind: 'subagent',
      agentLabel: `AGENT#${(turn % 8) + 1}`,
      agentColor: turn % 2 === 0 ? 'cyan' : 'magenta',
      icon: '◆',
      text: `${3 + (turn % 14)} tools · ${20 + (turn % 70)}s`,
      detail: words(random, 18),
    },
    {
      id: firstId + 9,
      kind: turn % 9 === 0 ? 'warn' : 'info',
      text: `Lifecycle marker ${turn}: ${words(random, 22)}`,
    },
  ];
}

/** Build a stable, realistic mixture of prose, markdown, tool groups, and diffs. */
export function buildHeapSoakWorkload(options: HeapSoakWorkloadOptions): HistoryEntry[] {
  if (!Number.isSafeInteger(options.entryCount) || options.entryCount < 0) {
    throw new Error(`entryCount must be a non-negative safe integer, got ${options.entryCount}`);
  }
  const random = mulberry32(options.seed ?? HEAP_SOAK_SEED);
  const entries: HistoryEntry[] = [];
  let turn = 0;
  while (entries.length < options.entryCount) {
    const next = turnEntries(turn, entries.length + 1, random);
    entries.push(...next.slice(0, options.entryCount - entries.length));
    turn++;
  }
  return entries;
}

/** Content hash used to prove narrow and wide runs replayed the same workload. */
export function heapSoakWorkloadFingerprint(entries: readonly HistoryEntry[]): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export function workloadCharacterCount(entries: readonly HistoryEntry[]): number {
  let characters = 0;
  for (const entry of entries) {
    if ('text' in entry) characters += entry.text.length;
    if (entry.kind === 'tool') {
      characters += entry.output?.length ?? 0;
      characters += JSON.stringify(entry.input ?? null).length;
    }
  }
  return characters;
}
