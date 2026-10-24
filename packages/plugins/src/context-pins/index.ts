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
 * host the same way the host wiring seeds the path).
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
import { type Plugin, ToolValidationError } from '@wrongstack/contracts/types';
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
  /** Set when the pins file exists but could not be read at setup. */
  loadError?: string | undefined;
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
  /** True when a `filePath` WAS configured but resolved outside every root. */
  filePathRejected: boolean;
  maxPins: number;
  maxPinChars: number;
}

const DEFAULTS: ContextPinsConfig = {
  enabled: true,
  filePath: '',
  filePathRejected: false,
  maxPins: 20,
  maxPinChars: 500,
};

/**
 * Resolve the pin store path, accepting it only inside one of `roots`.
 *
 * The containment exists because `filePath` arrives through
 * `config.extensions`, and in-project config is untrusted by this repo's own
 * trust boundary — an absolute path or `..` traversal would turn pin
 * persistence into arbitrary-file I/O.
 *
 * It used to admit ONE root, `process.cwd()`, which silently broke the only
 * path the product actually uses: the CLI seeds
 * `<projectDir>/context-pins.json` (`wiring/plugins.ts`), and `projectDir` is
 * `~/.wrongstack/projects/<hash>/` — outside the cwd, therefore rejected,
 * therefore `''`, therefore in-memory only. Pins silently never reached disk
 * while `pin_add` reported `persisted: true`, in a plugin whose description
 * promises they "persist across sessions". The host's own project directory
 * is now a second accepted root; anything outside both is still refused.
 */
function resolveProjectPath(rawPath: string, roots: readonly string[]): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return '';
  // A relative path keeps resolving against the first root (the cwd), so the
  // documented `.wrongstack/pins.json` spelling is unchanged.
  const primary = resolve(roots[0] ?? process.cwd());
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(primary, rawPath);
  for (const root of roots) {
    if (!root) continue;
    const base = resolve(root);
    const rel = relative(base, resolved);
    if (rel === '' || (rel.split(/[\\/]/)[0] !== '..' && !isAbsolute(rel))) return resolved;
  }
  return null;
}

/**
 * The host's per-project state directory, when the host injected one.
 *
 * `wiring/plugins.ts` patches `paths` onto the config object every plugin
 * receives, but `Config` does not declare the field and no other plugin reads
 * it — hence the narrow local accessor rather than a shared helper. Absent or
 * malformed, pins simply fall back to the cwd root.
 */
function hostProjectDir(api: unknown): string {
  const paths = (api as { config?: { paths?: { projectDir?: unknown } } } | null)?.config?.paths;
  return typeof paths?.projectDir === 'string' ? paths.projectDir : '';
}

function readConfig(raw: unknown, roots: readonly string[] = [process.cwd()]): ContextPinsConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, filePathRejected: false };
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
  const resolvedPath = rawPath ? resolveProjectPath(rawPath, roots) : '';
  return {
    enabled: r['enabled'] !== false,
    filePath: resolvedPath ?? '',
    // A rejected path is not the same as "no path configured": the first is a
    // misconfiguration the operator must hear about, the second is the
    // documented in-memory mode. They used to collapse into the same silent ''.
    filePathRejected: resolvedPath === null,
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

function loadPins(filePath: string): { pins: Pin[]; nextId: number; unreadable?: string } {
  if (!filePath) return { pins: [], nextId: 1 };
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    // Only a missing file means "no pins". Any other read error (EBUSY from
    // an AV scan, EPERM, EIO) used to look empty too, and the next pin_add
    // wrote that empty list over the file — deleting every pin.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { pins: [], nextId: 1 };
    return { pins: [], nextId: 1, unreadable: err instanceof Error ? err.message : String(err) };
  }
  try {
    // An editor's UTF-8 BOM is not corruption.
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as {
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
  } catch (err) {
    // Unparseable is unreadable too: loading it as "no pins" let the next
    // pin_add write [newPin] over the file and delete every stored pin.
    return { pins: [], nextId: 1, unreadable: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Where the pins actually ended up.
 *
 * `persistPins` used to return `true` for an empty path — "nothing to write"
 * reported as "written". Every tool forwarded that as `persisted: true`, so a
 * store that was silently in-memory was indistinguishable from one on disk.
 */
type PersistOutcome = 'file' | 'memory' | 'error';

async function persistPins(filePath: string): Promise<PersistOutcome> {
  if (!filePath) return 'memory';
  if (state.loadError !== undefined) {
    // The stored pins were never loaded: writing now would replace them.
    state.persistErrors += 1;
    return 'error';
  }
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
    return 'file';
  } catch {
    /* v8 ignore start */
    state.persistErrors += 1;
    return 'error';
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

    // Two accepted roots: the cwd (the documented relative spelling) and the
    // host's own per-project directory, which is where the CLI actually seeds
    // this file. Passing only the cwd is what made every host-seeded store
    // in-memory.
    const cfg = readConfig(api.config.extensions?.['context-pins'], [
      process.cwd(),
      hostProjectDir(api),
    ]);
    if (cfg.filePathRejected) {
      api.log.warn(
        'context-pins: configured filePath resolves outside the project and the host project directory — pins will NOT persist across sessions',
      );
    }
    const loaded = loadPins(cfg.filePath);
    // Every stored pin is kept: `maxPins` caps the prompt block and refuses a
    // new pin, it does not delete. Slicing here dropped the pins past a lowered
    // cap, and the next add/remove rewrote the file without them.
    state.pins = loaded.pins;
    state.nextId = loaded.nextId;
    state.loadError = loaded.unreadable;
    if (loaded.unreadable !== undefined) {
      api.log.warn(
        `context-pins: could not read ${cfg.filePath} (${loaded.unreadable}) — stored pins are not loaded and new pins will NOT be saved this session`,
      );
    }

    // ── System prompt contributor — the reason this plugin exists ─────
    if (cfg.enabled) {
      state.contributorUnregister = api.registerSystemPromptContributor(async () => {
        if (state.pins.length === 0) return [];
        const lines = state.pins
          .slice(0, cfg.maxPins)
          .map((p) => `- ${p.label ? `[${p.label}] ` : ''}${p.text}`);
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
      permission: 'confirm',
      category: 'Memory',
      mutating: true,
      async execute(input: { text: string; label?: string | undefined }) {
        if (!cfg.enabled) throw new Error('context-pins is disabled');
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
        if (!text) {
          throw new ToolValidationError({ message: 'pin text must not be empty', field: 'text' });
        }
        if (state.pins.length >= cfg.maxPins) {
          throw new Error(
            `pin limit reached (${cfg.maxPins}). Remove a pin first with pin_remove.`,
          );
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
        const storage = await persistPins(cfg.filePath);
        // `persisted` now means "this pin is on disk" — nothing else. It used
        // to be true for a store that was never written.
        return {
          ok: true,
          pin,
          persisted: storage === 'file',
          storage,
          totalPins: state.pins.length,
        };
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
      permission: 'confirm',
      category: 'Memory',
      mutating: true,
      async execute(input: { id?: string | undefined; label?: string | undefined }) {
        if (!cfg.enabled) throw new Error('context-pins is disabled');
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
        if (!key)
          throw new ToolValidationError({ message: 'id or label is required', field: 'id' });
        const before = state.pins.length;
        state.pins = state.pins.filter((p) => p.id !== key && p.label !== key);
        const removed = before - state.pins.length;
        if (removed === 0) throw new Error(`no pin matches "${key}"`);
        state.removals += removed;
        api.metrics.counter('removals', removed);
        const storage = await persistPins(cfg.filePath);
        return {
          ok: true,
          removed,
          persisted: storage === 'file',
          storage,
          totalPins: state.pins.length,
        };
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
          // Makes "these pins are only in memory" legible to the caller
          // instead of leaving it to be inferred from a null path.
          storage: cfg.filePath ? 'file' : 'memory',
          filePathRejected: cfg.filePathRejected,
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
    state.loadError = undefined;
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
