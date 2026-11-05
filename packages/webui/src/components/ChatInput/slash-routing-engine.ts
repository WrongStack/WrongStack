import { safeId } from '@/lib/utils';
import { confirmModal } from '../ConfirmModal';
import type { ChatAssistantMessage, SlashRoutingClient } from './slash-routing-types.js';

/**
 * The TUI's commands the engine runs itself (`command.list` / `command.run`): /sandbox,
 * /prune, /init, /push, /security, the skill and prompt library commands and the rest that
 * need no terminal. The WebUI's own slash commands are routed first; these come after them,
 * before a draft would go to the model.
 */
interface EngineCommandEntry {
  name: string;
  aliases: string[];
  description: string;
  destructive: boolean;
}

let catalog: EngineCommandEntry[] = [];
let requested = false;

function entry(value: unknown): EngineCommandEntry | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  if (typeof item['name'] !== 'string' || !item['name']) return null;
  return {
    name: item['name'],
    aliases: Array.isArray(item['aliases'])
      ? item['aliases'].filter((alias): alias is string => typeof alias === 'string')
      : [],
    description: typeof item['description'] === 'string' ? item['description'] : '',
    destructive: item['destructive'] === true,
  };
}

/** Asks the engine for its commands once; later drafts read the cached list. */
export function requestEngineCommands(client: SlashRoutingClient | null | undefined): void {
  if (requested || !client?.on || !client.send) return;
  requested = true;
  const off = client.on('command.catalog', (message) => {
    off();
    const commands = (message.payload as { commands?: unknown } | undefined)?.commands;
    catalog = Array.isArray(commands)
      ? commands.map(entry).filter((item): item is EngineCommandEntry => item !== null)
      : [];
  });
  client.send({ type: 'command.list', payload: {} });
}

/** The engine's commands as slash suggestions, skipping names the WebUI already owns. */
/** A slash suggestion, shaped like the WebUI's own (`SlashCommandDef`) without importing it. */
interface EngineSlashSuggestion {
  name: string;
  aliases: string[];
  description: string;
  category: 'Inspect';
}

export function engineSlashCommands(
  owned: readonly { name: string; aliases?: readonly string[] | undefined }[],
): EngineSlashSuggestion[] {
  const taken = new Set(owned.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  return catalog.flatMap((item) =>
    taken.has(`/${item.name}`)
      ? []
      : [
          {
            name: `/${item.name}`,
            aliases: item.aliases.map((alias) => `/${alias}`),
            description: item.description,
            category: 'Inspect' as const,
          },
        ],
  );
}

/** The engine command a slash name names, by name or alias. */
function findEngineCommand(name: string): EngineCommandEntry | undefined {
  const bare = name.replace(/^\//, '').toLowerCase();
  return catalog.find((item) => item.name === bare || item.aliases.includes(bare));
}

/**
 * Runs an engine command and writes what it printed into the chat. A command that changes or
 * deletes data asks first; `--dry-run` runs at once. False when the engine has no such command.
 */
export function runEngineSlashCommand(
  cmd: string,
  args: string,
  client: SlashRoutingClient | null | undefined,
  addMessage: (message: ChatAssistantMessage) => void,
  /** Sends the follow-up turn a command asks for (`runText`), as the user would. */
  sendMsg?: ((content: string) => void) | undefined,
): boolean {
  const command = findEngineCommand(cmd);
  if (!command || !client?.on || !client.send) return false;
  const run = () => {
    const requestId = safeId();
    const off = client.on?.('command.result', (message) => {
      const payload = message.payload as Record<string, unknown> | undefined;
      if (payload?.['requestId'] !== requestId) return;
      off?.();
      const error = typeof payload['error'] === 'string' ? payload['error'] : '';
      const text = typeof payload['message'] === 'string' ? payload['message'].trim() : '';
      addMessage({
        role: 'assistant',
        content: error
          ? `⚠️ /${command.name}: ${error}`
          : text
            ? `\`\`\`text\n${text}\n\`\`\``
            : `/${command.name} finished.`,
      });
      const followUp = typeof payload['runText'] === 'string' ? payload['runText'].trim() : '';
      if (!error && followUp) sendMsg?.(followUp);
    });
    client.send?.({
      type: 'command.run',
      payload: client.withSession?.({ name: command.name, args, requestId }) ?? {
        name: command.name,
        args,
        requestId,
      },
    });
  };
  if (command.destructive && !/(^|\s)--dry-run(\s|$)/.test(args)) {
    void confirmModal({
      title: `Run /${command.name}?`,
      message: `${command.description} This changes or deletes project data.`,
      confirmLabel: 'Run',
      danger: true,
    }).then((ok) => {
      if (ok) run();
    });
  } else {
    run();
  }
  return true;
}
