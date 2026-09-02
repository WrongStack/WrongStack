import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  capAnthropicCacheBreakpoints,
} from '../src/cache-breakpoint-cap.js';

type Block = { type: string; text: string; cache_control?: { type: string; ttl?: string } };

const ephemeral = (text = 'x'.repeat(100)): Block => ({
  type: 'text',
  text,
  cache_control: { type: 'ephemeral' },
});
const plain = (text = 'y'): Block => ({ type: 'text', text });
const ttl = (text = 'pinned'): Block => ({
  type: 'text',
  text,
  cache_control: { type: 'ephemeral', ttl: '1h' },
});

const markerCount = (blocks: Block[]): number => blocks.filter((b) => b.cache_control).length;

describe('capAnthropicCacheBreakpoints', () => {
  it('exports the Anthropic ceiling of 4', () => {
    expect(ANTHROPIC_MAX_BREAKPOINTS).toBe(4);
  });

  it('leaves a request with ≤4 markers untouched', () => {
    const system = [ephemeral(), ephemeral(), plain(), ephemeral(), ephemeral()]; // 4 markers
    capAnthropicCacheBreakpoints({ system });
    expect(markerCount(system)).toBe(4);
  });

  it('caps to exactly 4 when over budget, keeping the first and last markers', () => {
    const system = Array.from({ length: 7 }, () => ephemeral());
    capAnthropicCacheBreakpoints({ system });
    const kept = system.map((b) => !!b.cache_control);
    expect(kept.filter(Boolean).length).toBe(ANTHROPIC_MAX_BREAKPOINTS);
    expect(kept[0]).toBe(true); // static prefix anchor
    expect(kept[kept.length - 1]).toBe(true); // largest incremental prefix
  });

  it('always retains the ttl-pinned marker even amid many competitors', () => {
    // ttl marker sits in the middle, surrounded by 6 plain ephemeral markers.
    const system = [
      ephemeral(),
      ephemeral(),
      ttl(),
      ephemeral(),
      ephemeral(),
      ephemeral(),
      ephemeral(),
    ];
    capAnthropicCacheBreakpoints({ system });
    expect(system[2]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(markerCount(system)).toBe(ANTHROPIC_MAX_BREAKPOINTS);
  });

  it('counts markers globally across system + message content', () => {
    const system = [ephemeral(), ephemeral(), ephemeral()];
    const messages = [{ role: 'user', content: [plain(), ephemeral(), ephemeral()] }]; // +2 markers
    capAnthropicCacheBreakpoints({ system, messages });
    const total = markerCount(system) + markerCount(messages[0]!.content as Block[]);
    expect(total).toBe(ANTHROPIC_MAX_BREAKPOINTS); // 5 → 4 globally
  });

  it('counts tool-array markers toward the budget too', () => {
    const tools = [ephemeral(), ephemeral()]; // hypothetical tool-level markers
    const system = [ephemeral(), ephemeral(), ephemeral()];
    capAnthropicCacheBreakpoints({ tools, system });
    expect(markerCount(tools) + markerCount(system)).toBe(ANTHROPIC_MAX_BREAKPOINTS);
  });

  it('keeps both conversation breakpoints, sacrificing a middle system marker', () => {
    // 6 system markers + the previous-turn and current-turn message markers.
    const system = Array.from({ length: 6 }, (_, i) => ephemeral('s'.repeat((i + 1) * 40)));
    const previousTurn = ephemeral('previous turn tail');
    const currentTurn = ephemeral('current turn tail');
    const messages = [
      { role: 'user', content: [plain(), previousTurn] },
      { role: 'assistant', content: [plain()] },
      { role: 'user', content: [plain(), currentTurn] },
    ];

    capAnthropicCacheBreakpoints({ system, messages });

    expect(previousTurn.cache_control).toBeDefined();
    expect(currentTurn.cache_control).toBeDefined();
    expect(system[0]?.cache_control).toBeDefined(); // static prefix anchor survives
    expect(markerCount(system) + 2).toBe(ANTHROPIC_MAX_BREAKPOINTS);
  });

  it('is deterministic for the same input', () => {
    const mk = () => ({
      system: Array.from({ length: 7 }, (_, i) => ephemeral('z'.repeat((i + 1) * 10))),
    });
    const a = mk();
    capAnthropicCacheBreakpoints(a);
    const b = mk();
    capAnthropicCacheBreakpoints(b);
    expect(a.system.map((x) => !!x.cache_control)).toEqual(b.system.map((x) => !!x.cache_control));
  });

  describe('pinned marker overflow (B6)', () => {
    async function captureWarnings<T>(fn: () => T): Promise<{ message: string; name: string }[]> {
      const seen: { message: string; name: string }[] = [];
      const handler = (warning: Error): void => {
        seen.push({ message: warning.message, name: warning.name });
      };
      process.on('warning', handler);
      try {
        fn();
        // process.emitWarning fires on the next tick — await it.
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off('warning', handler);
      }
      return seen;
    }

    it('warns when pinned markers alone exceed the limit', async () => {
      // 5 ttl-pinned markers, limit 4 → overflow.
      const system = [ttl(), ttl(), ttl(), ttl(), ttl()];
      const warnings = await captureWarnings(() => capAnthropicCacheBreakpoints({ system }));
      expect(warnings.some((w) => w.message.includes('5 pinned (ttl) cache_control markers'))).toBe(
        true,
      );
      expect(warnings.some((w) => w.name === 'PinnedCacheBreakpointOverflow')).toBe(true);
      // All pinned markers are still retained (the cap can't drop them).
      expect(markerCount(system)).toBe(5);
    });

    it('does not warn when pinned markers fit within the limit', async () => {
      const system = [ttl(), ttl(), ttl(), ephemeral(), ephemeral()]; // 3 pinned, 2 plain
      const warnings = await captureWarnings(() => capAnthropicCacheBreakpoints({ system }));
      expect(warnings.some((w) => w.name === 'PinnedCacheBreakpointOverflow')).toBe(false);
      // 5 markers → capped to 4, pinned 3 retained + first/last/gap-fill.
      expect(markerCount(system)).toBe(ANTHROPIC_MAX_BREAKPOINTS);
    });

    it('deduplicates the warning across calls within the same process', async () => {
      // First call triggers the warning (await so the dedup flag is set).
      await captureWarnings(() =>
        capAnthropicCacheBreakpoints({ system: [ttl(), ttl(), ttl(), ttl(), ttl()] }),
      );
      // Second call should not warn again.
      const warnings = await captureWarnings(() =>
        capAnthropicCacheBreakpoints({ system: [ttl(), ttl(), ttl(), ttl(), ttl(), ttl()] }),
      );
      expect(warnings.some((w) => w.name === 'PinnedCacheBreakpointOverflow')).toBe(false);
    });
  });
});
