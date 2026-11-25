import { color } from '@wrongstack/core/utils';
import type { TerminalRenderer } from './renderer.js';
import { theme } from './theme.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';

const FILLED = '█';
const EMPTY = '░';

export function renderContextChip(used: number, max: number): string {
  const safeUsed = Number.isFinite(used) && used > 0 ? used : 0;
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const ratio = safeMax > 0 ? Math.max(0, Math.min(1, safeUsed / safeMax)) : 0;
  const pct = Math.round(ratio * 100);
  const bar = renderProgress(ratio, 6);
  return `${bar} ${pct}% (${fmtTok(safeUsed)}/${fmtTok(safeMax)})`;
}

function renderProgress(ratio: number, width: number): string {
  const safeRatio = Number.isFinite(ratio) ? ratio : 0;
  const clamped = Math.max(0, Math.min(1, safeRatio));
  const filled = clamped === 0 ? 0 : Math.max(1, Math.round(clamped * width));
  const capped = Math.min(width, filled);
  return FILLED.repeat(capped) + EMPTY.repeat(width - capped);
}

export function printBanner(renderer: TerminalRenderer, projectName?: string): void {
  const lines = [
    theme.primary(theme.bold('WrongStack')) + color.dim(` v${CLI_VERSION}`),
    color.dim('Built on the wrong stack. Shipped anyway.'),
  ];
  if (projectName && projectName.length > 0) {
    lines.push(color.dim('Project: ') + theme.bold(projectName));
  }
  lines.push(color.dim('Type /help for commands, /exit or q to quit.'), '');
  renderer.write(`${lines.join('\n')}\n`);
}
