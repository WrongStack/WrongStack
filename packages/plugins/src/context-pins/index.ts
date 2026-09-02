/**
 * context-pins plugin — pin durable facts into the system prompt.
 *
 * Long sessions lose important constraints to compaction ("the API
 * base URL is X", "never touch the legacy folder", "the user prefers
 * Turkish"). This plugin gives the agent (and the user) three tools:
 *
 *  - `pin_add`    — pin a short fact (optionally with a label)
 *  - `pin_remove` — remove a pin by id or label
 *  - `pin_list`   — list all pins
 *
 * Every pinned fact is injected into the system prompt on every
 * request via a `SystemPromptContributor`, so pins survive context
 * compaction by construction. Pins persist across sessions in a JSON
 * file (default: `<projectDir>/context-pins.json`, seeded by the CLI
 * host the same way `todo-tracker` gets its path).
 *
 * Config (`config.extensions['context-pins']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "filePath": "",        // where pins persist; empty = in-memory only
 *   "maxPins": 20,          // hard cap so the prompt block stays small
 *   "maxPinChars": 500      // per-pin length cap
 * }
 * ```
 *
 * Toggle off with `{ "name": "context-pins", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */

import * as fs from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { atomicWrite, ensureDir } from '@wrongstack/core/utils';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export interface Pin {
  id: string;
  label: string | null;
  text: string;
  createdAt: string;
}

interface ContextPinsState {
  pins: Pin[];
  nextId: number;
  adds: number;
  removals: number;
  persistErrors: number;
  contributorUnregister: null | (() => void);
}

const state: ContextPinsState = {
  pins: [],
  nextId: 1,
  adds: 0,
  removals: 0,
  persistErrors: 0,
  contributorUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ContextPinsConfig {
  enabled: boolean;
  filePath: string;
  maxPins: number;
  maxPinChars: number;
}

const DEFAULTS: ContextPinsConfig = {
  enabled: true,
  filePath: '',
  maxPins: 20,
  maxPinChars: 500,
};

function resolveProjectPath(rawPath: string, cwd = process.cwd()): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return '';
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  const rel = relative(root, resolved);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return resolved;
  return null;
}

function readConfig(raw: unknown): ContextPinsConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawPath =
    typeof r['filePath'] === 'string'
      ? r['filePath']
      : typeof r['file_path'] === 'string'
        ? r['file_path']
        : typeof r['path'] === 'string'
          ? r['path']
          : typeof r['file'] === 'string'
            ? r['file']
            : DEFAULTS.filePath;
  const rawMaxPins = r['maxPins'] ?? r['max_pins'] ?? r['limit'];
  const rawMaxChars = r['maxPinChars'] ?? r['max_pin_chars'] ?? r['maxChars'] ?? r['max_chars'];
  return {
    enabled: r['enabled'] !== false,
    filePath: rawPath ? (resolveProjectPath(rawPath) ?? '') : '',
    maxPins:
      typeof rawMaxPins === 'number' && rawMaxPins >= 1 && rawMaxPins <= 100
        ? rawMaxPins
        : DEFAULTS.maxPins,
    maxPinChars:
      typeof rawMaxChars === 'number' && rawMaxChars >= 20 ? rawMaxChars : DEFAULTS.maxPinChars,
  };
}

// ---------------------------------------------------------------------------
// Persistence (best-effort, synchronous — pins are tiny)
// ---------------------------------------------------------------------------

function loadPins(filePath: string): { pins: Pin[]; nextId: number } {
  if (!filePath) return { pins: [], nextId: 1 };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as {
      pins?: unknown;
      nextId?: unknown;
    };
    const pins = Array.isArray(raw.pins)
      ? raw.pins.filter(
          (p): p is Pin =>
            !!p &&
            typeof p === 'object' &&
            typeof (p as Pin).id === 'string' &&
            typeof (p as Pin).text === 'string',
        )
      : [];
    const maxExistingId = pins.reduce((max, p) => {
      const num = parseInt(p.id.replace(/\D/g, ''), 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);
    const nextId =
      typeof raw.nextId === 'number' && raw.nextId > maxExistingId ? raw.nextId : maxExistingId + 1;
    return { pins, nextId };
  } catch {
    return { pins: [], nextId: 1 };
  }
}

async function persistPins(filePath: string): Promise<boolean> {
  if (!filePath) return true;
  try {
    // Atomic tmp+rename so a crash mid-write can't tear the pin state.
    //
    // Uses the shared primitive rather than a local `renameSync`: on Windows
    // that rename fails EPERM/EBUSY whenever an antivirus scanner or a
    // concurrent reader holds the destination open, and the pin write was
    // simply lost. The shared helper retries across ~4s first.
    await ensureDir(dirname(filePath));
    await atomicWrite(
      filePath,
      JSON.stringify({ pins: state.pins, nextId: state.nextId }, null, 2),
    );
    return true;
  } catch {
    /* v8 ignore start */
    state.persistErrors += 1;
    return false;
    /* v8 ignore stop */
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'context-pins',
  version: '0.1.0',
  description:
    'Pin durable facts into the system prompt (pin_add/pin_remove/pin_list) — pins survive compaction and persist across sessions',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      filePath: {
        type: 'string',
        default: '',
        description:
          'JSON file where pins persist across sessions. Empty = in-memory only. Seeded by the host to <projectDir>/context-pins.json.',
      },
      maxPins: {
        type: 'number',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Maximum number of concurrent pins.',
      },
      maxPinChars: {
        type: 'number',
        minimum: 20,
        default: 500,
        description: 'Per-pin text length cap (chars).',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.adds = 0;
    state.removals = 0;
    state.persistErrors = 0;
    if (state.contributorUnregister) {
      try {
        state.contributorUnregister();
      } catch {
        // best-effort
      }
      state.contributorUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['context-pins']);
    const loaded = loadPins(cfg.filePath);
    state.pins = loaded.pins.slice(0, cfg.maxPins);
    state.nextId = loaded.nextId;

    // ── System prompt contributor — the reason this plugin exists ─────
    if (cfg.enabled) {
      state.contributorUnregister = api.registerSystemPromptContributor(async () => {
        if (state.pins.length === 0) return [];
        const lines = state.pins.map((p) => `- ${p.label ? `[${p.label}] ` : ''}${p.text}`);
        return [
          {
            type: 'text' as const,
            text:
              '[pinned_context]\n' +
              'The user or agent pinned these facts — they remain true regardless of conversation age:\n' +
              lines.join('\n'),
          },
        ];
      });
    }

    // ── pin_add ───────────────────────────────────────────────────────
    api.tools.register({
      name: 'pin_add',
      description:
        'Pin a short durable fact into the system prompt so it survives context compaction. Use for constraints, decisions, and preferences that must not be forgotten.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to pin (short and declarative).' },
          label: { type: 'string', description: 'Optional short label, e.g. "api" or "style".' },
        },
        required: ['text'],
      },
      permission: 'auto',
      category: 'Memory',
      mutating: true,
      async execute(input: { text: string; label?: string | undefined }) {
        if (!cfg.enabled) return { ok: false, error: 'context-pins is disabled' };
        const raw = (input ?? {}) as Record<string, unknown>;
        const rawText =
          input.text ??
          raw['pin'] ??
          raw['content'] ??
          raw['message'] ??
          raw['note'] ??
          raw['fact'] ??
          raw['data'];
        const text = String(rawText ?? '').trim();
        if (!text) return { ok: false, error: 'pin text must not be empty' };
        if (state.pins.length >= cfg.maxPins) {
          return {
            ok: false,
            error: `pin limit reached (${cfg.maxPins}). Remove a pin first with pin_remove.`,
          };
        }
        const pin: Pin = {
          id: `pin-${state.nextId++}`,
          label: typeof input.label === 'string' && input.label.trim() ? input.label.trim() : null,
          text: text.slice(0, cfg.maxPinChars),
          createdAt: new Date().toISOString(),
        };
        state.pins.push(pin);
        state.adds += 1;
        api.metrics.counter('adds');
        const persisted = await persistPins(cfg.filePath);
        return { ok: true, pin, persisted, totalPins: state.pins.length };
      },
    });

    // ── pin_remove ────────────────────────────────────────────────────
    api.tools.register({
      name: 'pin_remove',
      description: 'Remove a pinned fact by its id (pin-N) or label.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Pin id (pin-N) or label to remove.' },
          label: { type: 'string', description: 'Alternative label to remove.' },
        },
      },
      permission: 'auto',
      category: 'Memory',
      mutating: true,
      async execute(input: { id?: string | undefined; label?: string | undefined }) {
        if (!cfg.enabled) return { ok: false, error: 'context-pins is disabled' };
        const raw = (input ?? {}) as Record<string, unknown>;
        const key = String(
          input.id ??
            input.label ??
            raw['pinId'] ??
            raw['pin_id'] ??
            raw['name'] ??
            raw['key'] ??
            '',
        ).trim();
        if (!key) return { ok: false, error: 'id or label is required' };
        const before = state.pins.length;
        state.pins = state.pins.filter((p) => p.id !== key && p.label !== key);
        const removed = before - state.pins.length;
        if (removed === 0) return { ok: false, error: `no pin matches "${key}"` };
        state.removals += removed;
        api.metrics.counter('removals', removed);
        const persisted = await persistPins(cfg.filePath);
        return { ok: true, removed, persisted, totalPins: state.pins.length };
      },
    });

    // ── pin_list ──────────────────────────────────────────────────────
    api.tools.register({
      name: 'pin_list',
      description: 'List all pinned facts currently injected into the system prompt.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Memory',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          pins: state.pins,
          totalPins: state.pins.length,
          maxPins: cfg.maxPins,
          filePath: cfg.filePath || null,
          counters: {
            adds: state.adds,
            removals: state.removals,
            persistErrors: state.persistErrors,
          },
        };
      },
    });

    api.log.info('context-pins plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      pinsLoaded: state.pins.length,
      filePath: cfg.filePath || null,
    });
  },

  teardown(api) {
    if (state.contributorUnregister) {
      try {
        state.contributorUnregister();
      } catch {
        // best-effort
      }
      state.contributorUnregister = null;
    }
    const final = {
      pins: state.pins.length,
      adds: state.adds,
      removals: state.removals,
      persistErrors: state.persistErrors,
    };
    state.pins = [];
    state.nextId = 1;
    state.adds = 0;
    state.removals = 0;
    state.persistErrors = 0;
    api.log.info('context-pins: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.persistErrors === 0,
      message: `context-pins: ${state.pins.length} pin(s) active, ${state.adds} add(s), ${state.removals} removal(s), ${state.persistErrors} persist error(s)`,
      counters: {
        pins: state.pins.length,
        adds: state.adds,
        removals: state.removals,
        persistErrors: state.persistErrors,
      },
    };
  },
};

export default plugin;
