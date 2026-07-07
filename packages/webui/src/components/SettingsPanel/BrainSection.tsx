import { Brain, Loader2 } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { WSServerMessage } from '@/types';
import { cn } from '@/lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

const RISK_LEVELS = ['off', 'low', 'medium', 'high', 'all'] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_COLORS: Record<RiskLevel, string> = {
  off: 'bg-muted-foreground',
  low: 'bg-success',
  medium: 'bg-warning',
  high: 'bg-warning ring-2 ring-warning/25',
  all: 'bg-destructive',
};

const RISK_COPY: Record<RiskLevel, string> = {
  off: 'Human decides everything',
  low: 'Auto-decide low risk only',
  medium: 'Auto-decide up to medium risk',
  high: 'Auto-decide up to high risk',
  all: 'Auto-decide everything',
};

function RiskDot({ level }: { level: RiskLevel }) {
  return <span className={cn('inline-block h-2.5 w-2.5 rounded-full', RISK_COLORS[level])} />;
}

export function BrainSection(): ReactElement {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium');
  const [log, setLog] = useState<Array<{ kind: string; question: string; outcome: string; age: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Fetch brain status on mount
  useEffect(() => {
    client.send({ type: 'brain.status' });
  }, [client]);

  // Listen for brain status responses
  useEffect(() => {
    const handler = (msg: WSServerMessage) => {
      if (msg.type === 'brain.status') {
        const p = msg.payload as {
          maxAutoRisk: string;
          log: Array<{ at: number; kind: string; question: string; outcome: string }>;
        };
        setRiskLevel((RISK_LEVELS as readonly string[]).includes(p.maxAutoRisk) ? (p.maxAutoRisk as RiskLevel) : 'medium');
        const now = Date.now();
        setLog(
          p.log.slice(-10).map((entry) => {
            const s = Math.max(0, Math.round((now - entry.at) / 1000));
            const age = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
            return { kind: entry.kind, question: entry.question, outcome: entry.outcome, age };
          }),
        );
        setLoading(false);
      }
    };
    client.on('message', handler);
    return () => client.off('message', handler);
  }, [client]);

  const handleRiskChange = useCallback(
    (level: RiskLevel) => {
      setBusy(true);
      client.send({ type: 'brain.risk', payload: { level } });
      setRiskLevel(level);
      // Refresh status after a short delay
      setTimeout(() => {
        client.send({ type: 'brain.status' });
        setBusy(false);
      }, 500);
    },
    [client],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
          <Brain className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold">Brain</h3>
          <p className="text-xs text-muted-foreground">Decision routing and autonomous risk ceiling.</p>
        </div>
        {loading && <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {/* Risk ceiling */}
      <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
        <label className="text-sm font-medium">Autonomy ceiling</label>
        <div className="flex gap-2 flex-wrap">
          {RISK_LEVELS.map((level) => (
            <Button
              key={level}
              variant={riskLevel === level ? 'default' : 'outline'}
              size="sm"
              className={cn(
                'gap-1.5 text-xs',
                riskLevel === level && 'shadow-sm',
              )}
              disabled={busy}
              onClick={() => handleRiskChange(level)}
            >
              <RiskDot level={level} />
              {level.toUpperCase()}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {RISK_COPY[riskLevel]}
        </p>
      </div>

      {/* Recent decisions */}
      <div className="space-y-2 rounded-md border border-border/70 bg-card/70 p-3">
        <label className="text-sm font-medium">Recent decisions ({log.length})</label>
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No decisions recorded yet this session.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-xs">
                <span className="text-muted-foreground shrink-0 w-8">{entry.age}</span>
                <Badge variant="outline" className="text-[10px] shrink-0">{entry.kind}</Badge>
                <span className="flex-1 truncate">{entry.question}</span>
                {entry.outcome && (
                  <span className="text-muted-foreground shrink-0 italic">{entry.outcome}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
