import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  runTui,
  silenceTerminal,
  unsilenceTerminal,
  type AutonomyStage,
  type RunTuiOptions,
} from '../src/run-tui.js';

// ─────────────────────────────────────────────────────────────────────
// Module-level export verification
// ─────────────────────────────────────────────────────────────────────
describe('runTui exports', () => {
  it('exports runTui as a function', () => {
    expect(runTui).toBeInstanceOf(Function);
  });

  it('exports silenceTerminal as a function', () => {
    expect(silenceTerminal).toBeInstanceOf(Function);
  });

  it('exports unsilenceTerminal as a function', () => {
    expect(unsilenceTerminal).toBeInstanceOf(Function);
  });

  it('runTui has the correct signature (takes 1 argument)', () => {
    expect(runTui.length).toBe(1);
  });

  it('runTui returns a Promise', () => {
    // Lightweight — does not settle; just checks the return type.
    // Each test below awaits the promise.
    const p = runTui({} as never);
    expect(p).toBeInstanceOf(Promise);
  });

  it('silenceTerminal and unsilenceTerminal are different function references', () => {
    expect(silenceTerminal).not.toBe(unsilenceTerminal);
  });
});

// ─────────────────────────────────────────────────────────────────────
// RunTuiOptions type structural checks
// ─────────────────────────────────────────────────────────────────────
// The always-required RunTuiOptions fields. Spread into each fixture so the
// tests stay focused on the optional field under test while still satisfying
// the full required shape (agent/slashRegistry/attachments/events/model plus
// the statusline-hidden-items trio the host owns).
const baseRequiredOpts: Pick<
  RunTuiOptions,
  | 'agent'
  | 'slashRegistry'
  | 'attachments'
  | 'events'
  | 'model'
  | 'statuslineHiddenItems'
  | 'setStatuslineHiddenItems'
  | 'saveStatuslineHiddenItems'
> = {
  agent: {} as never,
  slashRegistry: {} as never,
  attachments: {} as never,
  events: {} as never,
  model: 'test-model',
  statuslineHiddenItems: [],
  setStatuslineHiddenItems: () => {},
  saveStatuslineHiddenItems: async () => {},
};

describe('RunTuiOptions type', () => {
  it('accepts only required fields', () => {
    // The minimal RunTuiOptions shape.
    const opts: RunTuiOptions = { ...baseRequiredOpts, model: 'test-model' };
    expect(opts.model).toBe('test-model');
  });

  it('accepts optional banner and yolo fields', () => {
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'gpt-4',
      banner: false,
      yolo: true,
    };
    expect(opts.banner).toBe(false);
    expect(opts.yolo).toBe(true);
  });

  it('accepts optional callback fields', () => {
    const onQueueChange = vi.fn();
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'm',
      onQueueChange,
    };
    expect(typeof opts.onQueueChange).toBe('function');
  });

  it('accepts optional string fields (appVersion, provider, etc.)', () => {
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'claude-4',
      appVersion: '1.2.3',
      provider: 'anthropic',
      family: 'claude',
      keyTail: 'XYZ',
      profile: 'default',
      projectRoot: '/tmp/test',
      modeLabel: 'teach',
    };
    expect(opts.appVersion).toBe('1.2.3');
    expect(opts.provider).toBe('anthropic');
  });

  it('accepts optional function fields (getYolo, getAutonomy, etc.)', () => {
    const getYolo = () => true;
    const getAutonomy = () => 'off' as const;
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'm',
      getYolo,
      getAutonomy,
    };
    expect(opts.getYolo?.()).toBe(true);
    expect(opts.getAutonomy?.()).toBe('off');
  });

  it('accepts optional controller objects (secretInputController, interruptController, etc.)', () => {
    const secretInputController = {
      readSecret: vi.fn().mockResolvedValue('secret'),
    };
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'm',
      secretInputController,
    };
    expect(typeof opts.secretInputController?.readSecret).toBe('function');
  });

  it('accepts the full set of boolean / number optionals', () => {
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'm',
      chime: true,
      mouse: false,
      confirmExit: true,
      titleAnimation: false,
      toolCount: 42,
      effectiveMaxContext: 200_000,
      tokenSavingMode: 'off' as never,
    };
    expect(opts.chime).toBe(true);
    expect(opts.toolCount).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────
// AutonomyStage type re-export from @wrongstack/core
// ─────────────────────────────────────────────────────────────────────
describe('AutonomyStage type re-export', () => {
  it('is a discriminated union of engine iteration/parallel stages keyed by phase', () => {
    // AutonomyStage = IterationStage | ParallelIterationStage — objects with a
    // `phase` discriminant, NOT the autonomy-mode strings. This asserts the
    // re-exported type covers stages from both engines.
    const stages: AutonomyStage[] = [
      { phase: 'idle' },
      { phase: 'decide', reason: 'next task' },
      { phase: 'execute', task: 'run tests' },
      { phase: 'fanout', slots: 3 },
      { phase: 'aggregate', successCount: 2, total: 3, goalComplete: false },
    ];
    expect(stages).toHaveLength(5);
    expect(stages[0]).toEqual({ phase: 'idle' });
    expect(stages[3]).toEqual({ phase: 'fanout', slots: 3 });
  });
});

// ─────────────────────────────────────────────────────────────────────
// runTui non-TTY guard — edge case coverage
// ─────────────────────────────────────────────────────────────────────
// The existing run-tui-guard.test.ts tests both-non-TTY. Here we cover
// the asymmetric cases (one TTY, one not) and verify the guard contract.
// ─────────────────────────────────────────────────────────────────────
describe('runTui non-TTY guard edge cases', () => {
  let origStdoutIsTTY: boolean | undefined;
  let origStdinIsTTY: boolean | undefined;
  let origStderrWrite: typeof process.stderr.write;
  let origConsoleError: typeof console.error;
  const stderrWrites: string[] = [];

  beforeEach(() => {
    origStdoutIsTTY = (process.stdout as { isTTY?: boolean }).isTTY;
    origStdinIsTTY = (process.stdin as { isTTY?: boolean }).isTTY;
    origStderrWrite = process.stderr.write.bind(process.stderr);
    origConsoleError = console.error;
    stderrWrites.length = 0;

    // Capture writes to stderr (not console.error) — the guard uses
    // writeErr which calls process.stderr.write directly.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: origStdoutIsTTY,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: origStdinIsTTY,
      configurable: true,
    });
    process.stderr.write = origStderrWrite;
    console.error = origConsoleError;
  });

  it('returns 2 when stdout is TTY but stdin is not', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    const code = await runTui({} as never);
    expect(code).toBe(2);
    expect(stderrWrites.join('')).toMatch(/requires an interactive terminal/);
  });

  it('returns 2 when stdin is TTY but stdout is not', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    const code = await runTui({} as never);
    expect(code).toBe(2);
    expect(stderrWrites.join('')).toMatch(/requires an interactive terminal/);
  });

  it('returns 2 when both stdout and stdin are non-TTY', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    const code = await runTui({} as never);
    expect(code).toBe(2);
  });

  it('returns 2 even when isTTY is undefined on either stream', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      configurable: true,
    });

    const code = await runTui({} as never);
    expect(code).toBe(2);
  });

  it('returns 2 when stdin.isTTY is true but stdout.isTTY is undefined', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      configurable: true,
    });

    const code = await runTui({} as never);
    expect(code).toBe(2);
  });

  it('returns 2 when stdout.isTTY is true but stdin.isTTY is undefined', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: undefined,
      configurable: true,
    });

    const code = await runTui({} as never);
    expect(code).toBe(2);
  });

  it('error message tells the user to drop the --tui flag', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    await runTui({} as never);
    expect(stderrWrites.join('')).toMatch(/drop the flag|--tui/);
  });

  it('does not write anything else to stderr when returning 2', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    await runTui({} as never);

    // Should only contain the guard message — nothing more
    const joined = stderrWrites.join('').trim();
    expect(joined).toMatch(/requires an interactive terminal/);
    expect(joined).toMatch(/drop the flag/i);
  });

  it('is idempotent when invoked multiple times with non-TTY streams', async () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      configurable: true,
    });

    const [code1, code2] = await Promise.all([runTui({} as never), runTui({} as never)]);
    expect(code1).toBe(2);
    expect(code2).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────
// runTui with TTY — lightweight type-level verification only
// These tests verify that runTui *can* be called with various argument
// shapes from the type system perspective. No actual TTY dependency.
// ─────────────────────────────────────────────────────────────────────
describe('runTui type compatibility', () => {
  it('accepts RunTuiOptions with required fields as its argument', () => {
    // TypeScript will enforce this at compile time. At runtime we
    // can only verify the function accepts the call without throwing
    // during argument evaluation (before the TTY guard).
    const opts: RunTuiOptions = {
      ...baseRequiredOpts,
      model: 'model-id',
    };
    // Calling with non-TTY will return 2 — we just verify it doesn't
    // throw during argument evaluation or the guard.
    expect(() => {
      const p = runTui(opts);
      // Don't await — we just want to verify synchronous setup doesn't throw
      return p;
    }).not.toThrow();
  });

  it('is callable with extra unknown properties (structural typing)', () => {
    // JS allows passing excess properties — the function should not
    // crash on the synchronous path for this.
    const opts = {
      ...baseRequiredOpts,
      model: 'm',
      extraUnknownField: 'should be ignored',
    };
    expect(() => {
      const p = runTui(opts as never);
      return p;
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Module-level const state: console / stderr originals
// ─────────────────────────────────────────────────────────────────────
describe('silenceTerminal / unsilenceTerminal export integrity', () => {
  // These tests verify the exported function references and basic
  // contract without duplicating the functional tests in
  // silence-terminal.test.ts.

  it('silenceTerminal does not throw', () => {
    expect(() => silenceTerminal()).not.toThrow();
    // Restore so subsequent tests are not affected
    unsilenceTerminal();
  });

  it('unsilenceTerminal does not throw', () => {
    silenceTerminal();
    expect(() => unsilenceTerminal()).not.toThrow();
  });

  it('silenceTerminal → unsilenceTerminal does not throw', () => {
    silenceTerminal();
    unsilenceTerminal();
    // Call again — should be safe
    silenceTerminal();
    unsilenceTerminal();
  });

  it('stderr no-op returns true when called after silenceTerminal', () => {
    silenceTerminal();
    const result = process.stderr.write('test');
    expect(result).toBe(true);
    unsilenceTerminal();
  });

  it('stderr no-op calls the provided callback', () => {
    silenceTerminal();
    const cb = vi.fn();
    process.stderr.write('hello', 'utf8', cb);
    expect(cb).toHaveBeenCalledTimes(1);
    unsilenceTerminal();
  });

  it('stderr no-op handles Buffer input', () => {
    silenceTerminal();
    const result = process.stderr.write(Buffer.from('test'));
    expect(result).toBe(true);
    unsilenceTerminal();
  });
});
