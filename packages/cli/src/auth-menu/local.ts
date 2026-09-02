/**
 * `wstack auth local` — quick-add shortcut for local-LLM servers.
 *
 * Three servers are first-class: Ollama, vLLM, LM Studio. They share an
 * OpenAI-compatible wire format at `/v1/chat/completions`, so each entry
 * here just declares the defaults that the matching wire preset
 * (see `@wrongstack/providers/src/presets/local-llm.ts`) expects.
 *
 * Difference that matters at the config layer:
 *   - Ollama  → no auth (the server rejects any Authorization header).
 *   - vLLM    → optional Bearer auth; key is left blank when auth is
 *               disabled on the server, so the prompt is "Enter to skip".
 *   - LM Studio → same as vLLM (optional Bearer).
 *
 * Selection is interactive by default — the user picks `1/2/3` from a
 * numbered list. A direct path is also exposed for scripting via the
 * `--name <ollama|vllm|lmstudio>` flag.
 *
 * Before saving, the shortcut runs a health probe (`GET /v1/models`)
 * to verify the server is actually reachable. The probe is opt-out via
 * `--no-probe`; failures are non-fatal by default — the user is asked
 * whether to save anyway. Every log line is run through the shared
 * `SecretScrubber` before reaching the renderer, so a Bearer token
 * accidentally captured in a probe log can never echo to the terminal
 * in plaintext.
 */

import { DefaultSecretScrubber } from '@wrongstack/core/security';
import type { SecretScrubber } from '@wrongstack/core/types';
import { color } from '@wrongstack/core/utils';
import type { ProbeOptions, ProbeResult } from '@wrongstack/runtime/probe';
import { probeLocalLlm } from '@wrongstack/runtime/probe';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import {
  type AuthAuditEvent,
  type AuthAuditLogger,
  decideAuthLocalEvents,
  NOOP_AUDIT_LOGGER,
} from './auth-menu-audit.js';
import { loadProviders } from './helpers.js';
import { LOCAL_LLM_PRESETS, type LocalLlmPresetEntry } from './local-presets.js';

export type { LocalLlmPresetEntry } from './local-presets.js';
import { suggestLabel } from './shared.js';
import type { AuthMenuDeps } from './types.js';

// Re-export from the runtime package so consumers (CLI tests, the
// top-level CLI barrel) keep a stable import path. The runtime
// package owns the canonical implementation — the WebUI server
// imports from there too, so the probe runs in both contexts without
// pulling the full CLI into the WebUI dependency graph.
// Preset data + type live in a dependency-free module so the startup
// provider picker can import them without pulling in the probe/config
// machinery this file depends on. Re-exported here to keep the public
// import path (`@wrongstack/cli` barrel, tests) stable.
export { LOCAL_LLM_PRESETS, type ProbeOptions, type ProbeResult, probeLocalLlm };

const PRESET_BY_ID = new Map(LOCAL_LLM_PRESETS.map((p) => [p.id, p]));

export interface RunAuthLocalOptions {
  /**
   * Direct pick: skip the interactive menu and configure this preset.
   * `wstack auth local --name ollama` maps to `{ name: 'ollama' }`.
   */
  name?: string | undefined;
  /**
   * Override the default base URL. Empty / undefined falls back to the
   * preset's `defaultBaseUrl`.
   */
  baseUrl?: string | undefined;
  /**
   * Optional key to save. When omitted, the shortcut prompts the user
   * (unless the preset is `noAuth: true`).
   */
  apiKey?: string | undefined;
  /**
   * Optional label for the saved key. Defaults to "default" (matching
   * `addKeyForProvider` and `runAuthDirect`).
   */
  label?: string | undefined;
  /**
   * Force-skip the key prompt even for presets that normally accept a
   * key. Useful for scripting `wstack auth local --name ollama --no-key`
   * so no TTY input is required.
   */
  skipKey?: boolean | undefined;
  /**
   * Skip the reachability probe entirely. Use for scripting when the
   * local server may not be running yet (e.g. CI installing Ollama in
   * the background) but the user still wants the config in place.
   */
  noProbe?: boolean | undefined;
  /**
   * Run the probe and report, but don't save. Useful for re-checking a
   * previously-saved local provider.
   */
  probeOnly?: boolean | undefined;
  /**
   * Inject a custom `fetch` (test seam). Defaults to the global one.
   */
  fetchImpl?: typeof fetch | undefined;
  /**
   * Probe timeout override (test seam). Defaults to {@link PROBE_TIMEOUT_MS}.
   */
  probeTimeoutMs?: number | undefined;
  /**
   * Pre-populate `providers[id].models` so the user can launch
   * `wstack --provider <id> --model <picked>` right after the shortcut
   * completes. Four shapes are accepted:
   *
   *   - `undefined` (or omitted) → don't touch `cfg.models`.
   *   - `'first'` → take the first model id from the probe.
   *   - `<N>` (a positive integer string) → take the first N ids.
   *     Caps at the available list size.
   *   - Anything else → treated as a literal comma-separated list of
   *     model ids. Used verbatim, ignoring the probe result.
   *
   * When the probe didn't run (`noProbe: true`) or failed, only the
   * literal-list shape is meaningful — the count-based shapes return
   * an empty list and the shortcut proceeds without writing models.
   */
  models?: string | undefined;
  /**
   * Audit logger (test seam). When supplied, the function emits
   * structured `auth.local.*` events for the save lifecycle:
   * `add` / `clear` / `undo` / `probe_skip` / `probe_failed_save`.
   * The default is a no-op logger (production usage in
   * `wstack auth local` doesn't currently wire one — the WS server
   * is the source of truth for the dedicated `provider.*` message
   * types on the WebUI side; this option exists so the
   * integration test can capture the CLI flow's events for
   * end-to-end verification).
   */
  audit?: AuthAuditLogger | undefined;
}

/**
 * Quick-add entry point. Returns 0 on success, 1 on a hard error.
 *
 * The exit-code semantics are:
 *   - 0 → provider saved (or `probeOnly` ran successfully / user
 *         canceled with no state change / user declined save after
 *         probe failure)
 *   - 1 → hard failure: unknown --name, mutate threw, etc.
 */
export async function runAuthLocal(
  deps: AuthMenuDeps,
  opts: RunAuthLocalOptions = {},
): Promise<number> {
  const scrubber = deps.secretScrubber ?? new DefaultSecretScrubber();
  const audit: AuthAuditLogger = opts.audit ?? NOOP_AUDIT_LOGGER;

  const preset = opts.name ? PRESET_BY_ID.get(opts.name.toLowerCase()) : undefined;
  if (opts.name && !preset) {
    deps.renderer.writeError(
      `Unknown local server "${opts.name}". Valid: ${LOCAL_LLM_PRESETS.map((p) => p.id).join(', ')}.`,
    );
    return 1;
  }

  const chosen = preset ?? (await pickLocalPreset(deps));
  if (!chosen) {
    // Picker returns undefined on either user-cancel (`q`) or an
    // unknown-selection. Both cases have already been reported to the
    // user via the renderer; there's no error state to surface.
    return 0;
  }

  // Resolve the base URL — user override, then preset default.
  const baseUrl = opts.baseUrl?.trim() || chosen.defaultBaseUrl;

  // Resolve the key — non-interactive path when caller provided it,
  // else prompt (unless the preset is noAuth and the user didn't opt
  // out of the prompt via --no-key).
  let apiKey: string | undefined;
  if (opts.apiKey !== undefined) {
    apiKey = opts.apiKey.trim() || undefined;
  } else if (chosen.noAuth) {
    apiKey = undefined;
  } else if (opts.skipKey) {
    apiKey = undefined;
  } else {
    apiKey = await promptOptionalKey(deps, chosen);
  }

  // ── Health probe ───────────────────────────────────────────────────────
  // Run unless the user explicitly disabled it. On failure, prompt
  // before saving — local servers being down is a common cause of
  // "why isn't anything working" and we'd rather catch it here.
  // The probe result is captured (not just inspected) because the
  // --model flag consumes its modelIds below.
  let probe: ProbeResult | undefined;
  let probeFailedAndSaved = false;
  if (!opts.noProbe) {
    probe = await probeLocalLlm({
      baseUrl,
      apiKey,
      noAuth: chosen.noAuth,
      presetLabel: chosen.label,
      scrubber,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.probeTimeoutMs,
    });

    renderProbeResult(deps, probe);

    if (opts.probeOnly) {
      // Don't save — just report. Exit 0 is correct: we did exactly
      // what the user asked.
      return 0;
    }

    if (!probe.ok) {
      if (chosen.noAuth) {
        // Keyless loopback gateway (OmniRoute / Ollama): there's no
        // credential to validate, and these are meant to be configured
        // ahead of the server being up — OmniRoute auto-discovers its
        // model list at boot. Skip the "Save anyway?" detour entirely and
        // save with an informational note rather than nagging the user.
        deps.renderer.write(
          color.dim(
            `  Saving ${chosen.label} anyway — keyless local gateway needs no key ` +
              'and discovers models when it comes up.\n',
          ),
        );
        probeFailedAndSaved = true;
      } else {
        const saveAnyway = await promptSaveAnyway(deps);
        if (!saveAnyway) {
          deps.renderer.write(color.dim('  Cancelled. Nothing saved.\n'));
          return 0;
        }
        probeFailedAndSaved = true;
      }
    }
  }

  // Resolve the model list once — passed to the save block below and
  // used for the "Launch:" hint so the user can copy-paste a working
  // command after the shortcut completes. `probe` may be undefined
  // (when --no-probe was passed); resolveModelList handles that.
  const resolvedModels = resolveModelList(opts.models, probe, scrubber);

  // Resolve the label (used for the key entry — always present so the
  // saved shape matches the rest of the config, even when apiKey is
  // undefined).
  const label = opts.label?.trim() || 'default';

  const providers = await loadProviders(deps);
  const existing = providers[chosen.id];
  // Capture the previous models list BEFORE the mutate, so the
  // audit-log decision (add vs clear vs undo) can compare
  // against the pre-save state. The list is defensive-copied
  // because `mutateConfigProviders` mutates `p.models` in
  // place, and the capture must survive that mutation.
  const previousModels: string[] | undefined = existing?.models
    ? [...existing.models]
    : existing?.models === undefined
      ? undefined
      : [...existing.models];
  const usedLabels = new Set(existing ? normalizeKeys(existing).map((k) => k.label) : []);
  let finalLabel = label;
  if (usedLabels.has(finalLabel)) {
    let n = 2;
    while (usedLabels.has(`${label}-${n}`)) n++;
    finalLabel = `${label}-${n}`;
    deps.renderer.writeInfo(`Label collided; saving as "${finalLabel}".`);
  }

  try {
    await mutateConfigProviders(
      deps.profileConfigPath,
      deps.vault,
      (all) => {
        const p = all[chosen.id] ?? { type: chosen.id };
        if (!p.type) p.type = chosen.id;
        // Wire family is always openai-compatible for these three.
        if (!p.family) p.family = 'openai-compatible';
        if (!p.baseUrl) p.baseUrl = baseUrl;
        // vLLM and LM Studio both rely on the `openai-compatible` family
        // for the right token-limit param. No env vars to probe — local
        // servers don't read process env for auth.
        if (!p.envVars) p.envVars = [];

        // Pre-populate `models` when the user passed --model. Three
        // shapes from the resolver:
        //   - `null`  → flag not passed; don't touch p.models
        //   - `[]`    → empty list (user passed --model "" to clear)
        //   - non-empty → overwrite with the resolved list
        // The merge is intentionally write-on-write: the user's
        // explicit --model value always wins over any pre-existing
        // models entry. To preserve an existing list, simply omit the
        // flag.
        if (resolvedModels !== null) {
          p.models = [...resolvedModels];
        }

        if (apiKey) {
          const list = normalizeKeys(p);
          list.push({ label: finalLabel, apiKey, createdAt: nowIso() });
          writeKeysBack(p, list);
          if (!p.activeKey) p.activeKey = finalLabel;
        }
        all[chosen.id] = p;
      },
      deps.profileConfigPath,
    );
  } catch (err) {
    deps.renderer.writeError(`Failed to save ${chosen.id}: ${(err as Error).message}`);
    return 1;
  }

  // ── Audit-log emit ─────────────────────────────────────────────────────
  // The `decideAuthLocalEvents` helper is a pure function that
  // maps (previous state, new state, probe outcome) → event
  // list. The lifecycle events mirror the WebUI's
  // `provider.clear_models` / `provider.undo_clear` message
  // types so the two surfaces share an audit-log vocabulary.
  const events: AuthAuditEvent[] = decideAuthLocalEvents({
    providerId: chosen.id,
    baseUrl,
    previousModels,
    newModels: resolvedModels,
    keyLabel: apiKey ? finalLabel : undefined,
    probeFailedSave:
      probeFailedAndSaved && probe
        ? {
            status: probe.status,
            ...(probe.detail !== undefined ? { detail: probe.detail } : {}),
          }
        : undefined,
  });
  for (const event of events) {
    audit.emit(event);
  }

  if (apiKey) {
    deps.renderer.write(
      `  ${color.green('✓')} Saved ${color.bold(chosen.id)}/${color.bold(finalLabel)} ` +
        `→ ${color.cyan(baseUrl)}\n`,
    );
  } else {
    deps.renderer.write(
      `  ${color.green('✓')} Saved ${color.bold(chosen.id)} ` +
        `(no key) → ${color.cyan(baseUrl)}\n`,
    );
  }

  // When --model resolved to a non-empty list, the user can copy-paste
  // the first id straight into --model. When the resolver returned
  // null (no flag passed) or [] (empty literal), keep the placeholder
  // hint so the UX stays informative.
  const firstModel = resolvedModels && resolvedModels.length > 0 ? resolvedModels[0] : null;
  const modelHint = firstModel ? color.cyan(firstModel) : color.dim('<model-id>');

  deps.renderer.write(
    color.dim(`  Launch: wstack --provider ${chosen.id} --model ${modelHint} "<task>"\n`),
  );
  return 0;
}

/**
 * Resolve the user-supplied `models` option against the probe result.
 *
 *   - `undefined`        → null (don't write `cfg.models`)
 *   - `'first'`          → first probe id, or null if probe failed
 *   - `<positive int>`   → first N probe ids, or null if probe failed
 *   - literal csv        → parsed list, ignoring the probe (the
 *                          user knows exactly which ids they want)
 *
 * Returns the resolved id list, or null when no `models` should be
 * written. Each entry is scrubbed before return — the user's literal
 * list could in theory contain a credential if they pasted it from
 * a config dump; better to scrub once here than risk echoing it back.
 */
export function resolveModelList(
  models: string | undefined,
  probe: ProbeResult | undefined,
  scrubber: SecretScrubber,
): string[] | null {
  if (models === undefined) return null;

  // The literal-list path: a positive integer is treated as a count
  // when the probe succeeded, otherwise we fall through to the literal
  // parser below. This keeps `'5'` from being interpreted as a model
  // id named "5" when a probe result is available.
  const trimmed = models.trim();
  if (trimmed.length === 0) return [];

  // The two probe-driven shapes need a successful probe with at least
  // one model id.
  const hasProbeIds = probe?.status === 'ok' && (probe.modelIds?.length ?? 0) > 0;
  const probeIds = hasProbeIds ? (probe?.modelIds ?? []) : [];

  if (trimmed === 'first') {
    if (probeIds.length === 0) return null;
    return [scrubber.scrub(probeIds[0]!)];
  }
  if (/^\d+$/.test(trimmed)) {
    if (probeIds.length === 0) return null;
    const n = Math.min(Number.parseInt(trimmed, 10), probeIds.length);
    return probeIds.slice(0, n).map((id) => scrubber.scrub(id));
  }

  // Literal CSV: split, trim, dedupe, scrub each, drop empties.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of trimmed.split(',')) {
    const id = scrubber.scrub(raw.trim());
    if (id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Render the probe result with consistent color/formatting. Always
 * passes the rendered string through the scrubber before writing.
 */
function renderProbeResult(
  deps: AuthMenuDeps,
  probe: ProbeResult,
  opts: { presetLabel?: string } = {},
): void {
  const label = opts.presetLabel ? ` ${color.bold(opts.presetLabel)}` : '';
  const elapsed = probe.elapsedMs !== undefined ? ` ${color.dim(`(${probe.elapsedMs}ms)`)}` : '';

  switch (probe.status) {
    case 'ok': {
      const models =
        probe.modelCount !== undefined
          ? color.dim(`, ${probe.modelCount} model${probe.modelCount === 1 ? '' : 's'}`)
          : '';
      deps.renderer.write(`  ${color.green('●')} ${label} health probe ok${models}${elapsed}\n`);
      break;
    }
    case 'timeout': {
      deps.renderer.write(
        `  ${color.red('●')} ${label} health probe timed out${elapsed}\n` +
          `    ${color.dim('The server did not respond within the timeout.')}\n` +
          `    ${color.dim('Is the local server running? Check the port and try again.')}\n`,
      );
      break;
    }
    case 'unreachable': {
      const detail = probe.detail ? ` ${color.dim(`(${probe.detail})`)}` : '';
      deps.renderer.write(
        `  ${color.red('●')} ${label} server unreachable${detail}\n` +
          `    ${color.dim('Could not connect. Common causes:')}\n` +
          `    ${color.dim('  - The local server is not running')}\n` +
          `    ${color.dim('  - The port is blocked by a firewall')}\n` +
          `    ${color.dim('  - The base URL is wrong')}\n`,
      );
      break;
    }
    case 'http_error': {
      const status = probe.httpStatus !== undefined ? ` HTTP ${probe.httpStatus}` : '';
      const detail = probe.detail ? ` ${color.dim(`— ${probe.detail}`)}` : '';
      deps.renderer.write(`  ${color.yellow('●')} ${label} health probe got${status}${detail}\n`);
      break;
    }
    case 'invalid_response': {
      deps.renderer.write(
        `  ${color.yellow('●')} ${label} health probe returned an unexpected shape\n` +
          (probe.detail ? `    ${color.dim(probe.detail)}\n` : ''),
      );
      break;
    }
    case 'skipped': {
      // Not currently emitted — kept for completeness in case we
      // wire a flag-driven skip in the future.
      break;
    }
  }
}

/**
 * After a failed probe, ask the user whether to save the provider
 * anyway. Default answer is N — so a misclick or piped input doesn't
 * silently create a broken config.
 */
async function promptSaveAnyway(deps: AuthMenuDeps): Promise<boolean> {
  const answer = (
    await deps.reader.readLine(
      `\n${color.amber('?')} ${color.bold('Save anyway?')} ` + `${color.dim('[y/N]')}: `,
    )
  )
    .trim()
    .toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/* -------------------------------------------------------------------------- */
/*  Interactive picker                                                         */
/* -------------------------------------------------------------------------- */

/** Show the picker, return the chosen preset or undefined on cancel. */
async function pickLocalPreset(deps: AuthMenuDeps): Promise<LocalLlmPresetEntry | undefined> {
  deps.renderer.write(
    `\n${color.bold('Local LLM servers')} ${color.dim('— pick one to pre-fill the base URL')}\n\n`,
  );

  let idx = 1;
  for (const entry of LOCAL_LLM_PRESETS) {
    const auth = entry.noAuth ? color.dim('(no auth)') : color.dim('(optional auth)');
    deps.renderer.write(
      `    ${color.dim(`${idx}.`.padStart(4))} ${color.bold(entry.label.padEnd(12))} ` +
        `${color.cyan(entry.defaultBaseUrl.padEnd(34))} ${auth}\n`,
    );
    deps.renderer.write(`        ${color.dim(entry.hint)}\n`);
    idx++;
  }

  const answer = (
    await deps.reader.readLine(
      `\n${color.amber('?')} Pick ${color.dim(`(1-${LOCAL_LLM_PRESETS.length}, q to quit)`)}: `,
    )
  )
    .trim()
    .toLowerCase();

  if (!answer || answer === 'q' || answer === 'quit') return undefined;

  const num = Number.parseInt(answer, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= LOCAL_LLM_PRESETS.length) {
    return LOCAL_LLM_PRESETS[num - 1];
  }
  const byId = LOCAL_LLM_PRESETS.find((p) => p.id === answer);
  if (byId) return byId;

  deps.renderer.writeError(`Unknown selection: "${answer}"`);
  return undefined;
}

/**
 * Prompt for a Bearer key with the option to skip (Enter on an empty
 * line). vLLM and LM Studio both run fine with auth disabled, so an
 * empty submit is a legitimate choice — it just means the shortcut
 * saves the provider without a key entry.
 */
async function promptOptionalKey(
  deps: AuthMenuDeps,
  preset: LocalLlmPresetEntry,
): Promise<string | undefined> {
  const answer = (
    await deps.reader.readSecret(
      `  ${color.amber('?')} ${color.bold(preset.label)} API key ` +
        `${color.dim('(hidden — Enter to skip if auth is disabled on the server)')}: `,
    )
  ).trim();
  if (!answer) return undefined;
  return answer;
}

// Re-exported for tests.
export { suggestLabel };
