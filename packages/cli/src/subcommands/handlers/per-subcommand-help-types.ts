/**
 * Data contract shared by the focused-help renderer and its leaf data tables.
 * Keeping this contract dependency-free prevents the tables from importing
 * their renderer and creating a module cycle.
 */
export interface PerSubcommandHelp {
  name: string;
  title: string;
  description: string;
  usage: string;
  subcommands?: ReadonlyArray<{ name: string; description: string }>;
  seeAlso?: string;
  customBody?: () => string;
}
