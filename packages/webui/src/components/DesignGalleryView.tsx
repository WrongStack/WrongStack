/**
 * DesignGalleryView — a live preview gallery of every design kit.
 *
 * For each kit it renders a small representative "mini-app" sample styled inline
 * from the kit's own tokens (the same `light`/`dark` token sets sent by the
 * `design.list` WS message), in both light and dark, so you can see — not just
 * read — what each kit looks like. "Use" pins the kit on the live agent.
 */

import { Check, Palette, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

type Tokens = Record<string, string>;
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

export function DesignGalleryView({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const setCurrentView = useUIStore((s) => s.setCurrentView);
  const [kits, setKits] = useState<Kit[]>([]);
  const [activeKit, setActiveKit] = useState<string | null>(null);
  const [stack, setStack] = useState<string>('web');
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!client) return;
    const onList = (msg: unknown) => {
      const p = (msg as { payload?: { kits?: Kit[]; activeKit?: string | null } }).payload;
      setKits(p?.kits ?? []);
      setActiveKit(p?.activeKit ?? null);
    };
    const onUse = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; kit?: string } }).payload;
      if (p?.ok && p.kit) setActiveKit(p.kit);
    };
    client.on('design.list', onList);
    client.on('design.use', onUse);
    client.send({ type: 'design.list' });
    return () => {
      client.off('design.list', onList);
      client.off('design.use', onUse);
    };
  }, [client]);

  const useKit = useCallback(
    (id: string) => client?.send({ type: 'design.use', payload: { kit: id, stack } }),
    [client, stack],
  );

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
          title="Stack applied when you click Use"
        >
          {STACKS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
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
            return (
              <div
                key={kit.id}
                className={cn(
                  'rounded-xl border overflow-hidden flex flex-col',
                  isActive ? 'border-primary/60 ring-1 ring-primary/40' : 'border-border/60',
                )}
              >
                {/* Live light + dark previews from the kit's own tokens */}
                <div className="grid grid-cols-2">
                  <KitPreview t={kit.light} label="Light" />
                  <KitPreview t={kit.dark} label="Dark" />
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
                    <span className="text-[10px] text-muted-foreground truncate">
                      {kit.bestFor}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
