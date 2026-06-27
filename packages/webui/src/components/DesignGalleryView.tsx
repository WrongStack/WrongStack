/**
 * DesignGalleryView — a live preview gallery of every design kit.
 *
 * Each kit renders as a small "mini-app" styled inline from its own `light`/
 * `dark` token sets (sent by `design.list`), so you can SEE each kit, not just
 * read it. "Use" pins the kit on the live agent. For the active kit you can also
 * tweak its colors live (`design.set` overrides) and write the resulting tokens
 * to a real theme file (`design.materialize`) — so the palette becomes the
 * codebase's source of truth, not just a prompt hint.
 */

import { Check, Download, Palette, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { colorToHex } from '@/lib/color';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

type Tokens = Record<string, string>;
type ThemeName = 'light' | 'dark';
interface Kit {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  light: Tokens;
  dark: Tokens;
}

const STACKS = ['web', 'react-native', 'flutter', 'swiftui', 'compose'] as const;
const EDITABLE = ['primary', 'accent', 'bg', 'surface', 'fg', 'border'] as const;

/** Overlay overrides onto one theme's tokens (bare key = both themes; `light.`/`dark.` scoped). */
function applyOv(base: Tokens, overrides: Tokens, theme: ThemeName): Tokens {
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides)) {
    if (k.startsWith('light.')) {
      if (theme === 'light') out[k.slice(6)] = v;
    } else if (k.startsWith('dark.')) {
      if (theme === 'dark') out[k.slice(5)] = v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** A small fake UI rendered purely from a kit's token set. */
function KitPreview({ t, label }: { t: Tokens; label: string }) {
  const bg = t.bg ?? '#fff';
  const surface = t.surface ?? bg;
  const fg = t.fg ?? '#111';
  const muted = t.muted ?? fg;
  const primary = t.primary ?? '#3b82f6';
  const accent = t.accent ?? primary;
  const border = t.border ?? muted;
  const radius = t.radius ?? '0.5rem';
  const fontSans = t.fontSans ?? 'system-ui, sans-serif';
  const fontDisplay = t.fontDisplay ?? fontSans;
  const shadow = t.shadow && t.shadow !== 'none' ? t.shadow : undefined;

  return (
    <div
      style={{ background: bg, color: fg, fontFamily: fontSans }}
      className="p-3 flex flex-col gap-2 overflow-hidden"
    >
      <div className="text-[9px] uppercase tracking-wide" style={{ color: muted }}>
        {label}
      </div>
      <div
        style={{
          background: surface,
          border: `1px solid ${border}`,
          borderRadius: radius,
          boxShadow: shadow,
        }}
        className="p-3 flex flex-col gap-2"
      >
        <div style={{ fontFamily: fontDisplay }} className="text-base font-bold leading-tight">
          Aa Heading
        </div>
        <div className="text-[11px] leading-snug" style={{ color: muted }}>
          The quick brown fox jumps over the lazy dog.
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            style={{ background: primary, color: bg, borderRadius: radius }}
            className="text-[10px] font-semibold px-2.5 py-1"
          >
            Primary
          </span>
          <span
            style={{ border: `1px solid ${border}`, color: fg, borderRadius: radius }}
            className="text-[10px] px-2 py-1"
          >
            Ghost
          </span>
          <span
            style={{ background: accent, color: bg, borderRadius: '999px' }}
            className="text-[9px] font-semibold px-2 py-0.5 ml-auto"
          >
            Badge
          </span>
        </div>
        <div
          style={{ border: `1px solid ${border}`, borderRadius: radius, color: muted }}
          className="text-[10px] px-2 py-1.5 mt-1"
        >
          Input field…
        </div>
      </div>
    </div>
  );
}

/** Per-theme color editor for the active kit — sets `<theme>.<token>` overrides. */
function ColorEditor({
  kit,
  overrides,
  onSet,
}: {
  kit: Kit;
  overrides: Tokens;
  onSet: (key: string, hex: string) => void;
}) {
  const [theme, setTheme] = useState<ThemeName>('light');
  const merged = applyOv(theme === 'light' ? kit.light : kit.dark, overrides, theme);
  return (
    <div className="mt-1 rounded-lg border border-border/60 p-2 bg-muted/30">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">Colors</span>
        <div className="ml-auto inline-flex rounded border border-border/60 overflow-hidden">
          {(['light', 'dark'] as ThemeName[]).map((th) => (
            <button
              key={th}
              type="button"
              onClick={() => setTheme(th)}
              className={cn(
                'text-[10px] px-1.5 py-0.5',
                theme === th ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              {th}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {EDITABLE.filter((tok) => merged[tok]).map((tok) => {
          const hex = colorToHex(merged[tok] ?? '') ?? '#000000';
          return (
            <label
              key={tok}
              className="flex flex-col items-center gap-0.5"
              title={`${tok}: ${merged[tok]}`}
            >
              <input
                type="color"
                value={hex}
                onChange={(e) => onSet(`${theme}.${tok}`, e.target.value)}
                className="w-6 h-6 rounded cursor-pointer bg-transparent border border-border/60 p-0"
              />
              <span className="text-[8px] text-muted-foreground">{tok}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

export function DesignGalleryView({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const [kits, setKits] = useState<Kit[]>([]);
  const [activeKit, setActiveKit] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Tokens>({});
  const [stack, setStack] = useState<string>('web');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const onList = (msg: unknown) => {
      const p = (
        msg as { payload?: { kits?: Kit[]; activeKit?: string | null; overrides?: Tokens } }
      ).payload;
      setKits(p?.kits ?? []);
      setActiveKit(p?.activeKit ?? null);
      setOverrides(p?.overrides ?? {});
    };
    const onUse = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; kit?: string; overrides?: Tokens } }).payload;
      if (p?.ok && p.kit) {
        setActiveKit(p.kit);
        setOverrides(p.overrides ?? {});
      }
    };
    const onSet = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; overrides?: Tokens } }).payload;
      if (p?.ok && p.overrides) setOverrides(p.overrides);
    };
    const onMat = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; path?: string; error?: string } }).payload;
      setStatus(p?.ok ? `Wrote ${p.path}` : `Materialize failed: ${p?.error ?? 'error'}`);
    };
    client.on('design.list', onList);
    client.on('design.use', onUse);
    client.on('design.set', onSet);
    client.on('design.materialize', onMat);
    client.send({ type: 'design.list' });
    return () => {
      client.off('design.list', onList);
      client.off('design.use', onUse);
      client.off('design.set', onSet);
      client.off('design.materialize', onMat);
    };
  }, [client]);

  const useKit = useCallback(
    (id: string) => client?.send({ type: 'design.use', payload: { kit: id, stack } }),
    [client, stack],
  );

  // Optimistic override update + persist to the server for the active kit.
  const setOverride = useCallback(
    (key: string, hex: string) => {
      setOverrides((prev) => ({ ...prev, [key]: hex }));
      client?.send({ type: 'design.set', payload: { overrides: { [key]: hex } } });
    },
    [client],
  );

  const materialize = useCallback(() => {
    setStatus('Writing theme file…');
    client?.send({ type: 'design.materialize', payload: { stack } });
  }, [client, stack]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? kits.filter(
          (k) =>
            k.id.includes(needle) ||
            k.name.toLowerCase().includes(needle) ||
            k.aesthetic.toLowerCase().includes(needle) ||
            k.tags.some((tag) => tag.includes(needle)),
        )
      : kits;
    return [...list].sort((a, b) => a.name.localeCompare(b.name));
  }, [kits, q]);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/60">
        <Palette className="w-5 h-5 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Design Studio — Gallery</h2>
        <span className="text-xs text-muted-foreground">{filtered.length} kits</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search kits…"
          className="ml-2 text-xs bg-transparent border border-border/60 rounded px-2 py-1 w-44"
        />
        <select
          value={stack}
          onChange={(e) => setStack(e.target.value)}
          className="text-xs bg-transparent border border-border/60 rounded px-1.5 py-1"
          title="Stack for Use + Materialize"
        >
          {STACKS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {status && (
          <span className="text-[11px] text-muted-foreground max-w-48 truncate">{status}</span>
        )}
        <button
          type="button"
          onClick={() => setCurrentView('chat')}
          className="ml-auto p-1 rounded hover:bg-muted text-muted-foreground"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {filtered.map((kit) => {
            const isActive = activeKit === kit.id;
            const ov = isActive ? overrides : {};
            return (
              <div
                key={kit.id}
                className={cn(
                  'rounded-xl border overflow-hidden flex flex-col',
                  isActive ? 'border-primary/60 ring-1 ring-primary/40' : 'border-border/60',
                )}
              >
                {/* Live light + dark previews (override-applied for the active kit) */}
                <div className="grid grid-cols-2">
                  <KitPreview t={applyOv(kit.light, ov, 'light')} label="Light" />
                  <KitPreview t={applyOv(kit.dark, ov, 'dark')} label="Dark" />
                </div>
                <div className="p-3 border-t border-border/60 flex flex-col gap-1.5 bg-card">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-semibold truncate">{kit.name}</h3>
                    <code className="text-[10px] text-muted-foreground">{kit.id}</code>
                    {isActive && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase text-primary ml-auto">
                        <Check className="w-3 h-3" /> Active
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug">{kit.aesthetic}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => useKit(kit.id)}
                      className={cn(
                        'text-[11px] px-2.5 py-1 rounded font-medium',
                        isActive
                          ? 'bg-primary/10 text-primary'
                          : 'bg-primary text-primary-foreground hover:opacity-90',
                      )}
                    >
                      {isActive ? 'Reapply' : 'Use'}
                    </button>
                    {isActive && (
                      <button
                        type="button"
                        onClick={materialize}
                        className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded font-medium border border-border/60 hover:bg-muted"
                        title={`Write tokens to a ${stack} theme file`}
                      >
                        <Download className="w-3 h-3" /> Materialize
                      </button>
                    )}
                    <span className="text-[10px] text-muted-foreground truncate">
                      {kit.bestFor}
                    </span>
                  </div>
                  {isActive && <ColorEditor kit={kit} overrides={ov} onSet={setOverride} />}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
