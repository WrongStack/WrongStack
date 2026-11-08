/** A plugin an engine command can name: an official alias or a package name, never an option. */
const PLUGIN_SPEC = /^[@A-Za-z0-9][A-Za-z0-9@._/-]*$/;

/**
 * The plugin a field names, or undefined when it is not one. An option such as `--install`
 * would make `/plugin install` run a package manager, so a spec never starts with a dash and
 * never holds a space.
 */
export function pluginSpec(input: string): string | undefined {
  const spec = input.trim();
  return PLUGIN_SPEC.test(spec) ? spec : undefined;
}
