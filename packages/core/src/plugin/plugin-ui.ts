import type {
  PluginPanelHandle,
  PluginPanelSpec,
  PluginPromptOptions,
  PluginStatusChipHandle,
  PluginStatusChipSpec,
  PluginUiAPI,
  PluginUiTone,
  PluginViewNode,
} from '@wrongstack/contracts/types/plugin';
import { sanitizeTerminalText } from '../utils/terminal-sanitize.js';

export const MAX_PLUGIN_STATUS_CHIP_CHARS = 24;
export const MAX_PLUGIN_VIEW_DEPTH = 8;
export const MAX_PLUGIN_VIEW_BYTES = 64 * 1024;
export const DEFAULT_STATUS_CHIP_THROTTLE_MS = 250;

export interface RegisteredPluginStatusChip extends PluginStatusChipSpec {
  qualifiedId: string;
  owner: string;
  updatedAt: number;
}

export interface RegisteredPluginPanel {
  qualifiedId: string;
  owner: string;
  id: string;
  title: string;
  actions: NonNullable<PluginPanelSpec['actions']>;
  render: () => Promise<PluginViewNode>;
  onAction?: ((actionId: string) => void | Promise<void>) | undefined;
}

export type PluginUiPromptHandler = <T extends string = string>(
  owner: string,
  opts: PluginPromptOptions<T>,
  signal: AbortSignal,
) => Promise<T | boolean | string | null>;

export type PluginUiNotifyHandler = (owner: string, message: string, tone: PluginUiTone) => void;

export interface PluginUiRegistryOptions {
  throttleMs?: number | undefined;
  onPrompt?: PluginUiPromptHandler | undefined;
  onNotify?: PluginUiNotifyHandler | undefined;
}

function clampText(raw: string, maxChars: number): string {
  const clean = sanitizeTerminalText(raw).replace(/\s+/gu, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1))}…`;
}

function sanitizeNode(node: PluginViewNode, depth = 0): PluginViewNode {
  if (depth > MAX_PLUGIN_VIEW_DEPTH) {
    return { kind: 'text', text: '[view depth limit exceeded]', tone: 'warning', dim: true };
  }
  switch (node.kind) {
    case 'text':
      return {
        ...node,
        text: sanitizeTerminalText(node.text),
      };
    case 'kv':
      return {
        kind: 'kv',
        items: node.items.slice(0, 64).map((item) => ({
          label: clampText(item.label, 48),
          value: sanitizeTerminalText(item.value).slice(0, 512),
          ...(item.tone ? { tone: item.tone } : {}),
        })),
      };
    case 'table': {
      const maxRows = Math.max(1, Math.min(200, node.maxRows ?? 50));
      return {
        kind: 'table',
        columns: node.columns.slice(0, 16).map((c) => clampText(c, 40)),
        rows: node.rows
          .slice(0, maxRows)
          .map((r) => r.slice(0, 16).map((cell) => clampText(String(cell ?? ''), 120))),
        maxRows,
      };
    }
    case 'badges':
      return {
        kind: 'badges',
        badges: node.badges.slice(0, 32).map((b) => ({
          label: clampText(b.label, 32),
          ...(b.tone ? { tone: b.tone } : {}),
        })),
      };
    case 'progress':
      return {
        kind: 'progress',
        label: clampText(node.label, 64),
        current: Number.isFinite(node.current) ? node.current : 0,
        total: Number.isFinite(node.total) && node.total > 0 ? node.total : 1,
        ...(node.tone ? { tone: node.tone } : {}),
      };
    case 'code':
      return {
        kind: 'code',
        ...(node.language ? { language: clampText(node.language, 24) } : {}),
        content: sanitizeTerminalText(node.content),
        ...(node.maxLines !== undefined
          ? { maxLines: Math.max(1, Math.min(400, node.maxLines)) }
          : {}),
      };
    case 'markdown':
      return {
        kind: 'markdown',
        content: sanitizeTerminalText(node.content),
      };
    case 'log':
      return {
        kind: 'log',
        lines: node.lines.slice(0, 200).map((line) => ({
          ...(line.ts ? { ts: clampText(line.ts, 32) } : {}),
          ...(line.level ? { level: line.level } : {}),
          text: sanitizeTerminalText(line.text),
        })),
      };
    case 'stack':
      return {
        kind: 'stack',
        direction: node.direction === 'horizontal' ? 'horizontal' : 'vertical',
        ...(node.gap !== undefined ? { gap: Math.max(0, Math.min(4, Math.floor(node.gap))) } : {}),
        children: node.children.slice(0, 64).map((child) => sanitizeNode(child, depth + 1)),
      };
  }
}

export class PluginUiRegistry {
  private readonly chips = new Map<string, RegisteredPluginStatusChip>();
  private readonly chipTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly chipLastEmitAt = new Map<string, number>();
  private readonly panels = new Map<string, RegisteredPluginPanel>();
  private readonly listeners = new Set<() => void>();
  private readonly throttleMs: number;
  private promptHandler: PluginUiPromptHandler | undefined;
  private notifyHandler: PluginUiNotifyHandler | undefined;

  constructor(opts: PluginUiRegistryOptions = {}) {
    this.throttleMs = Math.max(0, opts.throttleMs ?? DEFAULT_STATUS_CHIP_THROTTLE_MS);
    this.promptHandler = opts.onPrompt;
    this.notifyHandler = opts.onNotify;
  }

  setHandlers(handlers: {
    onPrompt?: PluginUiPromptHandler | undefined;
    onNotify?: PluginUiNotifyHandler | undefined;
  }): void {
    if ('onPrompt' in handlers) this.promptHandler = handlers.onPrompt;
    if ('onNotify' in handlers) this.notifyHandler = handlers.onNotify;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // Never allow UI observer errors to break plugin state transitions.
      }
    }
  }

  private emitThrottledChip(qualifiedId: string): void {
    if (this.throttleMs === 0) {
      this.emit();
      return;
    }
    const now = Date.now();
    const last = this.chipLastEmitAt.get(qualifiedId) ?? 0;
    const elapsed = now - last;
    if (elapsed >= this.throttleMs && !this.chipTimers.has(qualifiedId)) {
      this.chipLastEmitAt.set(qualifiedId, now);
      this.emit();
      return;
    }
    if (this.chipTimers.has(qualifiedId)) return;
    const delay = Math.max(1, this.throttleMs - elapsed);
    const timer = setTimeout(() => {
      this.chipTimers.delete(qualifiedId);
      this.chipLastEmitAt.set(qualifiedId, Date.now());
      this.emit();
    }, delay);
    timer.unref?.();
    this.chipTimers.set(qualifiedId, timer);
  }

  listStatusChips(): RegisteredPluginStatusChip[] {
    return [...this.chips.values()].sort(
      (a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.qualifiedId.localeCompare(b.qualifiedId),
    );
  }

  listPanels(): RegisteredPluginPanel[] {
    return [...this.panels.values()].sort((a, b) => a.qualifiedId.localeCompare(b.qualifiedId));
  }

  getPanel(qualifiedId: string): RegisteredPluginPanel | undefined {
    return this.panels.get(qualifiedId);
  }

  registerStatusChip(owner: string, initial: PluginStatusChipSpec): PluginStatusChipHandle {
    const cleanId = clampText(initial.id, 32) || 'chip';
    const qualifiedId = `${owner}:${cleanId}`;
    const normalizeSpec = (spec: PluginStatusChipSpec): RegisteredPluginStatusChip => ({
      qualifiedId,
      owner,
      id: cleanId,
      text: clampText(spec.text, MAX_PLUGIN_STATUS_CHIP_CHARS),
      ...(spec.icon ? { icon: clampText(spec.icon, 4) } : {}),
      ...(spec.tone ? { tone: spec.tone } : {}),
      ...(spec.tooltip ? { tooltip: clampText(spec.tooltip, 120) } : {}),
      priority: Math.max(-100, Math.min(100, Math.floor(spec.priority ?? 0))),
      ...(spec.command ? { command: clampText(spec.command, 64) } : {}),
      updatedAt: Date.now(),
    });

    this.chips.set(qualifiedId, normalizeSpec(initial));
    this.chipLastEmitAt.set(qualifiedId, Date.now());
    this.emit();

    let disposed = false;
    return {
      update: (patch) => {
        if (disposed) return;
        const current = this.chips.get(qualifiedId);
        if (!current) return;
        this.chips.set(
          qualifiedId,
          normalizeSpec({
            ...current,
            ...patch,
            id: cleanId,
          }),
        );
        this.emitThrottledChip(qualifiedId);
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const timer = this.chipTimers.get(qualifiedId);
        if (timer) {
          clearTimeout(timer);
          this.chipTimers.delete(qualifiedId);
        }
        this.chipLastEmitAt.delete(qualifiedId);
        if (this.chips.delete(qualifiedId)) {
          this.emit();
        }
      },
    };
  }

  registerPanel(owner: string, spec: PluginPanelSpec): PluginPanelHandle {
    const cleanId = clampText(spec.id, 32) || 'panel';
    const qualifiedId = `${owner}:${cleanId}`;
    const entry: RegisteredPluginPanel = {
      qualifiedId,
      owner,
      id: cleanId,
      title: clampText(spec.title, 64),
      actions: (spec.actions ?? []).slice(0, 12).map((act) => ({
        id: clampText(act.id, 32),
        label: clampText(act.label, 32),
        ...(act.shortcut ? { shortcut: clampText(act.shortcut, 8) } : {}),
        ...(act.mutating !== undefined ? { mutating: act.mutating } : {}),
      })),
      render: async () => {
        const rawNode = await spec.render();
        const sanitized = sanitizeNode(rawNode);
        const serializedBytes = Buffer.byteLength(JSON.stringify(sanitized), 'utf8');
        if (serializedBytes > MAX_PLUGIN_VIEW_BYTES) {
          return {
            kind: 'text',
            text: `[panel "${qualifiedId}" output exceeded ${MAX_PLUGIN_VIEW_BYTES} bytes]`,
            tone: 'warning',
          };
        }
        return sanitized;
      },
      onAction: spec.onAction ? (actionId) => spec.onAction?.(actionId) : undefined,
    };
    this.panels.set(qualifiedId, entry);
    this.emit();

    let disposed = false;
    return {
      invalidate: () => {
        if (disposed || !this.panels.has(qualifiedId)) return;
        this.emit();
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.panels.delete(qualifiedId)) {
          this.emit();
        }
      },
    };
  }

  async prompt<T extends string = string>(
    owner: string,
    opts: PluginPromptOptions<T>,
    lifetimeSignal: AbortSignal,
  ): Promise<T | boolean | string | null> {
    if (!this.promptHandler || lifetimeSignal.aborted) return null;
    const timeoutMs = Math.max(100, Math.min(300_000, Math.floor(opts.timeoutMs ?? 60_000)));
    const sanitizedOpts: PluginPromptOptions<T> = {
      kind: opts.kind,
      title: clampText(opts.title, 80),
      ...(opts.message ? { message: clampText(opts.message, 400) } : {}),
      ...(opts.options
        ? {
            options: opts.options.slice(0, 64).map((o) => ({
              value: o.value,
              label: clampText(o.label, 80),
              ...(o.hint ? { hint: clampText(o.hint, 120) } : {}),
            })),
          }
        : {}),
      timeoutMs,
    };

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    lifetimeSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();

    try {
      return await this.promptHandler(owner, sanitizedOpts, controller.signal);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      lifetimeSignal.removeEventListener('abort', onAbort);
    }
  }

  notify(owner: string, message: string, tone: PluginUiTone = 'info'): void {
    const clean = clampText(message, 240);
    if (!clean) return;
    this.notifyHandler?.(owner, clean, tone);
  }

  drainByOwner(owner: string): void {
    let mutated = false;
    const prefix = `${owner}:`;
    for (const key of [...this.chips.keys()]) {
      if (key.startsWith(prefix)) {
        const timer = this.chipTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          this.chipTimers.delete(key);
        }
        this.chipLastEmitAt.delete(key);
        this.chips.delete(key);
        mutated = true;
      }
    }
    for (const key of [...this.panels.keys()]) {
      if (key.startsWith(prefix)) {
        this.panels.delete(key);
        mutated = true;
      }
    }
    if (mutated) this.emit();
  }
}

export function makePluginUi(
  owner: string,
  registry: PluginUiRegistry,
  lifetimeSignal: AbortSignal,
  ownCleanup: (fn: () => void) => void,
  assertActive: () => void,
): PluginUiAPI {
  return {
    registerStatusChip(initial) {
      assertActive();
      const handle = registry.registerStatusChip(owner, initial);
      ownCleanup(() => handle.dispose());
      return handle;
    },
    registerPanel(spec) {
      assertActive();
      const handle = registry.registerPanel(owner, spec);
      ownCleanup(() => handle.dispose());
      return handle;
    },
    prompt(opts) {
      assertActive();
      return registry.prompt(owner, opts, lifetimeSignal);
    },
    notify(message, opts) {
      assertActive();
      registry.notify(owner, message, opts?.tone ?? 'info');
    },
  };
}
