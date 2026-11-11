import type { PluginUiTone, PluginViewNode, SlashCommand } from '@wrongstack/contracts/types';
import type { PluginUiRegistry } from '@wrongstack/core/plugin';
import { color, sanitizeTerminalText, toErrorMessage } from '@wrongstack/core/utils';
import type { PluginManagementCommandHost, SessionCommandHost } from './host.js';

export type PanelCommandHost = Pick<PluginManagementCommandHost, 'pluginUiRegistry'> &
  Pick<SessionCommandHost, 'onPanelOpen'>;

export const PANEL_COMMAND_DESCRIPTION =
  'Inspect and interact with declarative plugin UI panels and status chips.';

export const PANEL_COMMAND_ARGS_HINT =
  '[list | open [panel-id] | show <panel-id> | action <panel-id> <action-id>]';

export const PANEL_COMMAND_HELP = [
  'Usage:',
  '  /panel                              Open interactive plugin panel overlay (or list panels)',
  '  /panel list                         List registered plugin panels and status chips',
  '  /panel open [panel-id]              Open the TUI plugin panel overlay on a panel',
  '  /panel show <panel-id>              Render a plugin panel as structured text',
  '  /panel action <panel-id> <action>   Trigger a declared panel action and re-render',
].join('\n');

function resolveUiRegistry(host: PanelCommandHost): PluginUiRegistry | undefined {
  if (typeof host.pluginUiRegistry === 'function') {
    return host.pluginUiRegistry();
  }
  return host.pluginUiRegistry;
}

function styleByTone(text: string, tone?: PluginUiTone): string {
  switch (tone) {
    case 'accent':
    case 'info':
      return color.cyan(text);
    case 'success':
      return color.green(text);
    case 'warning':
      return color.yellow(text);
    case 'danger':
      return color.red(text);
    case 'neutral':
      return color.dim(text);
    default:
      return text;
  }
}

/**
 * Render any host-neutral `PluginViewNode` tree into sanitized terminal/plain text
 * for CLI, REPL, WebUI text fallback, and ACP surfaces.
 */
export function formatPluginViewNodeText(node: PluginViewNode, indent = ''): string {
  switch (node.kind) {
    case 'text': {
      const safe = sanitizeTerminalText(node.text);
      const toned = node.dim ? color.dim(safe) : styleByTone(safe, node.tone);
      return `${indent}${node.bold ? color.bold(toned) : toned}`;
    }
    case 'kv': {
      if (node.items.length === 0) return `${indent}${color.dim('(no entries)')}`;
      const maxKey = Math.min(
        28,
        node.items.reduce((acc, item) => Math.max(acc, sanitizeTerminalText(item.label).length), 0),
      );
      return node.items
        .map((item) => {
          const key = `${sanitizeTerminalText(item.label)}:`.padEnd(maxKey + 1);
          const val = styleByTone(sanitizeTerminalText(item.value), item.tone);
          return `${indent}${color.dim(key)} ${val}`;
        })
        .join('\n');
    }
    case 'table': {
      if (node.columns.length === 0) return `${indent}${color.dim('(empty table)')}`;
      const cols = node.columns.map((c) => sanitizeTerminalText(c));
      const rows = node.rows
        .slice(0, node.maxRows ?? 50)
        .map((r) => cols.map((_, idx) => sanitizeTerminalText(r[idx] ?? '')));
      const widths = cols.map((col, idx) =>
        Math.min(
          36,
          rows.reduce((max, row) => Math.max(max, (row[idx] ?? '').length), col.length),
        ),
      );
      const header = `${indent}${cols.map((col, idx) => color.bold(col.padEnd(widths[idx]!))).join('  ')}`;
      const divider = `${indent}${widths.map((w) => '─'.repeat(Math.max(1, w))).join('  ')}`;
      const body = rows.map(
        (row) =>
          `${indent}${row.map((cell, idx) => cell.slice(0, widths[idx]!).padEnd(widths[idx]!)).join('  ')}`,
      );
      return [header, divider, ...body].join('\n');
    }
    case 'badges': {
      if (node.badges.length === 0) return `${indent}${color.dim('(no badges)')}`;
      const rendered = node.badges.map((b) =>
        styleByTone(`[${sanitizeTerminalText(b.label)}]`, b.tone),
      );
      return `${indent}${rendered.join(' ')}`;
    }
    case 'progress': {
      const ratio =
        node.total > 0 && Number.isFinite(node.current)
          ? Math.max(0, Math.min(1, node.current / node.total))
          : 0;
      const barWidth = 16;
      const filled = Math.round(ratio * barWidth);
      const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
      const pct = `${Math.round(ratio * 100)}%`;
      return `${indent}${sanitizeTerminalText(node.label)}: ${styleByTone(bar, node.tone)} ${pct} (${node.current}/${node.total})`;
    }
    case 'code': {
      const header = node.language
        ? `${indent}${color.dim(`── ${sanitizeTerminalText(node.language)} ──`)}\n`
        : '';
      const lines = sanitizeTerminalText(node.content)
        .split('\n')
        .slice(0, node.maxLines ?? 120)
        .map((line) => `${indent}  ${line}`)
        .join('\n');
      return `${header}${lines}`;
    }
    case 'markdown': {
      return sanitizeTerminalText(node.content)
        .split('\n')
        .map((line) => `${indent}${line}`)
        .join('\n');
    }
    case 'log': {
      if (node.lines.length === 0) return `${indent}${color.dim('(no log entries)')}`;
      return node.lines
        .map((entry) => {
          const ts = entry.ts ? `${color.dim(sanitizeTerminalText(entry.ts))} ` : '';
          const msg = styleByTone(sanitizeTerminalText(entry.text), entry.level);
          return `${indent}${ts}${msg}`;
        })
        .join('\n');
    }
    case 'stack': {
      const joiner = node.direction === 'horizontal' ? '  ' : (node.gap ?? 0) > 0 ? '\n\n' : '\n';
      return node.children
        .map((child) =>
          formatPluginViewNodeText(child, node.direction === 'horizontal' ? '' : indent),
        )
        .filter((part) => part.length > 0)
        .join(joiner);
    }
  }
}

export function buildPanelCommand(host: PanelCommandHost): SlashCommand {
  return {
    name: 'panel',
    category: 'Inspect',
    description: PANEL_COMMAND_DESCRIPTION,
    argsHint: PANEL_COMMAND_ARGS_HINT,
    help: PANEL_COMMAND_HELP,
    async run(rawArgs) {
      const rawTokens = rawArgs.trim().split(/\s+/).filter(Boolean);
      const jsonMode = rawTokens.includes('--json');
      const tokens = rawTokens.filter((tok) => tok !== '--json');
      const registry = resolveUiRegistry(host);
      if (!registry) {
        return {
          message: jsonMode
            ? JSON.stringify({ statusChips: [], panels: [], unavailable: true })
            : color.yellow('Plugin UI panels are unavailable in this session.'),
        };
      }

      const serializeCatalog = () => ({
        statusChips: registry.listStatusChips(),
        panels: registry.listPanels().map((p) => ({
          qualifiedId: p.qualifiedId,
          owner: p.owner,
          id: p.id,
          title: p.title,
          actions: p.actions,
        })),
      });

      const sub = tokens[0];
      if (sub === 'help' || sub === '--help' || sub === '-h') {
        return { message: PANEL_COMMAND_HELP };
      }

      if (!jsonMode && (!sub || sub === 'open')) {
        const targetId = sub === 'open' ? tokens[1] : undefined;
        const panels = registry.listPanels();
        if (panels.length > 0) {
          const action = targetId ? `plugin-panel:${targetId}` : 'plugin-panel';
          if (host.onPanelOpen?.current?.(action)) {
            return {};
          }
        }
        if (targetId) {
          const found = panels.find((p) => p.id === targetId || p.qualifiedId === targetId);
          if (!found) {
            return { message: color.red(`Unknown plugin panel: "${targetId}".`) };
          }
          const rendered = await found.render();
          return {
            message: [
              color.bold(`${found.title} (${found.qualifiedId})`),
              formatPluginViewNodeText(rendered),
            ].join('\n'),
          };
        }
      }

      if (!sub || sub === 'list' || sub === 'ls') {
        if (jsonMode) {
          return { message: JSON.stringify(serializeCatalog()) };
        }
        const panels = registry.listPanels();
        const chips = registry.listStatusChips();
        if (panels.length === 0 && chips.length === 0) {
          return { message: color.dim('No plugin UI panels or status chips registered.') };
        }
        const lines: string[] = [];
        if (panels.length > 0) {
          lines.push(color.bold(`Plugin Panels (${panels.length}):`));
          for (const p of panels) {
            const actionHints =
              p.actions.length > 0
                ? ` · actions: ${p.actions.map((a) => `${a.id}${a.shortcut ? ` [${a.shortcut}]` : ''}`).join(', ')}`
                : '';
            lines.push(
              `  • ${color.cyan(p.qualifiedId)} — ${p.title} ${color.dim(`(owner: ${p.owner})`)} ${color.dim(actionHints)}`.trimEnd(),
            );
          }
        }
        if (chips.length > 0) {
          if (lines.length > 0) lines.push('');
          lines.push(color.bold(`Plugin Status Chips (${chips.length}):`));
          for (const c of chips) {
            const label = `${c.icon ? `${c.icon} ` : ''}${c.text}`;
            lines.push(`  • ${color.cyan(c.qualifiedId)}: ${styleByTone(label, c.tone)}`);
          }
        }
        return { message: lines.join('\n') };
      }

      if (sub === 'action') {
        const panelRef = tokens[1];
        const actionId = tokens[2];
        if (!panelRef || !actionId) {
          return { message: color.red('Usage: /panel action <panel-id> <action-id>') };
        }
        const found = registry
          .listPanels()
          .find((p) => p.qualifiedId === panelRef || p.id === panelRef);
        if (!found) {
          return { message: color.red(`Unknown plugin panel: "${panelRef}".`) };
        }
        if (!found.onAction) {
          return {
            message: color.yellow(
              `Panel "${found.qualifiedId}" does not declare an action handler.`,
            ),
          };
        }
        try {
          await found.onAction(actionId);
          const rendered = await found.render();
          if (jsonMode) {
            return {
              message: JSON.stringify({
                ...serializeCatalog(),
                activePanel: {
                  qualifiedId: found.qualifiedId,
                  owner: found.owner,
                  id: found.id,
                  title: found.title,
                  actions: found.actions,
                  view: rendered,
                },
              }),
            };
          }
          return {
            message: [
              color.green(`✓ Executed action "${actionId}" on ${found.qualifiedId}.`),
              formatPluginViewNodeText(rendered),
            ].join('\n'),
          };
        } catch (err) {
          return {
            message: jsonMode
              ? JSON.stringify({ error: toErrorMessage(err) })
              : color.red(`Panel action failed: ${toErrorMessage(err)}`),
          };
        }
      }

      const panelRef = sub === 'show' ? tokens[1] : sub;
      if (!panelRef) {
        return { message: color.red('Usage: /panel show <panel-id>') };
      }
      const found = registry
        .listPanels()
        .find((p) => p.qualifiedId === panelRef || p.id === panelRef);
      if (!found) {
        return {
          message: jsonMode
            ? JSON.stringify({ error: `Unknown plugin panel: "${panelRef}".` })
            : color.red(`Unknown plugin panel: "${panelRef}".`),
        };
      }
      const rendered = await found.render();
      if (jsonMode) {
        return {
          message: JSON.stringify({
            ...serializeCatalog(),
            activePanel: {
              qualifiedId: found.qualifiedId,
              owner: found.owner,
              id: found.id,
              title: found.title,
              actions: found.actions,
              view: rendered,
            },
          }),
        };
      }
      const actionLine =
        found.actions.length > 0
          ? color.dim(
              `Actions: ${found.actions.map((a) => `${a.id} (${a.label}${a.shortcut ? ` [${a.shortcut}]` : ''})`).join(' · ')}`,
            )
          : undefined;
      return {
        message: [
          color.bold(`━━ ${found.title} (${found.qualifiedId}) ━━`),
          formatPluginViewNodeText(rendered),
          ...(actionLine ? [actionLine] : []),
        ].join('\n'),
      };
    },
  };
}
