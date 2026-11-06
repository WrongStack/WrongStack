import { setI18n } from 'react-i18next';
import { afterEach, describe, expect, it } from 'vitest';
import { agentModelLabel } from '../../src/components/OfficeMapCanvas/model-label.js';
import {
  agentFanPos,
  clientNodeType,
  compactFlowLabel,
  fmtAgo,
  fmtCompact,
  fmtUptime,
  layoutClientClusters,
  layoutClientXs,
  mapAgentStatus,
  shortModel,
  surfaceLabel,
} from '../../src/components/OfficeMapCanvas/utils.js';

describe('compactFlowLabel', () => {
  it('normalizes whitespace and preserves short labels', () => {
    expect(compactFlowLabel('  Inspect\n  the compactor  ')).toBe('Inspect the compactor');
  });

  it('caps long prompt text without splitting topology width', () => {
    const result = compactFlowLabel('Investigate the oversized tool result elision path', 24);
    expect(result).toBe('Investigate the oversiz…');
    expect(result).toHaveLength(24);
  });

  it('drops empty values', () => {
    expect(compactFlowLabel(undefined)).toBeUndefined();
    expect(compactFlowLabel('   ')).toBeUndefined();
  });
});

describe('OfficeMapCanvas utils', () => {
  it('formats provider and model without repeating a provider prefix', () => {
    expect(agentModelLabel('openai', 'gpt-6')).toBe('openai/gpt-6');
    expect(agentModelLabel('openai', 'openai/gpt-6')).toBe('openai/gpt-6');
    expect(agentModelLabel(undefined, 'claude-sonnet')).toBe('claude-sonnet');
    expect(agentModelLabel(undefined, undefined)).toBeUndefined();
  });
  describe('fmtCompact', () => {
    it('formats small numbers as-is', () => {
      expect(fmtCompact(0)).toBe('0');
      expect(fmtCompact(42)).toBe('42');
      expect(fmtCompact(999)).toBe('999');
    });

    it('formats thousands with k suffix', () => {
      expect(fmtCompact(1000)).toBe('1.0k');
      expect(fmtCompact(1500)).toBe('1.5k');
      expect(fmtCompact(12345)).toBe('12.3k');
    });

    it('formats millions with M suffix', () => {
      expect(fmtCompact(1_000_000)).toBe('1.0M');
      expect(fmtCompact(1_500_000)).toBe('1.5M');
    });

    it('handles undefined and non-finite', () => {
      expect(fmtCompact(undefined)).toBe('0');
      expect(fmtCompact(Number.NaN)).toBe('0');
      expect(fmtCompact(Number.POSITIVE_INFINITY)).toBe('0');
    });
  });

  describe('fmtAgo', () => {
    const now = Date.parse('2026-06-21T10:00:00Z');

    it('returns "never" for undefined or unparseable', () => {
      expect(fmtAgo(undefined, now)).toBe('never');
      expect(fmtAgo('not-a-date', now)).toBe('never');
    });

    it('formats seconds', () => {
      expect(fmtAgo('2026-06-21T09:59:30Z', now)).toBe('30s ago');
    });

    it('formats minutes', () => {
      expect(fmtAgo('2026-06-21T09:57:00Z', now)).toBe('3m ago');
    });

    it('formats hours', () => {
      expect(fmtAgo('2026-06-21T07:00:00Z', now)).toBe('3h ago');
    });

    it('formats days', () => {
      expect(fmtAgo('2026-06-19T10:00:00Z', now)).toBe('2d ago');
    });
  });

  describe('fmtUptime', () => {
    const now = Date.parse('2026-06-21T10:00:00Z');

    it('returns empty for undefined', () => {
      expect(fmtUptime(undefined, now)).toBe('');
    });

    it('formats seconds', () => {
      expect(fmtUptime('2026-06-21T09:59:30Z', now)).toBe('30s');
    });

    it('formats minutes', () => {
      expect(fmtUptime('2026-06-21T09:57:00Z', now)).toBe('3m');
    });

    it('formats hours', () => {
      expect(fmtUptime('2026-06-21T07:00:00Z', now)).toBe('3h');
    });
  });

  describe('in a registered display language', () => {
    const now = Date.parse('2026-06-21T10:00:00Z');
    afterEach(() => setI18n(undefined as never));

    it('writes relative times and durations in that language', () => {
      setI18n({ language: 'tr' } as never);
      expect(fmtAgo('2026-06-21T09:57:00Z', now)).toBe(
        new Intl.RelativeTimeFormat('tr', { style: 'short' }).format(-3, 'minute'),
      );
      expect(fmtUptime('2026-06-21T07:00:00Z', now)).toBe(
        new Intl.NumberFormat('tr', { style: 'unit', unit: 'hour', unitDisplay: 'short' }).format(
          3,
        ),
      );
      expect(fmtAgo(undefined, now, 'hiç')).toBe('hiç');
    });
  });

  describe('shortModel', () => {
    it('returns undefined for empty input', () => {
      expect(shortModel(undefined)).toBeUndefined();
      expect(shortModel('')).toBeUndefined();
    });

    it('extracts the last path segment', () => {
      expect(shortModel('anthropic/claude-opus-4')).toBe('claude-opus-4');
    });

    it('truncates long names', () => {
      const result = shortModel('provider/very-long-model-name-that-exceeds-limit');
      expect(result).toHaveLength(18);
    });
  });

  describe('layoutClientXs', () => {
    it('places a single client at CENTER_X', () => {
      const map = layoutClientXs(['a']);
      expect(map.get('a')).toBe(600);
    });

    it('spreads multiple clients symmetrically', () => {
      const map = layoutClientXs(['a', 'b', 'c']);
      expect(map.get('a')).toBeLessThan(map.get('b')!);
      expect(map.get('b')).toBeLessThan(map.get('c')!);
      // Center client should be at CENTER_X
      expect(map.get('b')).toBe(600);
    });

    it('respects custom column width', () => {
      const map = layoutClientXs(['a', 'b'], 200);
      expect(map.get('b')! - map.get('a')!).toBe(200);
    });
  });

  describe('layoutClientClusters', () => {
    it('keeps a small fleet on one row when that best fits a wide canvas', () => {
      const layout = layoutClientClusters(
        [
          { id: 'a', agentCount: 1 },
          { id: 'b', agentCount: 1 },
          { id: 'c', agentCount: 1 },
        ],
        { width: 1440, height: 800 },
      );

      expect(layout.columns).toBe(3);
      expect(layout.rows).toBe(1);
      expect(layout.positions.get('a')?.y).toBe(layout.positions.get('c')?.y);
    });

    it('wraps a growing fleet across rows instead of making a horizontal strip', () => {
      const clients = Array.from({ length: 10 }, (_, index) => ({
        id: `client-${index}`,
        agentCount: 3,
      }));
      const layout = layoutClientClusters(clients, { width: 1280, height: 720 });

      expect(layout.columns).toBeGreaterThan(1);
      expect(layout.columns).toBeLessThan(clients.length);
      expect(layout.rows).toBeGreaterThan(1);
      expect(layout.positions.get('client-0')?.y).toBeLessThan(
        layout.positions.get(`client-${layout.columns}`)?.y ?? 0,
      );
    });

    it('uses additional vertical space on a portrait canvas', () => {
      const clients = Array.from({ length: 6 }, (_, index) => ({
        id: `client-${index}`,
        agentCount: 1,
      }));
      const wide = layoutClientClusters(clients, { width: 1400, height: 700 });
      const portrait = layoutClientClusters(clients, { width: 600, height: 1000 });

      expect(portrait.columns).toBeLessThan(wide.columns);
      expect(portrait.rows).toBeGreaterThan(wide.rows);
    });

    it('reserves taller rows for clients with multi-row agent fans', () => {
      const layout = layoutClientClusters(
        [
          { id: 'busy', agentCount: 7 },
          { id: 'peer', agentCount: 1 },
          { id: 'next', agentCount: 1 },
          { id: 'last', agentCount: 1 },
        ],
        { width: 1000, height: 900 },
      );

      const ids = ['busy', 'peer', 'next', 'last'];
      const firstRowY = layout.positions.get(ids[0]!)?.y ?? 0;
      const secondRowY = layout.positions.get(ids[layout.columns]!)?.y ?? firstRowY;

      expect(layout.rows).toBeGreaterThan(1);
      expect(secondRowY - firstRowY).toBeGreaterThan(700);
    });
  });

  describe('agentFanPos', () => {
    it('positions agents in a centered grid', () => {
      const pos0 = agentFanPos(600, 0, 3);
      const pos1 = agentFanPos(600, 1, 3);
      const pos2 = agentFanPos(600, 2, 3);
      expect(pos1.x).toBe(600); // middle agent centered
      expect(pos0.x).toBeLessThan(pos1.x);
      expect(pos2.x).toBeGreaterThan(pos1.x);
      expect(pos0.y).toBe(pos1.y);
      expect(pos1.y).toBe(pos2.y);
    });

    it('wraps to a new row when exceeding AGENT_COLS', () => {
      const pos2 = agentFanPos(600, 2, 6);
      const pos3 = agentFanPos(600, 3, 6);
      expect(pos3.y).toBeGreaterThan(pos2.y);
    });
  });

  describe('clientNodeType', () => {
    it('maps tui', () => {
      expect(clientNodeType('tui')).toBe('tui');
    });

    it('maps repl', () => {
      expect(clientNodeType('repl')).toBe('repl');
    });

    it('maps cli to repl', () => {
      expect(clientNodeType('cli')).toBe('repl');
    });

    it('defaults to webui', () => {
      expect(clientNodeType(undefined)).toBe('webui');
      expect(clientNodeType('webui')).toBe('webui');
    });
  });

  describe('surfaceLabel', () => {
    it('returns TUI label', () => {
      expect(surfaceLabel('tui')).toBe('TUI');
    });

    it('returns REPL label', () => {
      expect(surfaceLabel('repl')).toBe('REPL');
    });

    it('returns WebUI label', () => {
      expect(surfaceLabel('webui')).toBe('WebUI');
    });
  });

  describe('mapAgentStatus', () => {
    it('maps running to active', () => {
      expect(mapAgentStatus('running')).toBe('active');
    });

    it('maps idle', () => {
      expect(mapAgentStatus('idle')).toBe('idle');
    });

    it('maps completed', () => {
      expect(mapAgentStatus('completed')).toBe('completed');
    });

    it('maps failed to error', () => {
      expect(mapAgentStatus('failed')).toBe('error');
    });

    it('maps stopped to offline', () => {
      expect(mapAgentStatus('stopped')).toBe('offline');
    });

    it('defaults to idle for unknown', () => {
      expect(mapAgentStatus(undefined)).toBe('idle');
      expect(mapAgentStatus('unknown')).toBe('idle');
    });
  });
});
