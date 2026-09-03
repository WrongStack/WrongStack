import type React from 'react';
import { isValidElement } from 'react';
import { pastel, theme } from '../theme.js';
import { normalizeTuiThinkingWord } from '../thinking-word.js';

/**
 * Head-truncate a chip's free-text payload (branch, path, project name) with a
 * trailing ellipsis so one long value can't blow out the line width.
 */
export function truncateChip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Recover the visible plain text of a rendered chip by walking its React
 * element tree (string/number leaves only).
 */
export function nodeText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

/**
 * Keep only the last `segments` path components, prefixed with `…/` when
 * anything was elided. Used by the working-dir chip's narrower density
 * levels: `D:\Codebox\PROJECTS\WrongStack` → `…/PROJECTS/WrongStack` →
 * `…/WrongStack`. Separators are normalized to `/` so the result has a
 * predictable width on Windows too.
 */
export function shortenPath(path: string, segments: number): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments) return parts.join('/') || path;
  return `…/${parts.slice(-Math.max(1, segments)).join('/')}`;
}

export interface TokenDisplayTotals {
  input: number;
  output: number;
}

export function tokenDisplayTotals(
  usage:
    | {
        input: number;
        output: number;
        cacheRead?: number | undefined;
        cacheWrite?: number | undefined;
      }
    | undefined,
  currentRequest: { input: number; cacheRead: number; cacheWrite?: number | undefined } | undefined,
  estimatedInput?: number | undefined,
): TokenDisplayTotals {
  const usageInput = usage ? usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) : 0;
  const usageOutput = usage?.output ?? 0;
  const fallbackInput = currentRequest
    ? currentRequest.input + currentRequest.cacheRead + (currentRequest.cacheWrite ?? 0)
    : 0;
  const input =
    usageInput > 0
      ? usageInput
      : fallbackInput > 0
        ? fallbackInput
        : Math.max(0, estimatedInput ?? 0);
  return {
    input,
    output: usageOutput,
  };
}

export function hasTokenDisplay(tokens: TokenDisplayTotals): boolean {
  return tokens.input > 0 || tokens.output > 0;
}

// Chip click geometry is no longer dead-reckoned here — StatusBar publishes
// a StatusBarClickMap computed by `computeRailSpans` (powerline-rail.tsx)
// from the same segment nodes the rails render.

export function stateChip(
  state: 'idle' | 'running' | 'streaming' | 'aborting',
  fleetRunning: number,
  thinkingWord?: string | undefined,
): { label: string; color: string } {
  if (state === 'idle' && fleetRunning > 0) {
    return { label: `agents ▶${fleetRunning}`, color: theme.monitor.agents };
  }
  if (state === 'idle') return { label: 'idle', color: theme.accent };
  if (state === 'aborting') return { label: 'aborting…', color: theme.warn };
  return { label: `${normalizeTuiThinkingWord(thinkingWord)}…`, color: theme.success };
}

const FILLED = '█';
const EMPTY = '░';

export function renderProgress(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

export function contextBarColor(ratio: number): string {
  if (ratio < 0.25) return theme.accent;
  if (ratio < 0.5) return theme.success;
  if (ratio < 0.65) return pastel.peach;
  if (ratio < 0.8) return theme.warn;
  return theme.error;
}

export function renderMeter(ratio: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  const filled = Math.round(clamped * width);
  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      bar += '0';
    } else if (i === filled && filled < width) {
      bar += 'o';
    } else {
      bar += '.';
    }
  }
  return '[' + bar + ']';
}

/**
 * Block-style meter for the sidebar — a solid fill (`█`) plus an empty track
 * (`░`). Returned as two segments so the caller can color the fill (e.g. by
 * context pressure via {@link contextBarColor}) independently of the dim track.
 * Width-safe: `filled.length + empty.length === max(1, width)` always holds.
 */
export function blockMeter(ratio: number, width: number): { filled: string; empty: string } {
  const clamped = Math.max(0, Math.min(1, ratio));
  const w = Math.max(1, width);
  const filledCount = Math.round(clamped * w);
  return {
    filled: '█'.repeat(filledCount),
    empty: '░'.repeat(Math.max(0, w - filledCount)),
  };
}

/** Eight block-element levels (U+2581…U+2588) used by {@link sparkline}. */
const SPARK_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render a 0..1 ratio history as a compact sparkline (oldest → newest, the
 * latest sample is the last character). Each value maps onto one of the eight
 * block levels, so a flat history renders as a flat line and spikes pop as
 * peaks. Only the trailing `width` samples are drawn; a width of 0 (or an
 * empty history) renders nothing.
 */
export function sparkline(values: readonly number[], width: number): string {
  if (width <= 0 || values.length === 0) return '';
  let out = '';
  for (const value of values.slice(-width)) {
    const clamped = Math.max(0, Math.min(1, value));
    const index = Math.round(clamped * (SPARK_LEVELS.length - 1));
    out += SPARK_LEVELS[index] ?? '▁';
  }
  return out;
}

/**
 * A morphing dial glyph that fills like a loading ring as the ratio rises:
 * `○` (idle) → `◔` → `◑` → `◕` → `●` (saturated). Non-bar replacement for
 * block meters in the sidebar SYSTEM card. Same glyph family as the
 * session-status dots (● ◉ ◐ ○) already used elsewhere in the TUI.
 */
export function dialGlyph(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, ratio));
  if (clamped >= 0.75) return '●';
  if (clamped >= 0.5) return '◕';
  if (clamped >= 0.25) return '◑';
  if (clamped > 0) return '◔';
  return '○';
}

export function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtMemory(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1).replace(/\.0$/, '')}G`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}M`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${Math.round(bytes)}B`;
}

export function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${pad2(m)}:${pad2(s)}`;
  }
  return `${pad2(m)}:${pad2(s)}`;
}

export function fmtDebugBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1_048_576).toFixed(1)}MB`;
}

export function fmtPct(pct: number, maxDecimals = 2): string {
  if (!Number.isFinite(pct)) return '0%';
  const clamped = Math.max(0, Math.min(100, pct));
  const factor = 10 ** maxDecimals;
  const rounded = Math.round(clamped * factor) / factor;
  return `${rounded}%`;
}

export function fmtRatioPct(ratio: number, maxDecimals = 2): string {
  if (!Number.isFinite(ratio)) return '0%';
  return fmtPct(ratio * 100, maxDecimals);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
