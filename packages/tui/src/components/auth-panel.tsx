import type React from 'react';
import { Box, Text, useStdout } from '../ink.js';
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
import { catppuccin } from '../theme.js';

interface AuthPanelProps {
  panel: AuthPanelState;
}

/**
 * Rows of chrome around the visible row window: the panel's own border /
 * title / legend / footer (~10) plus the collapsed input placeholder,
 * statusline below (~7). Subtracted from `stdout.rows`
 * so the list never pushes the status area off-screen.
 */
const CHROME_ROWS = 17;

const LIST_ACTION_LABEL: Record<string, string> = {
  catalog: '＋ Add provider (models.dev catalog)',
  local: '＋ Add local server (OmniRoute / Ollama / vLLM / LM Studio)',
  custom: '＋ Add custom provider',
  oauth: '⚡ Sign in with OAuth (ChatGPT / Claude / Copilot)',
};

const PROVIDER_ACTION_LABEL: Record<string, string> = {
  'add-key': '＋ Add another key',
  'edit-family': '✎ Edit family',
  'edit-base-url': '✎ Edit base URL',
  'edit-models': '✎ Edit visible model list',
  'edit-model-details': '✎ Edit model details',
  'add-model': '＋ Add model',
  'reset-model-to-catalog': '↺ Reset model to catalog',
  remove: '✕ Remove this provider',
  'back-to-list': '← Back to providers',
};

const OAUTH_LABEL: Record<string, { title: string; detail: string }> = {
  chatgpt: { title: 'ChatGPT Plus/Pro', detail: '→ openai-codex' },
  claude: { title: 'Claude Pro/Max', detail: '→ anthropic-oauth' },
  copilot: { title: 'GitHub Copilot', detail: '→ github-copilot' },
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
  if (msLeft < 60 * 60_000)
    return { text: `${Math.round(msLeft / 60_000)}m left`, color: UI_COLORS.error };
  if (msLeft < 24 * 60 * 60_000)
    return { text: `${Math.round(msLeft / (60 * 60_000))}h left`, color: UI_COLORS.warning };
  return { text: `${Math.round(msLeft / (24 * 60 * 60_000))}d left`, color: UI_COLORS.inactive };
}

function keySummary(keyRow: AuthKeyRow): string {
  const method = keyRow.authMethod === 'oauth' ? ' oauth' : '';
  const created = keyRow.createdAt ? ` ${keyRow.createdAt.slice(0, 10)}` : '';
  return `${keyRow.masked}${method}${created}`;
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
      const o = OAUTH_LABEL[row.oauth] ?? { title: row.oauth, detail: '' };
      const kindColor = OAUTH_KIND_COLORS[row.oauth] ?? UI_COLORS.focused;
      return (
        <Text key={`o-${row.oauth}`} color={rowColor} wrap="truncate-end">
          {marker}{' '}
          <Text bold color={focused ? undefined : kindColor}>
            {o.title.padEnd(20)}
          </Text>{' '}
          <Text dimColor>{o.detail}</Text>
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
  }
}

export function AuthPanel({ panel }: AuthPanelProps): React.ReactElement {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const maxVisible = Math.max(4, rows - CHROME_ROWS);

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
      <Text bold color={UI_COLORS.title}>
        {viewTitle(panel)}
      </Text>
      <Text dimColor>{viewLegend(panel)}</Text>

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
        <Box marginTop={1}>
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            ⚠ {panel.confirm.question}
          </Text>
        </Box>
      ) : null}

      {panel.view === 'list' && panel.providers.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {panel.busy
              ? 'Loading saved providers…'
              : 'No providers configured yet — pick an action below to add one.'}
          </Text>
        </Box>
      ) : null}

      {panel.view === 'catalog' && panel.busy ? (
        <Box marginTop={1}>
          <Text dimColor>Loading models.dev catalog…</Text>
        </Box>
      ) : null}

      {panel.view === 'provider' && provider ? (
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

      {panel.view === 'oauth' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            ⚠ Subscription tokens used outside official clients may violate provider Terms —
          </Text>
          <Text color={UI_COLORS.warning} wrap="truncate-end">
            your account could be rate-limited or banned. An API key is the sanctioned path.
          </Text>
        </Box>
      ) : null}

      {panel.view === 'catalog' ? (
        <Box marginTop={1}>
          <Text>
            <Text dimColor>filter: </Text>
            {panel.filter.length > 0 ? panel.filter : <Text dimColor>(type to search)</Text>}
            <Text color={UI_COLORS.focused}>▏</Text>
          </Text>
        </Box>
      ) : null}

      {panel.view === 'flow' ? (
        <Box flexDirection="column" marginTop={1}>
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
            <Text color={panel.flowOk ? UI_COLORS.active : UI_COLORS.error}>
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
        <Box marginTop={1}>
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

      {panel.view !== 'flow' ? (
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
