import type React from 'react';
import { Box, Text } from '../../ink.js';
import type { HistoryEntry } from './types.js';
import { shortenPath } from './utils.js';
import { mixHex } from '../animation-style.js';
import { catppuccin, theme } from '../../theme.js';

// ── Brand palette (Catppuccin Mocha) ─────────────────────────────
// Peach (#fab387) → pink (#f5c2e7) — Catppuccin warm accent gradient.
// The FIGlet wordmark below interpolates from peach on the left to
// pink on the right so the full banner reads as one continuous brand
// gradient.
const O = catppuccin.peach;
const PINK = catppuccin.pink;
const BORDER = catppuccin.surface1;
const MUTED = catppuccin.gray;
const TEXT = catppuccin.white;

// ── FIGlet "WRONGSTACK" wordmark ─────────────────────────────────
// Classic FIGlet standard-font rendering of "WRONGSTACK".  5 rows,
// ~68 columns wide.  Rendered with a per-character orange→pink
// gradient so no two characters on the same row share a colour.
const FIGLET_ROWS = [
  ' _       ______  ____  _   ______________________   ________ __',
  '| |     / / __ \\/ __ \\/ | / / ____/ ___/_  __/   | / ____/ //_/',
  '| | /| / / /_/ / / / /  |/ / / __ \\__ \\ / / / /| |/ /   / ,<   ',
  '| |/ |/ / _, _/ /_/ / /|  / /_/ /___/ // / / ___ / /___/ /| |  ',
  '|__/|__/_/ |_|\\____/_/ |_/\\____//____//_/ /_/  |_\\____/_/ |_|  ',
];

// ── Gradient FIGlet logo ─────────────────────────────────────────
// Walks every non-space glyph in the wordmark, assigns each a colour
// on the orange→pink ramp based on its linear position in the full
// character run.  Ink flattens the nested <Text> children into
// correctly-coloured spans on one output line per row.
const GRADIENT_CHAR_CACHE = new Map<string, string>();

function buildGradientCache(): void {
  if (GRADIENT_CHAR_CACHE.size > 0) return;
  const positions: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < FIGLET_ROWS.length; r++) {
    const row = FIGLET_ROWS[r]!;
    for (let c = 0; c < row.length; c++) {
      if (row[c] !== ' ') positions.push({ r, c });
    }
  }
  const total = positions.length;
  for (let i = 0; i < positions.length; i++) {
    const { r, c } = positions[i]!;
    const t = total > 1 ? i / (total - 1) : 0.5;
    GRADIENT_CHAR_CACHE.set(`${r},${c}`, mixHex(O, PINK, t));
  }
}

function GradientFiglet(): React.ReactElement {
  buildGradientCache();
  return (
    <Box flexDirection="column" alignItems="center">
      {FIGLET_ROWS.map((row, r) => {
        const segs: React.ReactNode[] = [];
        for (let c = 0; c < row.length; c++) {
          const ch = row[c]!;
          if (ch === ' ') {
            segs.push(' ');
          } else {
            const color = GRADIENT_CHAR_CACHE.get(`${r},${c}`) ?? O;
            segs.push(
              <Text key={`${r}-${c}`} color={color}>
                {ch}
              </Text>,
            );
          }
        }
        return <Text key={r}>{segs}</Text>;
      })}
    </Box>
  );
}

// ── Utilities ────────────────────────────────────────────────────
function trunc(s: string, w: number): string {
  if (w <= 0 || !s) return '';
  if (s.length <= w) return s;
  return w === 1 ? '…' : s.slice(0, w - 1) + '…';
}

const DEFAULT_TERM_WIDTH = 80;

// ── Banner component ─────────────────────────────────────────────
export function Banner({
  entry,
  termWidth = DEFAULT_TERM_WIDTH,
}: {
  entry: Extract<HistoryEntry, { kind: 'banner' }>;
  termWidth?: number;
}): React.ReactElement {
  const pw = Math.max(20, Math.floor(termWidth));
  // Full layout ≥60 columns — shows the FIGlet wordmark + gradient.
  // Compact layout <60 columns — shows a simple orange chip + facts.
  const compact = pw < 60;
  const px = compact ? 1 : 2;
  const cw = Math.max(1, pw - px * 2 - 2);
  const cwd = shortenPath(entry.cwd, Math.max(1, Math.floor(cw * 0.5)));
  const ver = trunc(entry.version, Math.max(1, cw - 9));
  // Half-width for side-by-side family/key values in full layout
  const halfVw = Math.max(1, Math.floor((cw - 28) / 2));

  // Shared link block — shown in both layouts
  const links = (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>
        <Text color={O}>★ </Text>
        <Text dimColor>github.com/wrongstack/wrongstack</Text>
        <Text dimColor> — don&apos;t forget to star!</Text>
      </Text>
      <Text>
        <Text color={PINK}>◆ </Text>
        <Text dimColor>wrongstack.com</Text>
      </Text>
    </Box>
  );

  return (
    <Box
      width={pw}
      flexDirection="column"
      borderStyle="round"
      borderColor={BORDER}
      paddingX={px}
      paddingY={0}
    >
      {compact ? (
        /* ── Compact layout (narrow terminal) ──────────────────── */
        <>
          {/* Version chip — top-right */}
          <Box justifyContent="flex-end" marginTop={1}>
            <Text dimColor>v{ver}</Text>
          </Box>

          {/* Badge + subtitle */}
          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text backgroundColor={O} color={theme.surfaceRaised} bold>
                {' WrongStack '}
              </Text>
              <Text dimColor>{' // TERMINAL AI ENGINE'}</Text>
            </Text>
          </Box>

          {/* Single-column info */}
          <Box marginTop={1} flexDirection="column">
            <InfoRow
              icon="◆"
              label="route  "
              value={`${entry.provider} › ${entry.model}`}
              valueWidth={Math.max(1, cw - 16)}
              accent
            />
            {entry.family ? (
              <InfoRow
                icon="◇"
                label="family "
                value={entry.family}
                valueWidth={Math.max(1, cw - 16)}
              />
            ) : null}
            {entry.keyTail ? (
              <InfoRow
                icon="◈"
                label="key    "
                value={`•••• ${entry.keyTail}`}
                valueWidth={Math.max(1, cw - 16)}
              />
            ) : null}
            <InfoRow
              icon="⌁"
              label="workspc"
              value={cwd}
              valueWidth={Math.max(1, cw - 16)}
            />
          </Box>

          {links}
        </>
      ) : (
        /* ── Full layout ──────────────────────────────────────── */
        <>
          {/* Version — top-right corner */}
          <Box justifyContent="flex-end" marginTop={1}>
            <Text dimColor>v{ver}</Text>
          </Box>

          {/* Centred gradient FIGlet wordmark */}
          <Box marginTop={1} alignItems="center">
            <GradientFiglet />
          </Box>

          {/* Tagline — centered below the wordmark */}
          <Box marginTop={1} alignItems="center">
            <Text color={MUTED} italic>
              BUILT ON THE WRONG STACK. SHIPPED ANYWAY.
            </Text>
          </Box>

          {/* ── Route ──────────────────────────────────────────── */}
          <Box marginTop={1}>
            <Text>
              <Text color={O}>◆</Text>
              <Text color={MUTED} bold>
                {' route  '}
              </Text>
              <Text color={TEXT}>
                {trunc(
                  `${entry.provider} › ${entry.model}`,
                  Math.max(1, cw - 16),
                )}
              </Text>
            </Text>
          </Box>

          {/* ── Family + key (side-by-side when both present) ──── */}
          {(entry.family ?? entry.keyTail) ? (
            <Box flexDirection="row">
              {entry.family ? (
                <InfoRow
                  icon="◇"
                  label="family "
                  value={entry.family}
                  valueWidth={halfVw}
                />
              ) : null}
              {entry.family && entry.keyTail ? <Text>  </Text> : null}
              {entry.keyTail ? (
                <InfoRow
                  icon="◈"
                  label="key    "
                  value={`•••• ${entry.keyTail}`}
                  valueWidth={halfVw}
                />
              ) : null}
            </Box>
          ) : null}

          {/* ── Workspace ──────────────────────────────────────── */}
          <Box>
            <Text>
              <Text color={MUTED}>⌁</Text>
              <Text color={MUTED} bold>
                {' workspace  '}
              </Text>
              <Text>{cwd}</Text>
            </Text>
          </Box>

          {links}
        </>
      )}
    </Box>
  );
}

// ── Fact row ─────────────────────────────────────────────────────
function InfoRow({
  icon,
  label,
  value,
  valueWidth,
  accent = false,
}: {
  icon: string;
  label: string;
  value: string;
  valueWidth: number;
  accent?: boolean;
}): React.ReactElement {
  return (
    <Text>
      <Text color={accent ? O : MUTED}>{icon}</Text>
      <Text color={accent ? O : MUTED} bold>{` ${label}`}</Text>
      <Text color={accent ? '#fff' : TEXT}>{trunc(value, valueWidth)}</Text>
    </Text>
  );
}
