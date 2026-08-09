import type { ProviderApiKey, ProviderConfig, WireFamily } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import { activeLabel, maskedKey, normalizeKeys } from '../provider-config-utils.js';
import type { AuthMenuDeps } from './types.js';

/* ------------------------------------------------------------------ */
/*  Rendering helpers                                                  */
/* ------------------------------------------------------------------ */

/** Render a provider entry line in the top-level listing. */
function renderProviderLine(
  renderer: AuthMenuDeps['renderer'],
  id: string,
  cfg: ProviderConfig,
  idx: number,
): void {
  const keys = normalizeKeys(cfg);
  const active = activeLabel(cfg, keys);
  const firstKey = keys[0];

  let summary: string;
  if (keys.length === 0) {
    summary = color.dim('(no keys)');
  } else if (keys.length === 1) {
    summary = maskedKey(firstKey?.apiKey ?? '');
  } else {
    const activeKeyObj = active != null ? keys.find((k) => k.label === active) : undefined;
    summary =
      `${color.dim(`${keys.length} keys`)} ` +
      `${color.dim('active:')} ${color.bold(active ?? '?')} ` +
      maskedKey(activeKeyObj?.apiKey ?? firstKey?.apiKey ?? '');
  }

  const fam = cfg.family ? color.dim(`[${cfg.family}]`) : '';
  const aliasHint = cfg.type && cfg.type !== id ? color.dim(`→ ${cfg.type}`) : '';

  renderer.write(
    `    ${color.dim(`${idx}.`.padStart(4))} ${id.padEnd(22)} ${fam} ${aliasHint} ${summary}\n`,
  );
}

/** Render the header for the provider management submenu. */
export function renderProviderHeader(
  renderer: AuthMenuDeps['renderer'],
  providerId: string,
  cfg: ProviderConfig,
): void {
  const keys = normalizeKeys(cfg);
  const active = activeLabel(cfg, keys);

  renderer.write(
    `\n${color.bold(providerId)} ` +
      `${cfg.family ? color.dim(`[${cfg.family}]`) : color.amber('[no family]')}\n`,
  );

  const details: string[] = [
    color.dim(`  type:    ${cfg.type ?? providerId}`),
    color.dim(`  family:  ${cfg.family ?? '(unset → resolved from models.dev when type matches)'}`),
    color.dim(`  baseUrl: ${cfg.baseUrl ?? '(unset → catalog default)'}`),
  ];

  if (cfg.envVars && cfg.envVars.length > 0) {
    details.push(color.dim(`  envVars: ${cfg.envVars.join(', ')}`));
  }
  if (cfg.models && cfg.models.length > 0) {
    details.push(color.dim(`  models:  ${cfg.models.join(', ')}`));
  }

  renderer.write(details.join('\n') + '\n');

  if (keys.length === 0) {
    renderer.write(color.dim('  (no keys saved)\n'));
  } else {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key) renderKeyLine(renderer, key, i + 1, active);
    }
  }
}

/** Render a single key entry line. */
function renderKeyLine(
  renderer: AuthMenuDeps['renderer'],
  key: ProviderApiKey,
  idx: number,
  active: string | undefined,
): void {
  const marker = key.label === active ? color.green('●') : color.dim('○');
  renderer.write(
    `  ${color.dim(`${idx}.`.padStart(4))} ${marker} ${key.label.padEnd(20)} ` +
      `${maskedKey(key.apiKey)}  ${color.dim(key.createdAt)}\n`,
  );
}

/** Render action shortcuts. */
export function renderActions(renderer: AuthMenuDeps['renderer'], keysLength: number): void {
  renderer.write(`\n  ${color.dim('Actions:')}\n`);
  renderer.write(`    ${color.bold('a')}        Add another key\n`);
  if (keysLength > 0) {
    renderer.write(`    ${color.bold('u')} <n>    Update key <n>\n`);
    renderer.write(`    ${color.bold('d')} <n>    Delete key <n>\n`);
    renderer.write(`    ${color.bold('s')} <n>    Set key <n> as active\n`);
  }
  renderer.write(`    ${color.bold('f')}        Edit family\n`);
  renderer.write(
    `    ${color.bold('B')}        Edit baseUrl ${color.dim('(capital B — b is Back)')}\n`,
  );
  renderer.write(`    ${color.bold('m')}        Edit visible model list\n`);
  renderer.write(`    ${color.bold('x')}        Remove this provider entirely\n`);
  renderer.write(`    ${color.bold('b')}        Back\n`);
  renderer.write(`    ${color.bold('q')}        Quit\n`);
}

/** Render the top-level menu header. */
export function renderTopMenu(
  renderer: AuthMenuDeps['renderer'],
  providers: Record<string, ProviderConfig>,
): void {
  renderer.write(`\n${color.bold('WrongStack')} ${color.dim('— API key manager')}\n\n`);

  const ids = Object.keys(providers).sort();
  if (ids.length === 0) {
    renderer.write(color.dim('  No providers configured yet.\n'));
    renderer.write(
      color.dim(
        '  Use (a) to add one from the models.dev catalog, (l) for a local server, or (c) for a custom provider.\n',
      ),
    );
  } else {
    renderer.write(`  ${color.dim('Saved providers:')}\n`);
    let idx = 1;
    for (const id of ids) {
      const cfg = providers[id];
      if (!cfg) continue;
      renderProviderLine(renderer, id, cfg, idx);
      idx++;
    }
  }

  renderer.write(`\n  ${color.dim('Actions:')}\n`);
  renderer.write(`    ${color.bold('a')}  Add a provider (from catalog)\n`);
  renderer.write(
    `    ${color.bold('l')}  Add a local server ${color.dim('(OmniRoute / Ollama / vLLM / LM Studio)')}\n`,
  );
  renderer.write(`    ${color.bold('c')}  Add a custom provider\n`);
  renderer.write(
    `    ${color.bold('s')}  Login with OAuth ${color.dim('(ChatGPT / Claude / Copilot)')}\n`,
  );
  if (ids.length > 0) {
    renderer.write(
      `    ${color.dim('1-')}${color.dim(String(ids.length))}  ${color.bold('Manage a provider')}\n`,
    );
  }
  renderer.write(`    ${color.bold('q')}  Quit\n`);
}

/* ------------------------------------------------------------------ */
/*  User input helpers                                                 */
/* ------------------------------------------------------------------ */

/** Prompt for a hidden API key. Returns undefined on empty input. */
export async function readKeyInput(
  deps: { reader: AuthMenuDeps['reader']; renderer: AuthMenuDeps['renderer'] },
  intent: string,
): Promise<string | undefined> {
  const key = (
    await deps.reader.readSecret(
      `  ${color.amber('?')} ${intent} ${color.dim('(hidden, paste OK)')}: `,
    )
  ).trim();
  if (!key) {
    deps.renderer.writeError('No key entered.');
    return undefined;
  }
  return key;
}

/**
 * Ask a yes/no confirmation. Returns:
 *   true  → user confirmed (y/yes)
 *   false → user declined (n/no)
 *   null  → user cancelled (q)
 */
export async function confirm(
  deps: { reader: AuthMenuDeps['reader']; renderer: AuthMenuDeps['renderer'] },
  question: string,
): Promise<boolean | null> {
  const answer = (
    await deps.reader.readLine(`  ${color.amber('?')} ${question} ${color.dim('[y/N/q]')} `)
  )
    .trim()
    .toLowerCase();
  if (answer === 'q' || answer === 'quit') return null;
  return answer === 'y' || answer === 'yes';
}

/** Suggest a default label that doesn't conflict with existing keys. */
export function suggestLabel(usedLabels: Set<string>): string {
  const candidate = 'default';
  if (!usedLabels.has(candidate)) return candidate;
  let n = 2;
  while (usedLabels.has(`key${n}`)) n++;
  return `key${n}`;
}

/** Validate a wire family string. Returns the WireFamily or null. */
export function validateFamily(raw: string): WireFamily | null {
  const valid: WireFamily[] = ['anthropic', 'openai', 'openai-compatible', 'google'];
  return valid.includes(raw as WireFamily) ? (raw as WireFamily) : null;
}
