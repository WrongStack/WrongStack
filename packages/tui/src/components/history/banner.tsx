import type React from 'react';
import { useActiveTheme } from '../../hooks/use-active-theme.js';
import { Box, Text } from '../../ink.js';
import { truncateDisplay } from '../../terminal-width.js';
import { theme } from '../../theme.js';
import { mixHex } from '../animation-style.js';
import type { AutonomyAgentStatus, HistoryEntry } from './types.js';
import { shortenPath } from './utils.js';

// Brand-mark colours now follow the active theme rather than the literal SVG
// hex values. `brandPrimary` (Catppuccin peach on the default preset) and
// `brandAccent` (pink) are the documented home for these tokens — selecting
// a different `/theme` preset re-skins the mark accordingly. Resolved at
// render time so `/theme` swaps during a running session take effect on the
// next paint without re-mounting the banner.
const STACK_ORANGE = () => theme.brandPrimary;
const SIGNAL_PINK = () => theme.brandAccent;
const BORDER = () => theme.borderDefault;
const MUTED = () => theme.textMuted;
const TEXT = () => theme.textPrimary;

// The SVG is five 60px blocks: four orange blocks share a baseline and the
// pink second block is shifted down by half a block. Two terminal cells make
// each block approximately square in a monospace font.
//
// Row 0: orange blocks with a gap at the pink's home column (1).
// Row 1: full row — orange everywhere except the pink block.
// Row 2: the pink block's "tail" hanging below.
const MARK_COLS = 5;
const PINK_HOME = 1; // resting column for the pink block (0-indexed)

// ── Pink-square bounce animation ─────────────────────────────────────────
// The real mark offsets its pink tile by half a block. In the terminal we
// occasionally lift that tile by one text row, then let it settle. The long
// resting section makes this feel like a small logo gesture instead of a
// loading spinner.
const PINK_BOUNCE_FRAMES: readonly (0 | 1)[] = Object.freeze([
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 1, 1,
]);

export function brandMarkPinkRow(frame: number): 0 | 1 {
  const index = Math.max(0, Math.trunc(frame)) % PINK_BOUNCE_FRAMES.length;
  return PINK_BOUNCE_FRAMES[index] ?? 1;
}

function BrandMark({ pinkRow = 1 }: { pinkRow?: 0 | 1 }): React.ReactElement {
  const rows = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: MARK_COLS }, (_, column) => {
      if (column === PINK_HOME && (row === pinkRow || row === pinkRow + 1)) {
        return SIGNAL_PINK();
      }
      if (row < 2 && column !== PINK_HOME) return STACK_ORANGE();
      return null;
    }),
  );

  return (
    <Box flexDirection="column" alignItems="center">
      {rows.map((row, rowIndex) => (
        <Text key={rowIndex} bold>
          {row.map((color, columnIndex) => (
            <Text key={columnIndex} color={color ?? undefined}>
              {color ? '██' : '  '}
              {columnIndex < row.length - 1 ? ' ' : ''}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

// ── Packed 5×7 wordmark ───────────────────────────────────────────────────
//
// Each terminal cell represents two vertical bitmap pixels: ▀ paints the top,
// ▄ the bottom, and █ both. Packing (rather than expanding) the 5×7 face keeps
// curves detailed and strokes continuous without making the banner too tall.
const WORDMARK_GLYPH_BITS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  W: Object.freeze(['10001', '10001', '10001', '10101', '10101', '10101', '01010']),
  R: Object.freeze(['11110', '10001', '10001', '11110', '10100', '10010', '10001']),
  O: Object.freeze(['01110', '10001', '10001', '10001', '10001', '10001', '01110']),
  N: Object.freeze(['10001', '11001', '11001', '10101', '10011', '10011', '10001']),
  G: Object.freeze(['01110', '10001', '10000', '10111', '10001', '10001', '01110']),
  S: Object.freeze(['01111', '10000', '10000', '01110', '00001', '00001', '11110']),
  T: Object.freeze(['11111', '00100', '00100', '00100', '00100', '00100', '00100']),
  A: Object.freeze(['01110', '10001', '10001', '11111', '10001', '10001', '10001']),
  C: Object.freeze(['01111', '10000', '10000', '10000', '10000', '10000', '01111']),
  K: Object.freeze(['10001', '10010', '10100', '11000', '10100', '10010', '10001']),
});

const WORDMARK = 'WRONGSTACK';
const WORDMARK_PIXEL_ROWS = 7;
const WORDMARK_ROWS = Math.ceil(WORDMARK_PIXEL_ROWS / 2);
const GLYPH_WIDTH = 5;
const WORDMARK_WIDTH = WORDMARK.length * GLYPH_WIDTH + WORDMARK.length - 1;

function packedCell(top: string | undefined, bottom: string | undefined): string {
  if (top === '1' && bottom === '1') return '█';
  if (top === '1') return '▀';
  if (bottom === '1') return '▄';
  return ' ';
}

function packedGlyphRow(glyph: ReadonlyArray<string>, row: number): string {
  const top = glyph[row * 2] ?? '';
  const bottom = glyph[row * 2 + 1] ?? '';
  return Array.from({ length: GLYPH_WIDTH }, (_, column) =>
    packedCell(top[column], bottom[column]),
  ).join('');
}

export const WORDMARK_LINES: ReadonlyArray<string> = Object.freeze(
  Array.from({ length: WORDMARK_ROWS }, (_, row) =>
    [...WORDMARK]
      .map((letter) => {
        const glyph = WORDMARK_GLYPH_BITS[letter];
        return glyph ? packedGlyphRow(glyph, row) : ' '.repeat(GLYPH_WIDTH);
      })
      .join(' '),
  ),
);

export function bannerGradientColor(position: number, length: number): string {
  const progress = length > 1 ? position / (length - 1) : 0.5;
  return mixHex(STACK_ORANGE(), SIGNAL_PINK(), progress);
}

function GradientText({ text }: { text: string }): React.ReactElement {
  return (
    <Text bold>
      {[...text].map((character, index) =>
        character === ' ' ? (
          ' '
        ) : (
          <Text key={index} color={bannerGradientColor(index, text.length)}>
            {character}
          </Text>
        ),
      )}
    </Text>
  );
}

function PixelWordmark(): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center">
      {WORDMARK_LINES.map((line, row) => (
        <GradientText key={row} text={line} />
      ))}
    </Box>
  );
}

function trunc(value: string, width: number): string {
  if (width <= 0 || !value) return '';
  if (value.length <= width) return value;
  return width === 1 ? '…' : `${value.slice(0, width - 1)}…`;
}

function InfoRow({
  icon,
  label,
  value,
  contentWidth,
  compact = false,
  accent = false,
}: {
  icon: string;
  label: string;
  value: string;
  contentWidth: number;
  compact?: boolean;
  accent?: boolean;
}): React.ReactElement {
  const labelWidth = compact ? 6 : 9;
  const valueWidth = Math.max(1, contentWidth - labelWidth - 3);
  const color = accent ? STACK_ORANGE() : MUTED();
  return (
    <Text>
      <Text color={color}>{icon}</Text>
      <Text color={color} bold>{` ${trunc(label, labelWidth).padEnd(labelWidth)} `}</Text>
      <Text color={accent ? TEXT() : MUTED()}>{trunc(value, valueWidth)}</Text>
    </Text>
  );
}

// Renders the profile row with the full config.json path, highlighting the
// profile-name segment (the directory between "profiles/" and "/config.json")
// in the accent color. Falls back to a plain InfoRow when only the bare
// profile name is available. When the path overflows the value column it is
// shortened from the left (…/<tail>) so the trailing filename survives.
function ProfileRow({
  profile,
  profileConfigPath,
  contentWidth,
  compact,
}: {
  profile?: string | undefined;
  profileConfigPath?: string | undefined;
  contentWidth: number;
  compact: boolean;
}): React.ReactElement | null {
  if (!profileConfigPath && !profile) return null;
  const labelWidth = compact ? 6 : 9;
  const valueWidth = Math.max(1, contentWidth - labelWidth - 3);
  const icon = '⚙';
  const label = 'profile';

  // Bare-name fallback: render as a normal accent InfoRow.
  if (!profileConfigPath) {
    return (
      <InfoRow
        icon={icon}
        label={label}
        value={profile as string}
        contentWidth={contentWidth}
        compact={compact}
        accent
      />
    );
  }

  const fullPath = profileConfigPath;
  const displayPath = fullPath.length <= valueWidth ? fullPath : shortenPath(fullPath, valueWidth);

  // Locate the profile-name segment so we can highlight just that part.
  // Match either "/profiles/<name>/config.json" or "\profiles\<name>\config.json".
  const segmentMatch = fullPath.match(/[/\\]profiles[/\\]([^/\\]+)[/\\]config\.json$/);
  const profileSegment = segmentMatch?.[1] ?? '';
  // lastIndexOf returns -1 when the segment was truncated away — in that case
  // we fall through to a plain muted render rather than mis-highlighting.
  const segIdx = profileSegment ? displayPath.lastIndexOf(profileSegment) : -1;

  return (
    <Text>
      <Text color={STACK_ORANGE()}>{icon}</Text>
      <Text color={STACK_ORANGE()} bold>{` ${trunc(label, labelWidth).padEnd(labelWidth)} `}</Text>
      {segIdx >= 0 && profileSegment ? (
        <>
          <Text color={MUTED()}>{displayPath.slice(0, segIdx)}</Text>
          <Text color={STACK_ORANGE()} bold>
            {profileSegment}
          </Text>
          <Text color={MUTED()}>{displayPath.slice(segIdx + profileSegment.length)}</Text>
        </>
      ) : (
        <Text color={MUTED()}>{displayPath}</Text>
      )}
    </Text>
  );
}

// OSC 8 terminal hyperlinks — the same escape-sequence mechanism used by the
// OAuth flows. Terminals that support clickable links (iTerm2, Windows Terminal,
// Kitty, etc.) will render these as interactive; others see plain underlined text.
const OSC8_WRONGSTACK = '\x1b]8;;https://wrongstack.com\x1b\\wrongstack.com\x1b]8;;\x1b\\';
const OSC8_GITHUB = '\x1b]8;;https://github.com/wrongstack/wrongstack\x1b\\github\x1b]8;;\x1b\\';

function Footer({
  contentWidth,
  compact,
}: {
  contentWidth: number;
  compact: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
      <Text>
        <Text color={SIGNAL_PINK()}>◆ </Text>
        <Text dimColor>{OSC8_WRONGSTACK}</Text>
        {!compact || contentWidth >= 35 ? (
          <>
            <Text dimColor> · </Text>
            <Text color={STACK_ORANGE()}>★ </Text>
            <Text dimColor>{OSC8_GITHUB}</Text>
          </>
        ) : null}
      </Text>
    </Box>
  );
}

// ── Animated autonomy agent status ────────────────────────────────────────

/** Agent display order (canonical left-to-right). */
const AGENT_ORDER: ReadonlyArray<string> = ['Brain', 'Shadow', 'Kanban', 'Mailbox', 'Memory'];

function AutonomyAgentsSection({
  agents,
  contentWidth,
  compact,
}: {
  agents: ReadonlyArray<AutonomyAgentStatus>;
  contentWidth: number;
  compact: boolean;
}): React.ReactElement {
  // Build a lookup so we preserve the canonical order.
  const lookup = new Map(agents.map((a) => [a.name, a]));

  // Decide per-agent indicator
  const maxLabelWidth = Math.max(1, contentWidth - 4);

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Thin rule to separate from footer */}
      <Text color={BORDER()}>──────────────</Text>
      <Box flexDirection="row" flexWrap="wrap" marginTop={0}>
        {AGENT_ORDER.map((name) => {
          const agent = lookup.get(name);
          if (!agent) return null;

          const online = agent.online;
          const indicator = online ? '●' : '·';
          const color = online ? STACK_ORANGE() : MUTED();
          const detail = agent.detail;

          return (
            <Box key={name} flexDirection="row" marginRight={2}>
              <Text color={color}>{indicator}</Text>
              <Text color={color}>
                {' '}
                {trunc(compact ? name.slice(0, 4) : name, compact ? 4 : 8)}
              </Text>
              {!compact && detail ? (
                <Text dimColor> {trunc(detail, Math.max(1, maxLabelWidth - 12))}</Text>
              ) : null}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

const DEFAULT_TERM_WIDTH = 80;
const FULL_LAYOUT_MIN_WIDTH = WORDMARK_WIDTH + 6;
// Rendered row budget without optional facts:
// compact = border 2 + version 2 + mark 3 + identity 3 + facts 3 + footer 3 = 16.
// Full adds the mark's top margin (1) and replaces the 3-row compact identity
// with the 7-row pixel wordmark/tagline block (+4), for five additional rows.
const COMPACT_BASE_ROWS = 16;
const FULL_LAYOUT_EXTRA_ROWS = 5;

function bannerOptionalRows(entry: Extract<HistoryEntry, { kind: 'banner' }>): number {
  return (
    Number(Boolean(entry.family)) +
    Number(Boolean(entry.keyTail)) +
    Number(Boolean(entry.sessionId)) +
    Number(Boolean(entry.profileConfigPath || entry.profile)) +
    (entry.autonomyAgents?.length ? 3 : 0)
  );
}

export function Banner({
  entry,
  termWidth = DEFAULT_TERM_WIDTH,
  termHeight,
}: {
  entry: Extract<HistoryEntry, { kind: 'banner' }>;
  termWidth?: number;
  termHeight?: number;
}): React.ReactElement | null {
  // Subscribe to active-theme changes so a `/theme` swap during a live
  // session re-paints the banner. Banner sits inside the memoized History
  // list, so without this hook a swap would leave the mark / wordmark on
  // the old palette while every other component repainted.
  useActiveTheme();
  const panelWidth = Math.max(20, Math.floor(termWidth));
  const optionalRows = bannerOptionalRows(entry);
  const compactRows = COMPACT_BASE_ROWS + optionalRows;
  const condensed = termHeight !== undefined && termHeight < compactRows + FULL_LAYOUT_EXTRA_ROWS;
  const compact = panelWidth < FULL_LAYOUT_MIN_WIDTH || condensed;
  const paddingX = compact ? 1 : 2;
  const contentWidth = Math.max(1, panelWidth - paddingX * 2 - 2);
  const cwd = shortenPath(entry.cwd, Math.max(1, contentWidth - (compact ? 9 : 12)));
  const version = trunc(entry.version, Math.max(1, contentWidth - 1));
  const route = `${entry.provider} › ${entry.model}`;

  // This banner persists in history. Keep it static so an idle TUI never
  // redraws the whole Ink tree solely for a decorative logo gesture.
  const pinkRow = 1;

  // A not-yet-measured pane has no rows available. Rendering even the bare
  // identity line would leak outside its viewport.
  if (termHeight !== undefined && termHeight <= 0) return null;

  if (condensed) {
    const unbordered = (termHeight ?? 0) < 3;
    const summary = truncateDisplay(
      `WrongStack v${version} | ${entry.provider}/${entry.model} | ${cwd}`,
      Math.max(1, panelWidth - (unbordered ? 0 : 4)),
    );
    if (unbordered) {
      return (
        <Text color={STACK_ORANGE()} bold>
          {summary}
        </Text>
      );
    }
    return (
      <Box width={panelWidth} borderStyle="round" borderColor={BORDER()} paddingX={1}>
        <Text color={STACK_ORANGE()} bold>
          {summary}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      width={panelWidth}
      flexDirection="column"
      borderStyle="round"
      borderColor={BORDER()}
      paddingX={paddingX}
      paddingY={0}
    >
      <Box justifyContent="flex-end" marginTop={1}>
        <Text color={MUTED()}>v{version}</Text>
        {entry.updateAvailable && entry.latestVersion ? (
          <Text color={STACK_ORANGE()}> · (update available: v{entry.latestVersion})</Text>
        ) : null}
      </Box>

      <Box justifyContent="center" marginTop={compact ? 0 : 1}>
        <BrandMark pinkRow={pinkRow} />
      </Box>

      {compact ? (
        <>
          <Box justifyContent="center" marginTop={1}>
            <GradientText text="WrongStack" />
          </Box>
          <Box justifyContent="center">
            <Text color={MUTED()}>{trunc('TERMINAL AI ENGINE', contentWidth)}</Text>
          </Box>
        </>
      ) : (
        <>
          <Box justifyContent="center" marginTop={1}>
            <PixelWordmark />
          </Box>
          <Box justifyContent="center" marginTop={1}>
            <Text color={MUTED()} italic>
              BUILT ON THE WRONG STACK. SHIPPED ANYWAY.
            </Text>
          </Box>
        </>
      )}

      <Box flexDirection="column" marginTop={1}>
        <InfoRow
          icon="◆"
          label="route"
          value={route}
          contentWidth={contentWidth}
          compact={compact}
          accent
        />
        {entry.family ? (
          <InfoRow
            icon="◇"
            label="family"
            value={entry.family}
            contentWidth={contentWidth}
            compact={compact}
          />
        ) : null}
        {entry.keyTail ? (
          <InfoRow
            icon="◈"
            label="key"
            value={`•••• ${entry.keyTail}`}
            contentWidth={contentWidth}
            compact={compact}
          />
        ) : null}
        {entry.sessionId ? (
          <InfoRow
            icon="◈"
            label="session"
            value={entry.sessionId}
            contentWidth={contentWidth}
            compact={compact}
          />
        ) : null}
        <InfoRow
          icon="⌁"
          label={compact ? 'cwd' : 'workspace'}
          value={cwd}
          contentWidth={contentWidth}
          compact={compact}
        />
        <ProfileRow
          profile={entry.profile}
          profileConfigPath={entry.profileConfigPath}
          contentWidth={contentWidth}
          compact={compact}
        />
      </Box>

      <Footer contentWidth={contentWidth} compact={compact} />

      {entry.autonomyAgents && entry.autonomyAgents.length > 0 ? (
        <AutonomyAgentsSection
          agents={entry.autonomyAgents}
          contentWidth={contentWidth}
          compact={compact}
        />
      ) : null}
    </Box>
  );
}
