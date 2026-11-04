import type { DesktopCommand, DesktopCommandCategory } from './desktop-commands';
import type { useDesktopText } from './desktop-i18n';

type Translate = ReturnType<typeof useDesktopText>['t'];

/** The catalog key of a command's description: its name without the slash, `!` read as `-force`. */
export const commandTextKey = (name: string) => name.slice(1).replace(/!$/, '-force');

/**
 * A desktop command's description in the display language. Commands the catalog does not word
 * (the hunts, whose text comes from the shared hunt table, and any added later) keep the
 * command table's English.
 */
export const commandDescription = (
  command: Pick<DesktopCommand, 'name' | 'description'>,
  t: Translate,
) => t(`commandHelp.cmd.${commandTextKey(command.name)}`, { defaultValue: command.description });

/** A command category's heading in the display language. */
export const commandCategory = (category: DesktopCommandCategory, t: Translate) =>
  t(`commandHelp.category.${category}`, { defaultValue: category });
