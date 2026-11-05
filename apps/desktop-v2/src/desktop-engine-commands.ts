import { useEffect } from 'react';
import {
  type DesktopCommandContext,
  type DesktopCommandOutcome,
  HANDLED,
  reason,
  refused,
} from './desktop-command-context';
import { type DesktopCommand, desktopCommands } from './desktop-commands';
import type { EngineCommand } from './engine-operations';
import type { EngineState } from './engine-state';
import { entries, record } from './engine-values';

/**
 * The TUI's commands the engine itself runs (`command.list` / `command.run`): /sandbox,
 * /prune, /init and the rest that need no terminal. They complete and run in the composer
 * like the desktop's own commands; a desktop command of the same name wins.
 */
export interface EngineCommandEntry {
  name: string;
  aliases: string[];
  description: string;
  argsHint: string;
  destructive: boolean;
}

/** The engine's commands as it last listed them; empty before the catalog arrives. */
function engineCommandEntries(state: EngineState): EngineCommandEntry[] {
  return entries(record(state.results['command.catalog'])['commands']).flatMap((item) =>
    typeof item['name'] === 'string' && item['name']
      ? [
          {
            name: item['name'],
            aliases: Array.isArray(item['aliases'])
              ? item['aliases'].filter((alias): alias is string => typeof alias === 'string')
              : [],
            description: typeof item['description'] === 'string' ? item['description'] : '',
            argsHint: typeof item['argsHint'] === 'string' ? item['argsHint'] : '',
            destructive: item['destructive'] === true,
          },
        ]
      : [],
  );
}

/** Engine commands shaped like desktop commands, skipping names the desktop already owns. */
export function engineCommands(
  state: EngineState,
  owned: readonly DesktopCommand[] = desktopCommands,
): DesktopCommand[] {
  const taken = new Set(owned.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  return engineCommandEntries(state).flatMap((entry) =>
    taken.has(`/${entry.name}`)
      ? []
      : [
          {
            name: `/${entry.name}`,
            aliases: entry.aliases.map((alias) => `/${alias}`).filter((alias) => !taken.has(alias)),
            description: entry.description,
            category: 'Tools' as const,
            usage: entry.argsHint || '[arguments]',
            action: 'engine' as const,
          },
        ],
  );
}

/** Asks the engine for its commands once it is connected; returns them as commands. */
export function useEngineCommands(
  engine: { command: EngineCommand; state: EngineState } | undefined,
): DesktopCommand[] {
  const command = engine?.command;
  const connected = engine?.state.connected === true;
  useEffect(() => {
    if (!command || !connected) return;
    // An engine without the command bridge never answers; the composer keeps its own commands.
    void command('command.list', {}, ['command.catalog']).catch(() => undefined);
  }, [command, connected]);
  return engine ? engineCommands(engine.state) : [];
}

/** Drafts of destructive commands that were shown once and wait for a second send. */
const armed = new Map<string, number>();
const CONFIRM_WINDOW_MS = 60_000;

/**
 * Runs an engine command and shows what it printed. A command that changes or deletes
 * something first says so and runs when the same draft is sent again; `--dry-run` runs at once.
 */
export function runEngineCommand(
  command: DesktopCommand,
  argument: string,
  context: DesktopCommandContext,
): DesktopCommandOutcome {
  const name = command.name.slice(1);
  const entry = engineCommandEntries(context.state).find((item) => item.name === name);
  const draft = `${command.name} ${argument}`.trim();
  if (entry?.destructive && !/(^|\s)--dry-run(\s|$)/.test(argument)) {
    const at = armed.get(draft);
    if (!at || Date.now() - at > CONFIRM_WINDOW_MS) {
      armed.set(draft, Date.now());
      return refused(
        `${draft} changes or deletes project data: ${entry.description} Send it again to run it.`,
      );
    }
    armed.delete(draft);
  }
  void context.command('command.run', { name, args: argument }, ['command.result']).then(
    (reply) => {
      if (typeof reply['error'] === 'string') return context.fail(reply['error']);
      const text = typeof reply['message'] === 'string' ? reply['message'].trim() : '';
      context.notify(text || `${command.name} finished.`);
      // A command may hand the agent a follow-up turn (`/tuneup deep`, `/init`).
      const followUp = typeof reply['runText'] === 'string' ? reply['runText'].trim() : '';
      if (followUp) context.prompt?.(followUp);
    },
    (error) => context.fail(reason(error)),
  );
  return HANDLED;
}
