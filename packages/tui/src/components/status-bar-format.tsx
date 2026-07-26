import type React from 'react';
import { isValidElement } from 'react';
import { displayWidth } from '../terminal-width.js';
import { pastel, theme } from '../theme.js';
import { normalizeTuiThinkingWord } from '../thinking-word.js';
import { glyphs } from '../ui-glyphs.js';

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

const SB_SEP_COST = 5;

export function planChipFit(widths: number[], budget: number, sepCost = SB_SEP_COST): number {
  let used = 0;
  let keep = 0;
  for (const w of widths) {
    const cost = w + (keep > 0 ? sepCost : 0);
    if (keep > 0 && used + cost > budget) break;
    used += cost;
    keep += 1;
  }
  return keep;
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

const RAIL_CAP = 1;
const RAIL_PAD = 2;

export function statusBarModelSpan(opts: {
  model: string;
  provider?: string | undefined;
  yolo?: boolean | undefined;
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
  projectName?: string | undefined;
  workingDir?: string | undefined;
  projectHidden?: boolean | undefined;
  workingDirHidden?: boolean | undefined;
  monochrome?: boolean | undefined;
}): { start: number; len: number } {
  const leading: string[] = [];
  if (opts.yolo) leading.push(opts.monochrome ? 'YOLO' : `${glyphs.warning} YOLO`);
  if (opts.autonomy && opts.autonomy !== 'off') {
    leading.push(
      opts.monochrome ? opts.autonomy.toUpperCase() : `∞ ${opts.autonomy.toUpperCase()}`,
    );
  }
  if (opts.projectName && !opts.projectHidden) {
    const project = truncateChip(opts.projectName, 24);
    leading.push(opts.monochrome ? project : `${glyphs.folder} ${project}`);
  }
  if (opts.workingDir && !opts.workingDirHidden) {
    const workingDir = truncateChip(opts.workingDir, 28);
    leading.push(opts.monochrome ? workingDir : `${glyphs.workingDirectory} ${workingDir}`);
  }

  const transitionWidth = 3;
  const precedingWidth = leading.reduce(
    (total, text) => total + displayWidth(text) + RAIL_PAD + transitionWidth,
    0,
  );
  const full = opts.provider ? `${opts.provider}/${opts.model}` : opts.model;
  return { start: RAIL_CAP + precedingWidth + 1, len: displayWidth(full) };
}

export function statusBarAutonomySpan(opts: {
  yolo?: boolean | undefined;
  autonomy?: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel' | undefined;
  monochrome?: boolean | undefined;
}): { start: number; len: number } | null {
  if (!opts.autonomy || opts.autonomy === 'off') return null;
  let col = RAIL_CAP;
  if (opts.yolo) {
    const yolo = opts.monochrome ? 'YOLO' : `${glyphs.warning} YOLO`;
    const transitionWidth = 3;
    col += displayWidth(yolo) + RAIL_PAD + transitionWidth;
  }
  const label = opts.monochrome ? opts.autonomy.toUpperCase() : `∞ ${opts.autonomy.toUpperCase()}`;
  return { start: col + 1, len: displayWidth(label) };
}

export function statusBarTodosSpan(): { start: number; len: number } {
  const LABEL_MAX = 20;
  return { start: RAIL_CAP + 1, len: LABEL_MAX };
}

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
  if (ratio < 0.50) return theme.success;
  if (ratio < 0.65) return pastel.peach;
  if (ratio < 0.80) return theme.warn;
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

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
