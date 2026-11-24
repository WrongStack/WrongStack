import type React from 'react';
import { useTerminalSize } from '../hooks/use-terminal-size.js';
import { Box, Text } from '../ink.js';
import { catppuccin } from '../theme.js';
import {
  type AuthKeyRow,
  type AuthPanelRow,
  type AuthPanelState,
  authPanelRows,
  authSelectedProvider,
} from './auth-panel-model.js';
import {
  badgeForKind,
  colorForFamily,
  dimColorForFamily,
  OAUTH_KIND_COLORS,
  UI_COLORS,
} from './provider-colors.js';

interface AuthPanelProps {
  maxRows?: number | undefined;
  columns?: number | undefined;
  panel: AuthPanelState;
}

const LIST_ACTION_LABEL: Record<string, string> = {
  catalog: '＋ Add account / auth profile (catalog)',
  local: '＋ Add local server (OmniRoute / Ollama / vLLM / LM Studio)',
  custom: '＋ Add custom provider',
  oauth: '⚡ Sign in with provider OAuth',
  hq: '⇣ Import from HQ (key vault)',
};

const PROVIDER_ACTION_LABEL: Record<string, string> = {
  'add-key': '＋ Add another key',
  'edit-provider': '✎ Edit provider',
  'edit-family': '✎ Edit family',
  'edit-base-url': '✎ Edit base URL',
  'edit-models': '✎ Edit visible model list',
  'edit-model-details': '✎ Edit model details',
  'add-model': '＋ Add model',
  'reset-model-to-catalog': '↺ Reset model to catalog',
  remove: '✕ Remove this provider',
  'back-to-list': '← Back to providers',
};

export function formatExpiry(
  expiresAt: string | undefined,
): { text: string; color: string } | null {
  if (!expiresAt) return null;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return null;

  const now = Date.now();
  const msLeft = expiry - now;

  if (msLeft <= 0) return { text: 'expired', color: UI_COLORS.error };

  const hourMs = 60 * 60_000;
  const minutes = Math.round(msLeft / 60_000);
  if (minutes < 60) return { text: `${minutes}m left`, color: UI_COLORS.error };

  const hours = Math.round(msLeft / hourMs);
  if (hours < 24) return { text: `${hours}h left`, color: UI_COLORS.warning };

  return { text: `${Math.round(msLeft / (24 * hourMs))}d left`, color: UI_COLORS.inactive };
}

function keySummary(keyRow: AuthKeyRow): string {
  const method = keyRow.authMethod === 'oauth' ? ' oauth' : '';
  const created = keyRow.createdAt ? ` ${keyRow.createdAt.slice(0, 10)}` : '';
  return `${keyRow.masked}${method}${created}`;
}

/** Hard ceiling on focused-strategy note lines so guidance can never crowd
 *  the option list out of the panel budget (the budget bound below trims
 *  further on short terminals). */
const MAX_OAUTH_NOTE_LINES = 8;

/**
 * Word-wrap one strategy `notes` paragraph to the panel's inner width.
 * Notes are trusted registry copy (builtin-strategies.ts) — plain printable
 * text, so character counting suffices; every rendered line is additionally
 * hard-truncated by `wrap="truncate-end"` as a safety net.
 */
function wrapNoteText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lines: string[] = [];
  let cur = words[0] ?? '';
  for (const word of words.slice(1)) {
    if (cur.length + 1 + word.length <= width) {
      cur += ` ${word}`;
      continue;
    }
    lines.push(cur);
    // A word wider than the panel (pathological for trusted copy) is clipped;
    // the per-line truncate-end render is the second safety net.
    cur = word.length > width ? word.slice(0, width) : word;
  }
  lines.push(cur);
  return lines;
}

function renderRow(row: AuthPanelRow, focused: boolean, i: number): React.ReactElement {
  const marker = focused ? '›' : ' ';
  const rowColor = focused ? UI_COLORS.focused : undefined;
  switch (row.kind) {
    case 'provider': {
      const p = row.provider;
      const keys =
        p.keys.length === 0
          ? 'no keys'
          : p.keys.length === 1
            ? `1 key ${p.keys[0]?.masked ?? ''}`
            : `${p.keys.length} keys`;
      const famColor = colorForFamily(p.family);
      return (
        <Text key={`p-${p.id}`} color={rowColor} wrap="truncate-end">
          {marker}{' '}
          <Text bold color={focused ? undefined : famColor}>
            {p.id.padEnd(22)}
          </Text>{' '}
          <Text color={focused ? undefined : dimColorForFamily(p.family)}>
            {(p.family ?? '—').padEnd(18)}
          </Text>{' '}
          <Text color={p.keys.length > 0 ? UI_COLORS.active : UI_COLORS.warning}>{keys}</Text>
        </Text>
      );
    }
    case 'list-action':
      return (
        <Text key={`a-${row.action}`} color={rowColor} wrap="truncate-end">
          {marker} {LIST_ACTION_LABEL[row.action]}
        </Text>
      );
    case 'key': {
      const k = row.keyRow;
      const badge = badgeForKind(k.authMethod);
      const expiry = formatExpiry(k.expiresAt);
      return (
        <Text key={`k-${k.label}`} color={rowColor} wrap="truncate-end">
          {marker}{' '}
          <Text color={k.active ? UI_COLORS.active : UI_COLORS.inactive}>
            {k.active ? '●' : '○'}
          </Text>{' '}
          {k.label.padEnd(20)}{' '}
          {badge ? <Text color={badge.color}>{badge.label.padEnd(8)}</Text> : null}
          <Text dimColor>{keySummary(k)}</Text>
          {expiry ? <Text color={expiry.color}> {expiry.text}</Text> : null}
        </Text>
      );
    }
    case 'provider-action':
      return (
        <Text key={`pa-${row.action}`} color={rowColor} wrap="truncate-end">
          {marker} {PROVIDER_ACTION_LABEL[row.action]}
        </Text>
      );
    case 'model-row':
      return (
        <Text key={`m-${row.providerId}-${row.modelId}`} color={rowColor} wrap="truncate-end">
          {marker} {row.name}
        </Text>
      );
    case 'catalog-entry': {
      const c = row.entry;
      const famColor = colorForFamily(c.family);
      return (
        <Text key={`c-${c.id}`} color={rowColor} wrap="truncate-end">
          {marker}{' '}
          <Text color={c.saved ? UI_COLORS.active : UI_COLORS.inactive}>{c.saved ? '◉' : '○'}</Text>{' '}
          <Text bold color={focused ? undefined : famColor}>
            {c.id.padEnd(24)}
          </Text>{' '}
          <Text color={focused ? undefined : dimColorForFamily(c.family)}>
            {c.family.padEnd(20)}
          </Text>
          <Text dimColor>{c.envVars.length > 0 ? c.envVars.join(', ') : ''}</Text>
        </Text>
      );
    }
    case 'local-preset': {
      const p = row.preset;
      return (
        <Text key={`l-${p.id}`} color={rowColor} wrap="truncate-end">
          {marker}{' '}
          <Text bold color={focused ? undefined : catppuccin.peach}>
            {p.label.padEnd(12)}
          </Text>{' '}
          <Text dimColor>{p.defaultBaseUrl.padEnd(28)}</Text>{' '}
          <Text color={p.noAuth ? UI_COLORS.inactive : UI_COLORS.active}>
            {p.noAuth ? 'no auth' : 'optional key'}
          </Text>
        </Text>
      );
    }
    case 'oauth-option': {
      const o = row.oauth;
      const kindColor = OAUTH_KIND_COLORS[o.id] ?? UI_COLORS.focused;
      return (
        <Text key={`o-${o.id}`} color={rowColor} wrap="truncate-end">
          {marker}{' '}
          <Text bold color={focused ? undefined : kindColor}>
            {o.label.padEnd(20)}
          </Text>{' '}
          <Text dimColor>{o.description ?? `→ ${o.providerId}`}</Text>
        </Text>
      );
    }
    case 'form-field': {
      // Secret fields render masked (the value is already in panel state);
      // the family row shows the current family with arrows when focused so
      // the keyboard affordance is visible on screen.
      const placeholder = row.field === 'family' ? (focused ? '◀ ▶' : '   ') : focused ? '▏' : '';
      const display =
        row.field === 'family'
          ? row.value || '—'
          : row.secret
            ? '•'.repeat(row.value.length)
            : row.value.length > 0
              ? row.value
              : focused
                ? ' '
                : '';
      const valueColor =
        row.field === 'family'
          ? focused
            ? UI_COLORS.focused
            : UI_COLORS.active
          : row.value.length > 0
            ? undefined
            : UI_COLORS.hint;
      return (
        <Text key={`ff-${row.field}`} color={rowColor} wrap="truncate-end">
          {marker} <Text dimColor>{row.label.padEnd(22)}</Text>{' '}
          <Text color={valueColor}>{display}</Text>
          {focused ? <Text color={UI_COLORS.focused}>{placeholder}</Text> : null}
        </Text>
      );
    }
    case 'form-action': {
      const label = row.action === 'save' ? '✔ Save' : '✕ Cancel';
      const color =
        row.action === 'save'
          ? focused
            ? UI_COLORS.focused
            : UI_COLORS.active
          : focused
            ? UI_COLORS.focused
            : UI_COLORS.warning;
      return (
        <Text key={`fa-${row.action}`} color={rowColor} wrap="truncate-end">
          {marker} <Text color={color}>{label}</Text>
        </Text>
      );
    }
    default:
      return <Text key={`r-${i}`}> </Text>;
  }
}

const URL_LINE_RE = /^https?:\/\/\S+$/;

/**
 * OSC 8 terminal hyperlink sequences: `\x1b]8;;URL\x1b\\...text...\x1b]8;;\x1b\\`
 * Strip them for URL detection — the renderer still outputs them so the
 * terminal makes the text clickable (Windows Terminal, iTerm2, Kitty, WezTerm).
 */
const OSC8_RE = /\x1b]8;[^\x07]*?(?:\x07|\x1b\\)/g;

function authFlowUrl(line: string): string | undefined {
  // Strip OSC 8 hyperlink sequences so the plain-URL regex matches.
  const plain = line.replace(OSC8_RE, '').trim();
  return URL_LINE_RE.test(plain) ? plain : undefined;
}

export function isAuthFlowUrlLine(line: string): boolean {
  return authFlowUrl(line) !== undefined;
}

/** Keep the newest authorize URL pinned even as later status lines arrive. */
export function latestAuthFlowUrl(lines: readonly string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined) continue;
    const url = authFlowUrl(line);
    if (url) return url;
  }
  return undefined;
}

function terminalHyperlink(url: string, label: string): string {
  return `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function viewTitle(panel: AuthPanelState): string {
  switch (panel.view) {
    case 'list':
      return 'API keys & sign-in';
    case 'provider':
      return `Provider — ${panel.providerId ?? ''}`;
    case 'models':
      return `Models — ${panel.providerId ?? ''}`;
    case 'catalog':
      return 'Add provider — models.dev catalog';
    case 'local':
      return 'Add local server';
    case 'oauth':
      return 'Sign in with OAuth';
    case 'flow':
      return panel.flowTitle || 'Working…';
    case 'form':
      if (panel.form?.kind === 'edit') return `Edit provider — ${panel.form.providerId ?? ''}`;
      if (panel.form?.kind === 'local') {
        const preset = panel.presets.find((p) => p.id === panel.form?.presetId);
        return `Add local server — ${preset?.label ?? panel.form.presetId ?? ''}`;
      }
      return 'Add provider';
  }
}

function viewLegend(panel: AuthPanelState): string {
  if (panel.input) return 'Enter submit · Esc cancel';
  if (panel.confirm) return 'y/Enter confirm · n/Esc cancel';
  switch (panel.view) {
    case 'list':
      return '↑/↓ select · Enter open · Esc close';
    case 'provider':
      return '↑/↓ select · Enter activate/run · u update key · d delete key · Esc back';
    case 'models':
      return '↑/↓ select · Enter edit model · Esc back';
    case 'catalog':
      return 'type to filter · ↑/↓ select · Enter add key · Esc back';
    case 'local':
      return '↑/↓ select · Enter configure & probe · Esc back';
    case 'oauth':
      return '↑/↓ select · Enter sign in · Esc back';
    case 'flow':
      return panel.flowDone ? 'Enter/Esc back' : 'Esc cancel';
    case 'form':
      return panel.form?.kind === 'local'
        ? 'type to edit · Enter select · Esc cancel'
        : 'type to edit · ←/→ cycle family · Enter select · Esc cancel';
  }
}

export function AuthPanel({ panel, maxRows, columns }: AuthPanelProps): React.ReactElement {
  const size = useTerminalSize();
  const budget = maxRows ?? Math.max(8, size.rows - 7);
  const compact = budget < 14;
  // Border (2) + paddingX (1 each side) shrink the usable text width.
  const noteWidth = Math.max(20, (columns ?? size.columns) - 4);
  // Oauth rows map 1:1 onto `oauthStrategies`, so the cursor index selects
  // the strategy whose guidance renders below the ToS warning.
  const oauthFocus = panel.view === 'oauth' ? panel.oauthStrategies?.[panel.selected] : undefined;
  const oauthNoteLines =
    !compact && oauthFocus?.notes
      ? oauthFocus.notes
          .flatMap((note, i) =>
            // Blank separator between paragraphs; a space (not '') so Ink
            // emits the row and the reserve below matches the render.
            (i > 0 ? [' '] : []).concat(wrapNoteText(note, noteWidth)),
          )
          .slice(
            0,
            // 8 keeps at least one list row visible on any non-compact
            // budget: total = 8 border/title/legend/warning + N + 1 list.
            Math.min(MAX_OAUTH_NOTE_LINES, Math.max(0, budget - 8)),
          )
      : [];
  const extraRows =
    (panel.hint ? 1 : 0) +
    (panel.confirm ? (compact ? 1 : 2) : 0) +
    (panel.input ? (compact ? 1 : 2) : 0) +
    (panel.view === 'catalog' ? (compact ? 1 : 2) : 0) +
    (!compact && panel.view === 'provider' ? 2 : 0) +
    (!compact && panel.view === 'oauth' ? 3 + oauthNoteLines.length : 0) +
    (!compact && panel.view === 'list' && panel.providers.length === 0 ? 2 : 0) +
    (!compact && panel.view === 'catalog' && panel.busy ? 2 : 0);
  const maxVisible = Math.max(
    1,
    budget - 4 - extraRows - (panel.view === 'flow' ? (compact ? 0 : 1) : 2),
  );

  const allRows = authPanelRows(panel);
  const total = allRows.length;
  const windowStart =
    total <= maxVisible
      ? 0
      : Math.max(0, Math.min(panel.selected - Math.floor(maxVisible / 2), total - maxVisible));
  const windowEnd = Math.min(windowStart + maxVisible, total);
  const above = windowStart;
  const below = total - windowEnd;

  const provider = panel.view === 'provider' ? authSelectedProvider(panel) : undefined;
  const flowUrl = panel.view === 'flow' ? latestAuthFlowUrl(panel.log) : undefined;
  const flowLog = flowUrl ? panel.log.filter((line) => !isAuthFlowUrlLine(line)) : panel.log;
  // Keep status + pinned URL + completion marker within the same content
  // budget so later lines cannot displace the login link below the viewport.
  const flowLogRows = Math.max(1, maxVisible - (flowUrl ? 1 : 0) - (panel.flowDone ? 1 : 0));
  const logWindow = flowLog.slice(-flowLogRows);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={UI_COLORS.border} paddingX={1}>
      <Text bold color={UI_COLORS.title} wrap="truncate-end">
        {viewTitle(panel)}
      </Text>
      <Text dimColor wrap="truncate-end">
        {(columns ?? size.columns) < 80 && !panel.input && !panel.confirm && panel.view !== 'flow'
          ? 'Esc back · ↑↓ select · Enter'
          : viewLegend(panel)}
      </Text>

      {panel.hint ? (
        <Text
          wrap="truncate-end"
          color={
            panel.hint.startsWith('✗')
              ? UI_COLORS.error
              : panel.hint.startsWith('✓')
                ? UI_COLORS.active
                : UI_COLORS.hint
          }
        >
          {panel.hint}
        </Text>
      ) : null}

      {/* The legend above already carries the y/n keys — this states the target. */}
      {panel.confirm ? (
        <Box marginTop={compact ? 0 : 1}>
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            ⚠ {panel.confirm.question}
          </Text>
        </Box>
      ) : null}

      {!compact && panel.view === 'list' && panel.providers.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {panel.busy
              ? 'Loading saved providers…'
              : 'No providers configured yet — pick an action below to add one.'}
          </Text>
        </Box>
      ) : null}

      {!compact && panel.view === 'catalog' && panel.busy ? (
        <Box marginTop={1}>
          <Text dimColor>Loading models.dev catalog…</Text>
        </Box>
      ) : null}

      {!compact && panel.view === 'provider' && provider ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate-end">
            type: {provider.type ?? provider.id} · family: {provider.family ?? 'unset'} · baseUrl:{' '}
            {provider.baseUrl ?? 'unset'}
          </Text>
          {provider.models.length > 0 ? (
            <Text dimColor wrap="truncate-end">
              models: {provider.models.join(', ')}
            </Text>
          ) : null}
        </Box>
      ) : null}

      {!compact && panel.view === 'oauth' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            ⚠ Subscription tokens used outside official clients may violate provider Terms —
          </Text>
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            your account could be rate-limited or banned. An API key is the sanctioned path.
          </Text>
        </Box>
      ) : null}

      {/* Focused-strategy guidance from the strategy registry `notes` —
          wrapped, so it may be several sentences. Rendered before the option
          list so it is read before the user presses Enter to sign in. The
          row budget above reserves exactly these lines. */}
      {oauthNoteLines.length > 0 ? (
        <Box flexDirection="column">
          {oauthNoteLines.map((line, ni) => (
            <Text key={`on-${ni}`} dimColor wrap="truncate-end">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}

      {panel.view === 'catalog' ? (
        <Box marginTop={compact ? 0 : 1}>
          <Text wrap="truncate-end">
            <Text dimColor>filter: </Text>
            {panel.filter.length > 0 ? panel.filter : <Text dimColor>(type to search)</Text>}
            <Text color={UI_COLORS.focused}>▏</Text>
          </Text>
        </Box>
      ) : null}

      {panel.view === 'flow' ? (
        <Box flexDirection="column" marginTop={compact ? 0 : 1}>
          {logWindow.length === 0 && !panel.flowDone && !flowUrl ? (
            <Text dimColor>Starting…</Text>
          ) : null}
          {logWindow.map((line, li) => (
            <Text
              key={`fl-${li}`}
              wrap="truncate-end"
              color={
                line.startsWith('✗')
                  ? UI_COLORS.error
                  : line.startsWith('✓')
                    ? UI_COLORS.active
                    : undefined
              }
              dimColor={!line.startsWith('✗') && !line.startsWith('✓')}
            >
              {line}
            </Text>
          ))}
          {flowUrl ? (
            <Text wrap="truncate-end" color={UI_COLORS.hint} bold>
              Open: {terminalHyperlink(flowUrl, flowUrl)}
            </Text>
          ) : null}
          {panel.flowDone ? (
            <Text wrap="truncate-end" color={panel.flowOk ? UI_COLORS.active : UI_COLORS.error}>
              {panel.flowOk ? '✓ Done.' : '✗ Not completed.'}{' '}
              <Text dimColor>Press Enter or Esc to go back.</Text>
            </Text>
          ) : null}
        </Box>
      ) : null}

      {/*
        Rendered outside the `flow` block on purpose: `readSecret` (slash-command
        secret prompts) raises this modal in `list` view, where there is no flow.
      */}
      {panel.input ? (
        <Box marginTop={compact ? 0 : 1}>
          <Text wrap="truncate-end">
            <Text color={UI_COLORS.warning}>? </Text>
            {panel.input.label}{' '}
            <Text color={UI_COLORS.hint}>
              {panel.input.masked ? '•'.repeat(panel.input.draft.length) : panel.input.draft}
            </Text>
            <Text color={UI_COLORS.focused}>▏</Text>
          </Text>
        </Box>
      ) : null}

      {panel.view !== 'flow' && !panel.input && !panel.confirm ? (
        <Box flexDirection="column" minHeight={maxVisible}>
          {above > 0 ? (
            <Text dimColor>
              {'\u25b2'} {above} above
            </Text>
          ) : null}
          {allRows.slice(windowStart, windowEnd).map((row, ri) => (
            <Box key={`row-${windowStart + ri}`} marginLeft={0}>
              {renderRow(row, windowStart + ri === panel.selected, windowStart + ri)}
            </Box>
          ))}
          {/* Pad trailing slots to prevent ghost text from a longer previous list */}
          {Array.from({ length: maxVisible - (windowEnd - windowStart) }).map((_, i) => (
            <Box key={`pad-${i}`}>
              <Text> </Text>
            </Box>
          ))}
          {below > 0 ? (
            <Text dimColor>
              {'\u25bc'} {below} below
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
