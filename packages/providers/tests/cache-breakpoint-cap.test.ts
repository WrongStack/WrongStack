import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_MAX_BREAKPOINTS,
  capAnthropicCacheBreakpoints,
  enforceAnthropicCacheTtlOrder,
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

    expect(previousTurn.cache_control).toEqual({ type: 'ephemeral' });
    expect(currentTurn.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' }); // static prefix anchor survives
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

  it('weighs blocks with string content property by content.length when ranking prefix gaps', () => {
    const contentBlock = (len: number) => ({
      type: 'tool_result',
      content: 'c'.repeat(len),
      cache_control: { type: 'ephemeral' },
    });
    // 5 markers, limit 3: keep index 0 (prefix=10) and index 4 (prefix=1020).
    // Midpoint is 515.
    // Index 1 sits after 10 chars (prefix=20, dist=10).
    // Index 2 sits after a 500-char content block (prefix=520, dist=495 -> best!).
    // Index 3 sits after another 490-char content block (prefix=1010, dist=10).
    // If `o['content']` string weight is disabled (0), all blocks weigh 0 and tie-break picks index 1 instead of index 2!
    const system = [
      contentBlock(10),
      contentBlock(10),
      contentBlock(500),
      contentBlock(490),
      contentBlock(10),
    ];
    capAnthropicCacheBreakpoints({ system }, 3);
    expect(system.map((b) => !!b.cache_control)).toEqual([true, false, true, false, true]);
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

    it('caps pinned markers at the hard wire limit', async () => {
      // 5 ttl-pinned markers, limit 4 → retain the deepest four.
      const system = [ttl(), ttl(), ttl(), ttl(), ttl()];
      const warnings = await captureWarnings(() => capAnthropicCacheBreakpoints({ system }));
      expect(warnings.some((w) => w.name === 'PinnedCacheBreakpointOverflow')).toBe(false);
      expect(markerCount(system)).toBe(ANTHROPIC_MAX_BREAKPOINTS);
      expect(system[0]?.cache_control).toBeUndefined();
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

describe('enforceAnthropicCacheTtlOrder', () => {
  it('promotes earlier plain and 5m markers to 1h when a later marker uses 1h', () => {
    const tools = [ephemeral('t1')];
    const system = [
      ephemeral('s1'),
      { type: 'text', text: 's2', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ];
    const msgBlock = ttl('m1');
    const messages = [{ role: 'user', content: [msgBlock] }];

    enforceAnthropicCacheTtlOrder({ tools, system, messages });

    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(msgBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  it('preserves valid 1h-before-5m ordering without upgrading trailing 5m markers', () => {
    const system = [ttl('s1')];
    const msgBlock = { type: 'text', text: 'm1', cache_control: { type: 'ephemeral', ttl: '5m' } };
    const messages = [{ role: 'user', content: [msgBlock] }];

    enforceAnthropicCacheTtlOrder({ system, messages });

    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(msgBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('leaves plain and 5m-only marker lists untouched', () => {
    const system = [ephemeral('s1')];
    const msgBlock = { type: 'text', text: 'm1', cache_control: { type: 'ephemeral', ttl: '5m' } };
    const messages = [{ role: 'user', content: [msgBlock] }];

    enforceAnthropicCacheTtlOrder({ system, messages });

    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(msgBlock.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });
});
