import { ICON_SETTINGS, type IconSetting, parseIconSetting } from '@wrongstack/contracts/types';

/** Same name `ui-glyphs.ts` in @wrongstack/tui reads (not imported: the TUI is not loaded yet). */
const ICONS_ENV = 'WSTACK_ICONS';

export type IconsSettingResult =
  | { ok: true; icons: IconSetting | undefined }
  | { ok: false; error: string };

/**
 * Resolves the TUI icon set (`--icons` > `WSTACK_ICONS` > legacy
 * `WRONGSTACK_TUI_ICON_STYLE` > `Config.icons` > auto) into `WSTACK_ICONS`.
 *
 * The TUI picks its glyph tables once, when its module loads, from that env
 * var; writing it here (after config load, before the TUI is imported) is what
 * lets a config value take effect, and child `wstack` processes inherit it.
 * A legacy `WRONGSTACK_TUI_ICON_STYLE` or `--ascii` is an explicit environment
 * choice, so the config value does not override it.
 */
export function applyIconsSetting(
  flags: Record<string, unknown>,
  configIcons: unknown,
  env: NodeJS.ProcessEnv = process.env,
): IconsSettingResult {
  const flag = flags['icons'];
  if (flag !== undefined) {
    const icons = parseIconSetting(flag);
    if (!icons) {
      return {
        ok: false,
        error: `--icons expects one of ${ICON_SETTINGS.join(', ')} (got ${JSON.stringify(flag)})`,
      };
    }
    env[ICONS_ENV] = icons;
    return { ok: true, icons };
  }
  const fromEnv = parseIconSetting(env[ICONS_ENV]);
  if (fromEnv) return { ok: true, icons: fromEnv };
  if (env['WRONGSTACK_TUI_ICON_STYLE']?.trim()) return { ok: true, icons: undefined };
  const fromConfig = parseIconSetting(configIcons);
  if (fromConfig) env[ICONS_ENV] = fromConfig;
  return { ok: true, icons: fromConfig };
}
