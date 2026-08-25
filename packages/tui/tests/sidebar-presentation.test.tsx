import type { ContextBreakdown } from '@wrongstack/core/utils';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { contextSpectrum, SidebarContent } from '../src/components/sidebar-content.js';
import { ConnectionsPanelSidebar } from '../src/components/sidebar-panels.js';
import { displayWidth } from '../src/terminal-width.js';

const BREAKDOWN: ContextBreakdown = {
  system: { total: 2_000, bySource: {} as ContextBreakdown['system']['bySource'] },
  tools: { total: 1_000, builtin: 1_000, mcp: 0, count: 10, mcpByServer: {} },
  history: { total: 5_000, text: 4_000, toolResults: 1_000, messageCount: 12 },
  volatile: { ledger: 0, nextsteps: 0, total: 0 },
  total: 8_000,
  effectiveMaxContext: 10_000,
  usedPct: 0.8,
  warnings: [],
};

describe('right sidebar presentation', () => {
  it('allocates the context spectrum across the exact content width', () => {
    const segments = contextSpectrum(BREAKDOWN, { used: 8_000, max: 10_000 }, 16);

    expect(segments.map((segment) => segment.shortLabel)).toEqual([
      'SYS',
      'TLS',
      'HST',
      'VOL',
      'FREE',
    ]);
    expect(segments.reduce((sum, segment) => sum + segment.cells, 0)).toBe(16);
    expect(segments.find((segment) => segment.shortLabel === 'FREE')?.tokens).toBe(2_000);
  });

  it('represents measurement lag as delta without shortening the spectrum', () => {
    const segments = contextSpectrum(BREAKDOWN, { used: 9_000, max: 10_000 }, 16);

    expect(segments.find((segment) => segment.shortLabel === 'DELTA')?.tokens).toBe(1_000);
    expect(segments.reduce((sum, segment) => sum + segment.cells, 0)).toBe(16);
  });

  it('elevates model identity and renders the measured context composition', () => {
    const { lastFrame } = render(
      <SidebarContent
        contextWindow={{ used: 8_000, max: 10_000 }}
        contextBreakdown={BREAKDOWN}
        entries={{}}
        fleetCounts={undefined}
        provider="anthropic"
        model="claude-sonnet"
        width={36}
      />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('MODEL CORE');
    expect(frame).toContain('anthropic/claude-sonnet');
    expect(frame).toContain('80%');
    expect(frame).toContain('[00000000o.]');
    expect(frame).toContain('SYS');
    expect(frame).toContain('TLS');
    expect(frame).toContain('HST');
    expect(frame).toContain('FREE');
  });

  it('keeps the model/context hero inside the 16-column content floor', () => {
    const { lastFrame } = render(
      <SidebarContent
        contextWindow={{ used: 12_000, max: 10_000 }}
        contextBreakdown={BREAKDOWN}
        entries={{}}
        fleetCounts={undefined}
        provider="provider-with-a-wide-name"
        model="model-with-a-wide-unicode-name-界"
        width={20}
      />,
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('MODEL CORE');
    // On a 16-col body there's no room for a 10-char bar (12 with
    // brackets) + any label, so both the bar and the label drop. Only
    // the percentage survives on its own line.
    expect(frame).toContain('100%');
    expect(frame).not.toContain('CTX LOAD');
    for (const line of frame.split('\n')) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(16);
    }
  });

  it('renders connections as a signal matrix without exceeding 16 content columns', () => {
    const { lastFrame } = render(
      <ConnectionsPanelSidebar
        connections={[
          { name: 'Codebase Index', status: 'ok', latencyMs: 12 },
          { name: 'Mailbox IPC', status: 'warn', latencyMs: 91 },
          { name: 'Kanban IPC', status: 'down' },
        ]}
        width={16}
      />,
    );
    const frame = lastFrame() ?? '';
    // Collapse whitespace so the assertion is robust against soft-wrap
    // (e.g. on the narrowest rails, "SIGNAL MATRIX" might span two lines
    // while still being a contiguous "SIGNAL MATRIX" in the joined frame).
    const flat = frame.replace(/\s+/g, ' ');

    expect(frame).toContain('CONNECTIONS');
    expect(flat).toContain('SIGNAL MATRIX');
    expect(frame).toContain('link 01');
    expect(frame).toContain('link 03');
    for (const line of frame.split('\n')) {
      expect(displayWidth(line), line).toBeLessThanOrEqual(16);
    }
  });
});
