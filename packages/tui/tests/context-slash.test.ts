import { describe, expect, it, vi } from 'vitest';
import {
  contextBar,
  createContextSlashCommand,
  formatContextPanelSummary,
} from '../src/context-slash.js';

describe('/context TUI command', () => {
  it('opens the interactive panel for bare /context and emits nothing to chat history', async () => {
    const open = vi.fn(() => true);
    const command = createContextSlashCommand({ onPanelOpen: { current: open } });

    const result = await command.run('');

    expect(open).toHaveBeenCalledWith('toggleContextPanel');
    // Panel-only: an empty message is dropped by the app's slash handler
    // (`if (res?.message)`), so no summary row appears in chat history.
    expect((result as { message: string }).message).toBe('');
  });

  it.each(['window', '--window'])('keeps /context %s as a panel alias', async (arg) => {
    const open = vi.fn(() => true);
    const command = createContextSlashCommand({ onPanelOpen: { current: open } });

    const result = await command.run(arg);

    expect(open).toHaveBeenCalledWith('toggleContextPanel');
    expect((result as { message: string }).message).toBe('');
  });

  it('never falls back to the removed Markdown dashboard', async () => {
    const command = createContextSlashCommand({});

    const result = await command.run('');

    expect((result as { message: string }).message).toContain('panel is unavailable');
    expect((result as { message: string }).message).not.toContain('Context Dashboard');
  });

  it('falls back to a usage line for sub-commands when no delegate is wired', async () => {
    const command = createContextSlashCommand({});
    const msg = ((await command.run('detail')) as { message: string }).message;
    expect(msg).toContain('Usage: /context');
    expect(msg).toContain('detail');
    expect(msg).not.toContain('Context Dashboard');
  });

  it('delegates sub-commands to the fallback text command verbatim', async () => {
    const open = vi.fn(() => true);
    const fallbackRun = vi.fn(async () => ({ message: 'window: 200,000 ctx' }));
    const fallback = {
      name: 'context',
      description: 'text',
      run: fallbackRun,
    };
    const command = createContextSlashCommand({ onPanelOpen: { current: open }, fallback });

    const result = await command.run('detail', undefined);

    // Sub-command must NOT open the panel and must hand off to the delegate.
    expect(open).not.toHaveBeenCalled();
    expect(fallbackRun).toHaveBeenCalledWith('detail', undefined);
    expect((result as { message: string }).message).toBe('window: 200,000 ctx');
  });

  it('opens the panel for bare /context even when a fallback is present', async () => {
    const open = vi.fn(() => true);
    const fallbackRun = vi.fn(async () => ({ message: 'text summary' }));
    const command = createContextSlashCommand({
      onPanelOpen: { current: open },
      fallback: { name: 'context', description: 'text', run: fallbackRun },
    });

    const result = await command.run('');

    expect(open).toHaveBeenCalledWith('toggleContextPanel');
    expect(fallbackRun).not.toHaveBeenCalled();
    expect((result as { message: string }).message).toBe('');
  });

  it('uses the fallback text summary when no panel bridge is available', async () => {
    const fallbackRun = vi.fn(async () => ({ message: 'text summary' }));
    const command = createContextSlashCommand({
      fallback: { name: 'context', description: 'text', run: fallbackRun },
    });

    const result = await command.run('');

    // No onPanelOpen → panel can't open → fall back to text (plain REPL path).
    expect(fallbackRun).toHaveBeenCalledWith('', undefined);
    expect((result as { message: string }).message).toBe('text summary');
  });
});

describe('contextBar', () => {
  it('renders empty and partial pressure bars', () => {
    expect(contextBar(0, 10)).toContain('0%');
    expect(contextBar(0.5, 10)).toContain('50%');
    expect(contextBar(0.5, 10)).toContain('█████');
  });

  it('keeps the glyph track exactly `width` cells for tiny and overflowing ratios', () => {
    const inner = (s: string) => (s.match(/[█░]+/) ?? [''])[0]!.length;
    expect(inner(contextBar(0.01, 10))).toBe(10);
    expect(inner(contextBar(1.5, 10))).toBe(10);
    expect(inner(contextBar(0, 10))).toBe(10);
  });
});

describe('formatContextPanelSummary', () => {
  it('keeps the history entry compact while preserving useful counts', () => {
    expect(
      formatContextPanelSummary({
        contextPct: 0.28,
        contextTokens: 280_000,
        contextMaxTokens: 1_000_000,
        memoryTotal: 6262,
        memoryCtx: 2,
        memoryPending: 1,
        memoryLeft: 3,
      }),
    ).toBe(
      'Context panel opened · 28% · 280k/1m\nMemory · 6262 total · 2 ctx · 1 pending · 3 left',
    );
  });
});
