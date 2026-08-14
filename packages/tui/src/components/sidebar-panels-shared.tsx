import type React from 'react';
import type { FleetEntry } from '../app-state.js';
import { Box, Text } from '../ink.js';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';

export function fleetStatusVisual(status: FleetEntry['status']): { glyph: string; color: string } {
  switch (status) {
    case 'running':
      return { glyph: glyphs.running, color: theme.success };
    case 'idle':
      return { glyph: glyphs.idle, color: theme.textMuted };
    case 'success':
      return { glyph: glyphs.success, color: theme.success };
    case 'failed':
    case 'timeout':
    case 'stopped':
      return { glyph: glyphs.failure, color: theme.error };
    default:
      return { glyph: '?', color: theme.textMuted };
  }
}

export function liveSessionGlyph(status: string): string {
  switch (status) {
    case 'active':
      return '●';
    case 'idle':
      return '◉';
    case 'closing':
      return '◐';
    case 'stale':
      return '○';
    default:
      return '?';
  }
}

export function liveSessionColor(status: string): string {
  if (status === 'active' || status === 'running') return theme.success;
  if (status === 'idle') return theme.accent;
  if (status === 'error' || status === 'stale') return theme.error;
  if (status === 'closing') return theme.warn;
  return theme.textMuted;
}

export function fmtRelative(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const diff = now - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function fmtShortDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

export function SidebarWorklistRow({
  icon,
  iconColor,
  label,
  labelColor,
  innerWidth,
  dim = false,
  strikethrough = false,
}: {
  icon: string;
  iconColor: string;
  label: string;
  labelColor: string;
  innerWidth: number;
  dim?: boolean | undefined;
  strikethrough?: boolean | undefined;
}): React.ReactElement {
  return (
    <Box width={innerWidth}>
      <Text>
        <Text color={iconColor}>{icon}</Text>
        <Text color={labelColor} dimColor={dim} strikethrough={strikethrough}>
          {' '}
          {label}
        </Text>
      </Text>
    </Box>
  );
}
