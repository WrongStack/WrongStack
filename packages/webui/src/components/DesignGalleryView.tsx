import { PageMotif } from '@/components/PageMotif';
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

import {
  Camera,
  Check,
  Compass,
  Download,
  History,
  Palette,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ContrastBadges, type ContrastIssue } from '@/components/ContrastBadges';
import { useScrollPosition } from '@/hooks/useScrollPosition';
import { useWebSocket } from '@/hooks/useWebSocket';
import { i18n, useAppTranslation } from '@/i18n';
import { colorToHex } from '@/lib/color';
import { cn } from '@/lib/utils';
import { showPanel } from '@/lib/view-navigation';
import { useActiveSessionId } from '@/stores/session-lanes';

type Tokens = Record<string, string>;
type ThemeName = 'light' | 'dark';
interface KitAxes {
  paper: string;
  display: string;
  accent: string;
  displayFace?: string;
}

interface Kit {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  axes?: KitAxes;
  posture?: string;
  material?: string;
  photo?: string;
  fontLinks?: string[];
  pictured?: string;
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

/** A small specimen card rendered purely from a kit's token set + material metadata. */
function KitPreview({ t, label, photo }: { t: Tokens; label: string; photo?: string | undefined }) {
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
  const weightBold = t['weight-bold'] ?? '700';
  const trackingTight = t['tracking-tight'] ?? '-0.015em';
  const leadingTight = t['leading-tight'] ?? '1.15';
  const shadow = t['shadow-2'] ?? (t.shadow && t.shadow !== 'none' ? t.shadow : undefined);
  const photoMode = photo?.trim().split(/\s+/)[0]?.toLowerCase();
  const photoFilter =
    photoMode === 'mono'
      ? 'grayscale(1) contrast(1.08)'
      : photoMode === 'warm'
        ? 'sepia(0.22) saturate(0.92)'
        : photoMode === 'duotone'
          ? 'grayscale(1) contrast(1.18)'
          : undefined;

  return (
    <div
      style={{ background: bg, color: fg, fontFamily: fontSans }}
      className="flex min-w-0 flex-col gap-2 overflow-hidden p-3"
    >
      <div
        className="flex items-center justify-between gap-1 text-[10px] font-medium"
        style={{ color: muted }}
      >
        <span>{label}</span>
        {photo && photo !== 'natural' && (
          <span
            style={{ border: `1px solid ${border}`, borderRadius: radius }}
            className="truncate px-1.5 py-0.5 font-mono text-[9px]"
            title={`Photo treatment: ${photo}`}
          >
            {photo.split(/\s+/)[0]}
          </span>
        )}
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
        {photo && (
          <div
            data-slot="hero"
            style={{
              borderRadius: radius,
              border: `1px solid ${border}`,
              filter: photoFilter,
              background:
                photoMode === 'duotone' || photoMode === 'tint'
                  ? `linear-gradient(125deg, ${primary} 0%, ${accent} 58%, ${surface} 100%)`
                  : `linear-gradient(125deg, ${fg} 0%, ${primary} 52%, ${accent} 100%)`,
            }}
            className="h-5 w-full opacity-85"
            title={`[data-slot] ${photo}`}
          />
        )}
        <div
          style={{
            fontFamily: fontDisplay,
            fontWeight: weightBold,
            letterSpacing: trackingTight,
            lineHeight: leadingTight,
          }}
          className="text-base"
        >
          {tr('activity:designStudio.aaHeading')}
        </div>
        <div className="text-[11px] leading-snug" style={{ color: muted }}>
          {tr('activity:designStudio.theQuickBrownFoxJumpsOver')}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <span
            style={{ background: primary, color: bg, borderRadius: radius, boxShadow: shadow }}
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
            style={{ background: accent, color: bg, borderRadius: radius }}
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
          aria-label={t('activity:designStudio.font')}
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
  const [contrastIssues, setContrastIssues] = useState<ContrastIssue[]>([]);
  const [studioNote, setStudioNote] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    // A response names the tab that asked for it (the server echoes the
    // request's sessionId). Drop frames stamped for ANOTHER session — a late
    // reply from the tab the user just left must not overwrite this tab's
    // kit or overrides. Untagged frames pass ONLY before a session is bound:
    // a pre-session request is unstamped, and so is its reply, but once a
    // session is active an untagged reply can only be one of those stale
    // pre-session answers arriving late.
    const isForeign = (msg: unknown): boolean => {
      const sid = (msg as { payload?: { sessionId?: unknown } }).payload?.sessionId;
      if (typeof sid !== 'string' || sid.length === 0) return sessionId !== null;
      return sid !== sessionId;
    };
    const onList = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as { payload?: { kits?: Kit[]; activeKit?: string | null; overrides?: Tokens } }
      ).payload;
      setKits(p?.kits ?? []);
      setActiveKit(p?.activeKit ?? null);
      setOverrides(p?.overrides ?? {});
      // Authoritative kit state; a previous tab's contrast warning is stale.
      setContrastIssues([]);
    };
    const onUse = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as {
          payload?: {
            ok?: boolean;
            kit?: string;
            overrides?: Tokens;
            contrastIssues?: ContrastIssue[];
          };
        }
      ).payload;
      if (p?.ok && p.kit) {
        setActiveKit(p.kit);
        setOverrides(p.overrides ?? {});
        // WCAG AA gate result from the server (empty = clean).
        setContrastIssues(p.contrastIssues ?? []);
      }
    };
    const onSet = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (msg as { payload?: { ok?: boolean; overrides?: Tokens } }).payload;
      if (p?.ok && p.overrides) setOverrides(p.overrides);
    };
    const onTune = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (msg as { payload?: { ok?: boolean; overrides?: Tokens; error?: string } }).payload;
      if (p?.ok && p.overrides) {
        setOverrides(p.overrides);
        setStatus('Tuned');
      } else if (p?.error) {
        setStatus(`Tune failed: ${p.error}`);
      }
    };
    const onSwap = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (msg as { payload?: { ok?: boolean; kit?: string; overrides?: Tokens } }).payload;
      if (p?.ok && p.kit) {
        setActiveKit(p.kit);
        setOverrides(p.overrides ?? {});
        // Swap drops overrides; the gate runs again on the next use.
        setContrastIssues([]);
        setStatus(`Swapped to ${p.kit}`);
      }
    };
    const onMat = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as {
          payload?: {
            ok?: boolean;
            path?: string;
            error?: string;
            contrastIssues?: ContrastIssue[];
          };
        }
      ).payload;
      // The materialize reply re-runs the gate on the persisted overrides.
      if (p?.ok && p.contrastIssues) setContrastIssues(p.contrastIssues);
      setStatus(
        p?.ok
          ? i18n.t('activity:design.wrote', { path: p.path })
          : i18n.t('activity:design.materializeFailed', { error: p?.error ?? 'error' }),
      );
    };
    const onVer = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as {
          payload?: {
            ok?: boolean;
            score?: number;
            violationCount?: number;
            filesScanned?: number;
            source?: 'kit' | 'captured';
            kit?: string | null;
            capturedFrom?: string[] | null;
            error?: string;
          };
        }
      ).payload;
      if (!p?.ok) {
        setStatus(i18n.t('activity:design.verifyError', { error: p?.error ?? 'error' }));
        return;
      }
      // Basis label — a capture-based score must never read as a kit score.
      const basis =
        p.source === 'captured'
          ? ` — captured tokens (${p.capturedFrom?.join(', ') ?? 'design capture'})`
          : p.kit
            ? ` — kit ${p.kit}`
            : '';
      const pct = Math.round((p.score ?? 1) * 100);
      setStatus(
        (p.violationCount
          ? i18n.t('activity:design.verifyOffPalette', {
              pct,
              count: p.violationCount,
              files: p.filesScanned,
            })
          : i18n.t('activity:design.verifyClean', { files: p.filesScanned })) + basis,
      );
    };
    const onDraw = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as {
          payload?: {
            ok?: boolean;
            seed?: string;
            macrostructure?: { label?: string };
            opening?: { label?: string };
            markdown?: string;
            error?: string;
          };
        }
      ).payload;
      if (!p?.ok) {
        setStatus(`Draw failed: ${p?.error ?? 'error'}`);
        return;
      }
      setStatus(`Drew ${p.macrostructure?.label ?? 'anatomy'} (${p.seed ?? 'seed'})`);
      setStudioNote(p.markdown ?? null);
    };
    const onSnap = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as {
          payload?: {
            ok?: boolean;
            path?: string;
            filesScanned?: number;
            routes?: string[];
            error?: string;
          };
        }
      ).payload;
      setStatus(
        p?.ok
          ? `Snapshot ${p.path ?? '.design/before.json'} (${p.filesScanned ?? 0} files, ${p.routes?.length ?? 0} routes)`
          : `Snapshot failed: ${p?.error ?? 'error'}`,
      );
    };
    const onKept = (msg: unknown) => {
      if (isForeign(msg)) return;
      const p = (
        msg as {
          payload?: { ok?: boolean; clean?: boolean; markdown?: string; error?: string };
        }
      ).payload;
      if (!p?.ok) {
        setStatus(`Kept check failed: ${p?.error ?? 'error'}`);
        return;
      }
      setStatus(p.clean ? 'Kept: PASS (all wiring preserved)' : 'Kept: WARN (missing wiring)');
      setStudioNote(p.markdown ?? null);
    };
    const bindings: Array<[string, (m: unknown) => void]> = [
      ['design.list', onList],
      ['design.use', onUse],
      ['design.set', onSet],
      ['design.tune', onTune],
      ['design.swap', onSwap],
      ['design.materialize', onMat],
      ['design.verify', onVer],
      ['design.draw', onDraw],
      ['design.snapshot', onSnap],
      ['design.kept', onKept],
    ];
    for (const [ev, fn] of bindings) client.on(ev, fn);
    client.send({ type: 'design.list', payload: client.withSession({}) });
    return () => {
      for (const [ev, fn] of bindings) client.off(ev, fn);
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

  const drawAnatomy = useCallback(
    (hasPhoto?: boolean) => {
      client?.send({
        type: 'design.draw',
        payload: client.withSession({ material: hasPhoto ? 'photo' : 'product' }),
      });
    },
    [client],
  );

  const snapshotWiring = useCallback(() => {
    client?.send({ type: 'design.snapshot', payload: client.withSession({}) });
  }, [client]);

  const checkKept = useCallback(() => {
    client?.send({ type: 'design.kept', payload: client.withSession({}) });
  }, [client]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? kits.filter(
          (k) =>
            k.id.includes(needle) ||
            k.name.toLowerCase().includes(needle) ||
            k.aesthetic.toLowerCase().includes(needle) ||
            (k.material ?? '').toLowerCase().includes(needle) ||
            (k.posture ?? '').toLowerCase().includes(needle) ||
            (k.axes
              ? `${k.axes.paper}/${k.axes.display}/${k.axes.accent}`.toLowerCase().includes(needle)
              : false) ||
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
        <div className="ws-page-header rounded-xl border border-border/70">
          <PageMotif kind="library" />
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
                      photo={kit.photo}
                    />
                    <KitPreview
                      t={applyOv(kit.dark, ov, 'dark')}
                      label={t('activity:designStudio.dark')}
                      photo={kit.photo}
                    />
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 border-t border-border/60 bg-card p-3">
                    <div className="flex items-center gap-1.5">
                      <h3 className="text-sm font-semibold truncate">{kit.name}</h3>
                      <code className="text-[10px] text-muted-foreground">{kit.id}</code>
                      {isActive && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-foreground ml-auto">
                          <Check className="w-3 h-3 text-primary" /> {t('activity:design.active')}
                        </span>
                      )}
                    </div>
                    {(kit.axes || kit.posture || kit.photo) && (
                      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                        {kit.axes && (
                          <span className="rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono">
                            {kit.axes.paper}/{kit.axes.display}/{kit.axes.accent}
                          </span>
                        )}
                        {kit.posture && (
                          <span className="rounded border border-border/60 px-1.5 py-0.5">
                            {kit.posture}
                          </span>
                        )}
                        {kit.photo && (
                          <span className="rounded border border-border/60 px-1.5 py-0.5 font-mono">
                            photo: {kit.photo}
                          </span>
                        )}
                      </div>
                    )}
                    <p className="text-[11px] text-muted-foreground leading-snug">
                      {kit.aesthetic}
                    </p>
                    {kit.material && (
                      <p className="line-clamp-2 text-[10px] text-muted-foreground/85 leading-snug">
                        {kit.material}
                      </p>
                    )}
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => useKit(kit.id)}
                        className={cn(
                          'rounded-md px-2.5 py-1 text-[11px] font-medium transition',
                          isActive
                            ? 'bg-primary/10 text-foreground'
                            : 'bg-primary text-primary-foreground hover:opacity-90',
                        )}
                      >
                        {isActive ? t('activity:design.reapply') : t('activity:design.use')}
                      </button>
                      {isActive &&
                        [
                          {
                            key: 'mat',
                            onClick: materialize,
                            title: t('activity:design.materializeTitle', { stack }),
                            icon: Download,
                            label: t('activity:design.materialize'),
                          },
                          {
                            key: 'ver',
                            onClick: verify,
                            title: t('activity:design.verifyTitle'),
                            icon: ShieldCheck,
                            label: t('activity:design.verify'),
                          },
                          {
                            key: 'draw',
                            onClick: () => drawAnatomy(Boolean(kit.photo)),
                            title: 'Draw job-native page anatomy (design.draw)',
                            icon: Compass,
                            label: 'Draw',
                          },
                          {
                            key: 'snap',
                            onClick: snapshotWiring,
                            title: 'Snapshot interactive wiring before redesign (design.snapshot)',
                            icon: Camera,
                            label: 'Snapshot',
                          },
                          {
                            key: 'kept',
                            onClick: checkKept,
                            title: 'Audit preserved wiring after redesign (design.kept)',
                            icon: History,
                            label: 'Kept',
                          },
                        ].map(({ key, onClick, title, icon: Icon, label }) => (
                          <button
                            key={key}
                            type="button"
                            onClick={onClick}
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-1 text-[11px] font-medium hover:bg-muted"
                            title={title}
                          >
                            <Icon className="w-3 h-3" /> {label}
                          </button>
                        ))}
                      <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
                        {kit.bestFor}
                      </span>
                    </div>
                    {isActive && studioNote && (
                      <div className="mt-1 rounded-lg border border-border/60 bg-muted/30 p-2 text-[10px]">
                        <div className="mb-1 flex items-center justify-between">
                          <span className="font-mono font-semibold uppercase text-muted-foreground">
                            Studio Output
                          </span>
                          <button
                            type="button"
                            onClick={() => setStudioNote(null)}
                            className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            ×
                          </button>
                        </div>
                        <pre className="max-h-36 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-relaxed text-foreground/90">
                          {studioNote}
                        </pre>
                      </div>
                    )}
                    {isActive && <ColorEditor kit={kit} overrides={ov} onSet={setOverride} />}
                    {isActive && <TuneEditor onTune={tuneKit} />}
                    {isActive && <ContrastBadges issues={contrastIssues} />}
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
