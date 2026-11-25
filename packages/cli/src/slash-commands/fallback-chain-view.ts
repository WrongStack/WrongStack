import { runtimeFallbackChain, smartDefaultFallbackChain } from '@wrongstack/core/agent';
import { color } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';
import { refStaleModelListWarning } from './fallback-ref-validation.js';

export function renderFallbackView(opts: SlashCommandContext): string {
  const config = opts.configStore.get();
  const explicit = config.fallbackModels ?? [];
  const profiles = config.fallbackProfiles ?? {};
  const favorites = config.favoriteModels ?? [];
  const bridge = config.fallbackBridge?.trim();
  const auto = config.fallbackAuto !== false;
  // Mirror lastResortCap() normalization so the display never diverges
  // from the runtime: finite non-negative → floored; anything else → 12.
  const rawCap = config.fallbackMaxLastResortCandidates;
  const capValue =
    typeof rawCap === 'number' && Number.isFinite(rawCap) && rawCap >= 0 ? Math.floor(rawCap) : 12;
  const capLabel = capValue === 0 ? color.dim('disabled') : color.green(String(capValue));

  const filteredReason = (ref: string): string | undefined => refStaleModelListWarning(ref, config);
  const activeProfile =
    typeof config.fallbackProfile === 'string' &&
    Object.hasOwn(profiles, config.fallbackProfile) &&
    profiles[config.fallbackProfile]
      ? config.fallbackProfile
      : undefined;

  const lines = [
    `${color.bold('WrongStack')} ${color.dim('— Fallback chain')}`,
    '',
    `  ${color.bold('leader')}  ${color.cyan(`${config.provider}/${config.model}`)}`,
    `  ${color.bold('bridge')}  ${bridge ? color.cyan(bridge) : color.dim('(disabled)')}  ${color.dim('/fallback bridge set <provider/model>')}`,
    `  ${color.bold('profile')} ${activeProfile ? color.amber(activeProfile) : color.dim('(none)')}  ${color.dim('/fallback profile use <name> | none')}`,
    '',
  ];

  if (explicit.length > 0) {
    lines.push(
      `  ${color.bold('explicit chain')} ${color.dim('(tried in order after the leader)')}`,
    );
    explicit.forEach((ref, i) => {
      const note = filteredReason(ref);
      const suffix = note ? `  ${color.amber(`⚠ ${note}`)}` : '';
      lines.push(`    ${color.amber(String(i + 1).padStart(2))}. ${color.cyan(ref)}${suffix}`);
    });
  } else {
    lines.push(`  ${color.bold('explicit chain')} ${color.dim('(empty)')}`);
    const preview = auto ? smartDefaultFallbackChain(config) : [];
    if (auto) {
      if (preview.length > 0) {
        lines.push(`    ${color.dim('smart default (auto-derived):')}`);
        preview.forEach((ref, i) => {
          lines.push(`    ${color.dim(`${String(i + 1).padStart(2)}. ${ref}`)}`);
        });
      } else {
        lines.push(
          `    ${color.dim('smart default: nothing usable — add models to your providers or use /fallback add')}`,
        );
      }
    }
  }

  // The chain the agent will ACTUALLY rotate through, in order — the same
  // `resolveCandidates` call the fallback extension makes. The explicit list
  // above is only one input to it (bridge, selected profile, smart default,
  // `default`-profile depth and the last-resort sweep all layer in), so
  // rendering only the explicit list left the view describing something the
  // runtime does not do.
  const runtime: string[] = runtimeFallbackChain(config);
  lines.push(
    '',
    `  ${color.bold('effective order')} ${color.dim('(what will actually be tried)')}`,
  );
  if (runtime.length === 0) {
    lines.push(
      `    ${color.red('empty')} ${color.dim('— a failure on the leader has nowhere to go')}`,
    );
  } else {
    runtime.forEach((ref, i) => {
      lines.push(`    ${color.amber(String(i + 1).padStart(2))}. ${color.cyan(ref)}`);
    });
  }

  const gateSec = config.fallbackGateSeconds ?? 7;
  const gateLabel =
    config.fallbackGateSeconds === 0
      ? color.dim('off (immediate auto-switch)')
      : color.green(`${gateSec}s`);

  lines.push(
    '',
    `  ${color.bold('auto')}  ${auto ? color.green('on') : color.dim('off')}  ${color.dim('/fallback auto on|off')}`,
    `  ${color.bold('favorites only')}  ${config.favoriteModelsOnly ? color.green('on') : color.dim('off')}  ${color.dim('/fallback fav only on|off')}`,
    `  ${color.bold('gate countdown')}  ${gateLabel}  ${color.dim('/fallback gate <seconds|off>')}`,
    `  ${color.bold('last-resort cap')}  ${capLabel}  ${color.dim('(max auto-discovered models appended, 0=disabled)')}`,
    '',
    `  ${color.bold('profiles')} ${Object.keys(profiles).length ? '' : color.dim('(none)')}`,
    ...Object.entries(profiles)
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, chain]) => {
        if (!chain || chain.length === 0) {
          return [`    ${color.amber(name)} → ${color.dim('(empty)')}`];
        }
        return [
          `    ${color.amber(name)} →`,
          ...chain.map((ref) => {
            const note = filteredReason(ref);
            const suffix = note ? `  ${color.amber(`⚠ ${note}`)}` : '';
            return `      ${color.cyan(ref)}${suffix}`;
          }),
        ];
      }),
    '',
    `  ${color.bold('favorites')} ${favorites.length ? '' : color.dim('(none)')}`,
    ...favorites.map((ref, i) => {
      const note = filteredReason(ref);
      const suffix = note ? `  ${color.amber(`⚠ ${note}`)}` : '';
      return `    ${color.amber(String(i + 1).padStart(2))}. ${color.cyan(ref)}${suffix}`;
    }),
    '',
    color.dim('  /fallback add <provider/model> · profile set fallback1 a,b · fav add a/b · help'),
  );
  return lines.join('\n');
}
