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

import { Check, Download, Palette, Search, ShieldCheck, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { colorToHex } from '@/lib/color';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useActiveSessionId } from '@/stores/session-lanes';

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
  // `t` here is the kit's design-TOKEN set; alias the translator to `tr`.
  const { t: tr } = useAppTranslation();
  const bg = t.bg ?? '#fff';
  const surface = t.surface ?? bg;
  const fg = t.fg ?? '#111';
  const muted = t.muted ?? fg;
  const primary = t.primary ?? '#3b82f6';
  const accent = t.accent ?? primary;
  const border = t.border ?? muted;
  // Prefer kebab-scale tokens (which tuning writes) over legacy bare keys so the
  // preview reflects `design tune radius=…`, density, and font changes live.
  const radius = t['radius-md'] ?? t.radius ?? '0.5rem';
  const fontSans = t['font-sans'] ?? t.fontSans ?? 'system-ui, sans-serif';
  const fontDisplay = t['font-display'] ?? t.fontDisplay ?? fontSans;
  const shadow = t['shadow-2'] ?? (t.shadow && t.shadow !== 'none' ? t.shadow : undefined);

  return (
    <div
      style={{ background: bg, color: fg, fontFamily: fontSans }}
      className="flex min-w-0 flex-col gap-2 overflow-hidden p-3"
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
        className="flex min-w-0 flex-col gap-2 p-3"
      >
        <div style={{ fontFamily: fontDisplay }} className="text-base font-bold leading-tight">
          {tr('activity:designStudio.aaHeading')}
        </div>
        <div className="text-[11px] leading-snug" style={{ color: muted }}>
          {tr('activity:designStudio.theQuickBrownFoxJumpsOver')}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span
            style={{ background: primary, color: bg, borderRadius: radius }}
            className="shrink-0 px-2.5 py-1 text-[10px] font-semibold"
          >
            {tr('activity:designStudio.primary')}
          </span>
          <span
            style={{ border: `1px solid ${border}`, color: fg, borderRadius: radius }}
            className="shrink-0 px-2 py-1 text-[10px]"
          >
            {tr('activity:designStudio.ghost')}
          </span>
          <span
            style={{ background: accent, color: bg, borderRadius: '999px' }}
            className="ml-auto shrink-0 px-2 py-0.5 text-[9px] font-semibold"
          >
            {tr('activity:designStudio.badge')}
          </span>
        </div>
        <div
          style={{ border: `1px solid ${border}`, borderRadius: radius, color: muted }}
          className="text-[10px] px-2 py-1.5 mt-1"
        >
          {tr('activity:designStudio.inputField')}
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
  const { t } = useAppTranslation();
  const merged = applyOv(theme === 'light' ? kit.light : kit.dark, overrides, theme);
  return (
    <div className="mt-1 rounded-lg border border-border/60 p-2 bg-muted/30">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10px] font-semibold uppercase text-muted-foreground">
          {t('activity:design.colors')}
        </span>
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
              className="flex min-w-[2rem] flex-col items-center gap-0.5"
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

/** High-level knob editor for the active kit — sends `design.tune`. */
function TuneEditor({ onTune }: { onTune: (tune: Record<string, string>) => void }) {
  const { t } = useAppTranslation();
  const [font, setFont] = useState('');
  const Row = ({ label, knob, values }: { label: string; knob: string; values: string[] }) => (
    <div className="flex items-center gap-1.5">
      <span className="w-16 shrink-0 text-[9px] uppercase text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => onTune({ [knob]: v })}
            className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-primary hover:text-primary-foreground"
          >
            {v}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className="mt-1 flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 p-2">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
        {t('activity:designStudio.tune')}
      </span>
      <Row
        label={t('activity:designStudio.radius')}
        knob="radius"
        values={['none', 'sm', 'md', 'lg', 'xl', 'full']}
      />
      <Row
        label={t('activity:designStudio.density')}
        knob="density"
        values={['compact', 'cozy', 'comfortable']}
      />
      <Row
        label={t('activity:designStudio.motion')}
        knob="motion"
        values={['snappy', 'smooth', 'none']}
      />
      <div className="flex items-center gap-1.5">
        <span className="w-16 shrink-0 text-[9px] uppercase text-muted-foreground">
          {t('activity:designStudio.font')}
        </span>
        <input
          value={font}
          onChange={(e) => setFont(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && font.trim()) onTune({ font: font.trim() });
          }}
          placeholder={t('activity:designStudio.spaceGrotesk')}
          className="h-6 min-w-0 flex-1 rounded border border-border/60 bg-background/70 px-1.5 text-[10px]"
        />
        <button
          type="button"
          onClick={() => font.trim() && onTune({ font: font.trim() })}
          className="rounded border border-border/60 px-1.5 py-0.5 text-[10px] hover:bg-muted"
        >
          {t('activity:designStudio.set')}
        </button>
      </div>
    </div>
  );
}

export function DesignGalleryView({ className }: { className?: string }) {
  const { client } = useWebSocket();
  // The active kit is pinned per conversation, so the gallery re-reads it when
  // the user switches tabs — otherwise it keeps showing, and lets the user
  // "tune", the kit of the tab they just left.
  const sessionId = useActiveSessionId();
  const { t } = useAppTranslation();
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
    const onTune = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; overrides?: Tokens; error?: string } }).payload;
      if (p?.ok && p.overrides) {
        setOverrides(p.overrides);
        setStatus('Tuned');
      } else if (p?.error) {
        setStatus(`Tune failed: ${p.error}`);
      }
    };
    const onSwap = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; kit?: string; overrides?: Tokens } }).payload;
      if (p?.ok && p.kit) {
        setActiveKit(p.kit);
        setOverrides(p.overrides ?? {});
        setStatus(`Swapped to ${p.kit}`);
      }
    };
    const onMat = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; path?: string; error?: string } }).payload;
      setStatus(
        p?.ok
          ? i18n.t('activity:design.wrote', { path: p.path })
          : i18n.t('activity:design.materializeFailed', { error: p?.error ?? 'error' }),
      );
    };
    const onVer = (msg: unknown) => {
      const p = (
        msg as {
          payload?: {
            ok?: boolean;
            score?: number;
            violationCount?: number;
            filesScanned?: number;
            error?: string;
          };
        }
      ).payload;
      if (!p?.ok) {
        setStatus(i18n.t('activity:design.verifyError', { error: p?.error ?? 'error' }));
        return;
      }
      const pct = Math.round((p.score ?? 1) * 100);
      setStatus(
        p.violationCount
          ? i18n.t('activity:design.verifyOffPalette', {
              pct,
              count: p.violationCount,
              files: p.filesScanned,
            })
          : i18n.t('activity:design.verifyClean', { files: p.filesScanned }),
      );
    };
    client.on('design.list', onList);
    client.on('design.use', onUse);
    client.on('design.set', onSet);
    client.on('design.tune', onTune);
    client.on('design.swap', onSwap);
    client.on('design.materialize', onMat);
    client.on('design.verify', onVer);
    client.send({ type: 'design.list', payload: client.withSession({}) });
    return () => {
      client.off('design.list', onList);
      client.off('design.use', onUse);
      client.off('design.set', onSet);
      client.off('design.tune', onTune);
      client.off('design.swap', onSwap);
      client.off('design.materialize', onMat);
      client.off('design.verify', onVer);
    };
  }, [client, sessionId]);

  const useKit = useCallback(
    (id: string) =>
      client?.send({ type: 'design.use', payload: client.withSession({ kit: id, stack }) }),
    [client, stack],
  );

  // Optimistic override update + persist to the server for the active kit.
  const setOverride = useCallback(
    (key: string, hex: string) => {
      setOverrides((prev) => ({ ...prev, [key]: hex }));
      client?.send({
        type: 'design.set',
        payload: client.withSession({ overrides: { [key]: hex } }),
      });
    },
    [client],
  );

  // Send high-level knobs; resolved overrides return via `design.tune`.
  const tuneKit = useCallback(
    (tune: Record<string, string>) =>
      client?.send({ type: 'design.tune', payload: client.withSession({ tune }) }),
    [client],
  );

  const materialize = useCallback(() => {
    setStatus(i18n.t('activity:design.writing'));
    client?.send({ type: 'design.materialize', payload: client.withSession({ stack }) });
  }, [client, stack]);

  const verify = useCallback(() => {
    setStatus(i18n.t('activity:design.scanning'));
    client?.send({ type: 'design.verify', payload: client.withSession({}) });
  }, [client]);

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
  // Design kits are bounded (catalog), show all without pagination.

  return (
    <div
      className={cn(
        'flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[hsl(var(--surface-2)/0.45)]',
        className,
      )}
    >
      <div className="border-b border-border/60 p-3">
        <div className="rounded-xl border border-border/70 bg-card/75 p-3 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Palette className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold">{t('activity:design.heading')}</h2>
                <p className="text-xs text-muted-foreground">
                  {t('activity:design.kitsCount', { count: filtered.length })}
                </p>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-center lg:justify-end">
              <label className="relative min-w-0 flex-1 sm:max-w-xs">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('activity:design.searchPlaceholder')}
                  className="h-9 w-full rounded-md border border-border/70 bg-background/70 pl-8 pr-3 text-sm shadow-sm outline-none transition focus:border-primary/40 focus:ring-2 focus:ring-ring/30"
                />
              </label>
              <select
                value={stack}
                onChange={(e) => setStack(e.target.value)}
                className="h-9 rounded-md border border-border/70 bg-background/70 px-2 text-sm shadow-sm"
                title={t('activity:design.stackTitle')}
              >
                {STACKS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              {status && (
                <span className="min-w-0 truncate rounded-md border border-border/60 bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground sm:max-w-56">
                  {status}
                </span>
              )}
              <button
                type="button"
                onClick={() => showPanel('chat')}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t('common:action.close')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={useScrollPosition('design-gallery')}
        className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3 sm:p-4"
      >
        {filtered.length === 0 ? (
          <div className="ws-surface mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-xl p-6 text-center text-muted-foreground">
            <Palette className="h-8 w-8 text-primary/60" />
            <p className="text-sm font-medium text-foreground">
              {t('activity:design.kitsCount', { count: 0 })}
            </p>
            <p className="text-xs">{t('activity:design.searchPlaceholder')}</p>
          </div>
        ) : (
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,20rem),1fr))]">
            {filtered.map((kit) => {
              const isActive = activeKit === kit.id;
              const ov = isActive ? overrides : {};
              return (
                <div
                  key={kit.id}
                  className={cn(
                    'flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card/75 shadow-sm',
                    isActive ? 'border-primary/60 ring-1 ring-primary/30' : 'border-border/70',
                  )}
                >
                  {/* Live light + dark previews (override-applied for the active kit) */}
                  <div className="grid min-h-[12rem] grid-cols-1 sm:grid-cols-2">
                    <KitPreview
                      t={applyOv(kit.light, ov, 'light')}
                      label={t('activity:designStudio.light')}
                    />
                    <KitPreview
                      t={applyOv(kit.dark, ov, 'dark')}
                      label={t('activity:designStudio.dark')}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 border-t border-border/60 bg-card p-3">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold truncate">{kit.name}</h3>
                      <code className="text-[10px] text-muted-foreground">{kit.id}</code>
                      {isActive && (
                        <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase text-primary ml-auto">
                          <Check className="w-3 h-3" /> {t('activity:design.active')}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      {kit.aesthetic}
                    </p>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => useKit(kit.id)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                          isActive
                            ? 'bg-primary/10 text-primary'
                            : 'bg-primary text-primary-foreground hover:opacity-90',
                        )}
                      >
                        {isActive ? t('activity:design.reapply') : t('activity:design.use')}
                      </button>
                      {isActive && (
                        <button
                          type="button"
                          onClick={materialize}
                          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium hover:bg-muted"
                          title={t('activity:design.materializeTitle', { stack })}
                        >
                          <Download className="w-3 h-3" /> {t('activity:design.materialize')}
                        </button>
                      )}
                      {isActive && (
                        <button
                          type="button"
                          onClick={verify}
                          className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium hover:bg-muted"
                          title={t('activity:design.verifyTitle')}
                        >
                          <ShieldCheck className="w-3 h-3" /> {t('activity:design.verify')}
                        </button>
                      )}
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {kit.bestFor}
                      </span>
                    </div>
                    {isActive && <ColorEditor kit={kit} overrides={ov} onSet={setOverride} />}
                    {isActive && <TuneEditor onTune={tuneKit} />}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
