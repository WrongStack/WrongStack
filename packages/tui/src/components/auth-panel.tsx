import type React from 'react';
import { Box, Text, useStdout } from '../ink.js';
import {
  type AuthKeyRow,
  type AuthPanelRow,
  type AuthPanelState,
  authPanelRows,
  authSelectedProvider,
} from './auth-panel-model.js';

export interface AuthPanelProps {
  panel: AuthPanelState;
}

/**
 * Rows of chrome around the visible row window: the panel's own border /
 * title / legend / footer (~10) plus the collapsed input placeholder,
 * statusline and key-hint bar below (~8). Subtracted from `stdout.rows`
 * so the list never pushes the status area off-screen.
 */
const CHROME_ROWS = 18;

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
  remove: '✕ Remove this provider',
};

const OAUTH_LABEL: Record<string, { title: string; detail: string }> = {
  chatgpt: { title: 'ChatGPT Plus/Pro', detail: '→ openai-codex' },
  claude: { title: 'Claude Pro/Max', detail: '→ anthropic-oauth' },
  copilot: { title: 'GitHub Copilot', detail: '→ github-copilot' },
};

function keySummary(keyRow: AuthKeyRow): string {
  const method = keyRow.authMethod === 'oauth' ? ' oauth' : '';
  const created = keyRow.createdAt ? ` ${keyRow.createdAt.slice(0, 10)}` : '';
  return `${keyRow.masked}${method}${created}`;
}

function renderRow(row: AuthPanelRow, focused: boolean, i: number): React.ReactElement {
  const marker = focused ? '›' : ' ';
  const color = focused ? 'cyan' : undefined;
  switch (row.kind) {
    case 'provider': {
      const p = row.provider;
      const keys =
        p.keys.length === 0
          ? 'no keys'
          : p.keys.length === 1
            ? `1 key ${p.keys[0]?.masked ?? ''}`
            : `${p.keys.length} keys`;
      return (
        <Text key={`p-${p.id}`} color={color} wrap="truncate-end">
          {marker} {p.id.padEnd(22)} <Text dimColor>{(p.family ?? '—').padEnd(18)}</Text>{' '}
          <Text color={p.keys.length > 0 ? 'green' : 'yellow'}>{keys}</Text>
        </Text>
      );
    }
    case 'list-action':
      return (
        <Text key={`a-${row.action}`} color={color} wrap="truncate-end">
          {marker} {LIST_ACTION_LABEL[row.action]}
        </Text>
      );
    case 'key': {
      const k = row.keyRow;
      return (
        <Text key={`k-${k.label}`} color={color} wrap="truncate-end">
          {marker} <Text color={k.active ? 'green' : 'gray'}>{k.active ? '●' : '○'}</Text>{' '}
          {k.label.padEnd(20)} <Text dimColor>{keySummary(k)}</Text>
        </Text>
      );
    }
    case 'provider-action':
      return (
        <Text key={`pa-${row.action}`} color={color} wrap="truncate-end">
          {marker} {PROVIDER_ACTION_LABEL[row.action]}
        </Text>
      );
    case 'catalog-entry': {
      const c = row.entry;
      return (
        <Text key={`c-${c.id}`} color={color} wrap="truncate-end">
          {marker} <Text color={c.saved ? 'green' : 'gray'}>{c.saved ? '◉' : '○'}</Text>{' '}
          {c.id.padEnd(24)} <Text dimColor>{c.family.padEnd(20)}</Text>
          <Text dimColor>{c.name !== c.id ? c.name : ''}</Text>
        </Text>
      );
    }
    case 'local-preset': {
      const p = row.preset;
      return (
        <Text key={`l-${p.id}`} color={color} wrap="truncate-end">
          {marker} {p.label.padEnd(12)} <Text dimColor>{p.defaultBaseUrl.padEnd(28)}</Text>{' '}
          <Text dimColor>{p.noAuth ? 'no auth' : 'optional key'}</Text>
        </Text>
      );
    }
    case 'oauth-option': {
      const o = OAUTH_LABEL[row.oauth] ?? { title: row.oauth, detail: '' };
      return (
        <Text key={`o-${row.oauth}`} color={color} wrap="truncate-end">
          {marker} {o.title.padEnd(20)} <Text dimColor>{o.detail}</Text>
        </Text>
      );
    }
    default:
      return <Text key={`r-${i}`}> </Text>;
  }
}

function viewTitle(panel: AuthPanelState): string {
  switch (panel.view) {
    case 'list':
      return 'API keys & sign-in';
    case 'provider':
      return `Provider — ${panel.providerId ?? ''}`;
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
  const logWindow = panel.log.slice(-Math.max(6, maxVisible));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">
        {viewTitle(panel)}
      </Text>
      <Text dimColor>{viewLegend(panel)}</Text>

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
          <Text color="yellow" wrap="truncate-end">
            ⚠ Subscription tokens used outside official clients may violate provider Terms —
          </Text>
          <Text color="yellow" wrap="truncate-end">
            your account could be rate-limited or banned. An API key is the sanctioned path.
          </Text>
        </Box>
      ) : null}

      {panel.view === 'catalog' ? (
        <Box marginTop={1}>
          <Text>
            <Text dimColor>filter: </Text>
            {panel.filter.length > 0 ? panel.filter : <Text dimColor>(type to search)</Text>}
            <Text color="cyan">▏</Text>
          </Text>
        </Box>
      ) : null}

      {panel.view === 'flow' ? (
        <Box flexDirection="column" marginTop={1}>
          {logWindow.length === 0 && !panel.flowDone ? <Text dimColor>Starting…</Text> : null}
          {logWindow.map((line) => (
            <Text
              key={line}
              wrap="truncate-end"
              color={line.startsWith('✗') ? 'red' : line.startsWith('✓') ? 'green' : undefined}
              dimColor={!line.startsWith('✗') && !line.startsWith('✓')}
            >
              {line}
            </Text>
          ))}
          {panel.flowDone ? (
            <Text color={panel.flowOk ? 'green' : 'red'}>
              {panel.flowOk ? '✓ Done.' : '✗ Not completed.'}{' '}
              <Text dimColor>Press Enter or Esc to go back.</Text>
            </Text>
          ) : panel.input ? null : (
            <Text dimColor>… working (Esc to cancel)</Text>
          )}
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          {total === 0 ? (
            <Text dimColor>
              {panel.busy
                ? 'Loading…'
                : panel.view === 'catalog'
                  ? 'No catalog entries match.'
                  : 'Nothing here yet.'}
            </Text>
          ) : (
            <>
              {above > 0 ? <Text dimColor>{`  ↑ ${above} more`}</Text> : null}
              {allRows
                .slice(windowStart, windowEnd)
                .map((row, i) => renderRow(row, windowStart + i === panel.selected, i))}
              {below > 0 ? <Text dimColor>{`  ↓ ${below} more`}</Text> : null}
            </>
          )}
        </Box>
      )}

      {panel.input ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
        >
          <Text color="yellow" wrap="truncate-end">
            ? {panel.input.label}
          </Text>
          <Text>
            {panel.input.masked ? '•'.repeat(panel.input.draft.length) : panel.input.draft}
            <Text color="cyan">▏</Text>
            {panel.input.masked ? <Text dimColor> (hidden — paste OK)</Text> : null}
          </Text>
        </Box>
      ) : null}

      {panel.confirm ? (
        <Box marginTop={1}>
          <Text color="yellow" wrap="truncate-end">
            ? {panel.confirm.question} <Text dimColor>[y/N]</Text>
          </Text>
        </Box>
      ) : null}

      {panel.hint ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {panel.hint}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
