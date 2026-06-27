/**
 * DesignStudioPanel — visual browser for curated UI design kits.
 *
 * Lists every bundled/project/user kit with light + dark token swatches and a
 * "Use" button that pins the kit on the live agent (via the `design.use` WS
 * message), so the model adheres to it on the next turn. Mirrors SkillsList's
 * WS pattern (client.on / client.send / client.off).
 */

import { Check, Loader2, Palette } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { cn } from '@/lib/utils';

interface KitSummary {
  id: string;
  name: string;
  aesthetic: string;
  bestFor: string;
  stacks: string[];
  tags: string[];
  light: Record<string, string>;
  dark: Record<string, string>;
}

const STACKS = ['web', 'react-native', 'flutter', 'swiftui', 'compose'] as const;
const SWATCH_KEYS = ['bg', 'surface', 'primary', 'accent', 'fg', 'border'];

function Swatches({ tokens, label }: { tokens: Record<string, string>; label: string }) {
  const keys = SWATCH_KEYS.filter((k) => tokens[k]);
  if (keys.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground w-7">{label}</span>
      <div className="flex gap-0.5">
        {keys.map((k) => (
          <div
            key={k}
            className="w-4 h-4 rounded-sm border border-black/10 dark:border-white/10"
            style={{ backgroundColor: tokens[k] }}
            title={`${k}: ${tokens[k]}`}
          />
        ))}
      </div>
    </div>
  );
}

export function DesignStudioPanel({ className }: { className?: string }) {
  const { client } = useWebSocket();
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [activeKit, setActiveKit] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [stack, setStack] = useState<string>('web');
  const [busyKit, setBusyKit] = useState<string | null>(null);

  useEffect(() => {
    if (!client) return;
    const onList = (msg: unknown) => {
      const p = (msg as { payload?: { kits?: KitSummary[]; activeKit?: string | null } }).payload;
      setKits(p?.kits ?? []);
      setActiveKit(p?.activeKit ?? null);
      setLoading(false);
    };
    const onUse = (msg: unknown) => {
      const p = (msg as { payload?: { ok?: boolean; kit?: string } }).payload;
      setBusyKit(null);
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
    (id: string) => {
      if (!client) return;
      setBusyKit(id);
      client.send({ type: 'design.use', payload: { kit: id, stack } });
    },
    [client, stack],
  );

  const sortedKits = useMemo(() => [...kits].sort((a, b) => a.name.localeCompare(b.name)), [kits]);

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <Palette className="w-4 h-4 text-muted-foreground" />
        <span className="text-xs text-muted-foreground flex-1">
          Pick a kit — the agent will adhere to it.
        </span>
        <select
          value={stack}
          onChange={(e) => setStack(e.target.value)}
          className="text-[11px] bg-transparent border border-border/60 rounded px-1 py-0.5"
          title="Target stack"
        >
          {STACKS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {loading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-3">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading kits…
          </div>
        )}
        {!loading && sortedKits.length === 0 && (
          <p className="text-sm text-muted-foreground p-3">No design kits found.</p>
        )}
        {sortedKits.map((kit) => {
          const isActive = activeKit === kit.id;
          return (
            <div
              key={kit.id}
              className={cn(
                'rounded-lg border p-3 transition-colors',
                isActive
                  ? 'border-primary/60 bg-primary/5'
                  : 'border-border/60 hover:border-border',
              )}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <h3 className="text-sm font-semibold truncate">{kit.name}</h3>
                    {isActive && (
                      <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold uppercase text-primary">
                        <Check className="w-3 h-3" /> Active
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">
                    {kit.aesthetic}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => useKit(kit.id)}
                  disabled={busyKit === kit.id}
                  className={cn(
                    'shrink-0 text-[11px] px-2 py-1 rounded font-medium',
                    isActive
                      ? 'bg-primary/10 text-primary'
                      : 'bg-primary text-primary-foreground hover:opacity-90',
                  )}
                >
                  {busyKit === kit.id ? '…' : isActive ? 'Reapply' : 'Use'}
                </button>
              </div>

              <div className="mt-2 space-y-1">
                <Swatches tokens={kit.light} label="Light" />
                <Swatches tokens={kit.dark} label="Dark" />
              </div>

              {kit.bestFor && (
                <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
                  <span className="font-medium">Best for:</span> {kit.bestFor}
                </p>
              )}
              <div className="flex flex-wrap gap-1 mt-1.5">
                {kit.stacks.map((s) => (
                  <span
                    key={s}
                    className="text-[9px] px-1 py-0.5 rounded bg-muted text-muted-foreground"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
