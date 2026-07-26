import type { ResolvedProvider } from '@wrongstack/core/types';
import { color, stripAnsi } from '@wrongstack/core/utils';

export const theme = {
  accent: color.amber,
  chrome: color.gray,
  cursor: (s: string): string => color.amber(color.bold(s)),
  ctx: color.cyan,
  cost: color.green,
  caps: color.magenta,
};

const BOX = {
  tl: '╭',
  tr: '╮',
  bl: '╰',
  br: '╯',
  h: '─',
  v: '│',
} as const;

const PICKER_MIN_WIDTH = 74;
const PICKER_MAX_WIDTH = 100;

function pickerWidth(): number {
  const cols = process.stdout.columns;
  if (typeof cols !== 'number' || !Number.isFinite(cols) || cols <= 0) {
    return PICKER_MIN_WIDTH;
  }
  return Math.max(PICKER_MIN_WIDTH, Math.min(PICKER_MAX_WIDTH, cols - 2));
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

export function padVisible(s: string, width: number): string {
  const w = visibleWidth(s);
  if (w === width) return s;
  if (w < width) return s + ' '.repeat(width - w);
  const plain = stripAnsi(s);
  return `${plain.slice(0, Math.max(0, width - 1))}…`;
}

export function boxTop(title: string): string {
  const width = pickerWidth();
  const label = ` ${title} `;
  const pad = Math.max(0, width - visibleWidth(label) - 1);
  return theme.chrome(
    `${BOX.tl}${BOX.h}${theme.accent(color.bold(label))}${theme.chrome(BOX.h.repeat(pad))}${BOX.tr}`,
  );
}

export function boxBottom(): string {
  return theme.chrome(`${BOX.bl}${BOX.h.repeat(pickerWidth())}${BOX.br}`);
}

export function boxRow(content: string): string {
  return `${theme.chrome(BOX.v)} ${padVisible(content, pickerWidth() - 2)} ${theme.chrome(BOX.v)}`;
}

export function boxDivider(): string {
  return theme.chrome(`${BOX.v}${BOX.h.repeat(pickerWidth())}${BOX.v}`);
}

export function keyHints(pairs: Array<[string, string]>): string {
  return pairs.map(([k, label]) => `${theme.accent(k)} ${color.dim(label)}`).join(color.dim(' · '));
}

const CODEX_PROVIDER_ID = 'openai-codex';
const CODEX_PICKER_HEADER = 'Select Model and Effort';
const CODEX_LEGACY_NOTE =
  'Access legacy models by running `wstack -m <model_name>` or in your `config.json`.';

export function codexPickerPreamble(provider: ResolvedProvider): string {
  if (provider.id !== CODEX_PROVIDER_ID) return '';
  return `  ${color.bold(CODEX_PICKER_HEADER)}\n${color.dim(`  ${CODEX_LEGACY_NOTE}`)}\n\n`;
}
