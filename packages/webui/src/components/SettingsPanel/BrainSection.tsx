import { Brain, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useWebSocket } from '@/hooks/useWebSocket';
import type { WSServerMessage } from '@/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';

const RISK_LEVELS = ['off', 'low', 'medium', 'high', 'all'] as const;
type RiskLevel = (typeof RISK_LEVELS)[number];

const RISK_COLORS: Record<RiskLevel, string> = {
  off: 'bg-gray-500',
  low: 'bg-green-500',
  medium: 'bg-yellow-500',
  high: 'bg-orange-500',
  all: 'bg-red-500',
};

function RiskDot({ level }: { level: RiskLevel }) {
  return <span className={`inline-block w-3 h-3 rounded-full ${RISK_COLORS[level]}`} />;
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
      <div className="flex items-center gap-2">
        <Brain className="h-5 w-5 text-purple-500" />
        <h3 className="text-lg font-semibold">Brain</h3>
        {loading && <Loader2 className="h-4 w-4 animate-spin ml-2" />}
      </div>

      {/* Risk ceiling */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Autonomy ceiling</label>
        <div className="flex gap-2 flex-wrap">
          {RISK_LEVELS.map((level) => (
            <Button
              key={level}
              variant={riskLevel === level ? 'default' : 'outline'}
              size="sm"
              className="gap-1.5 text-xs"
              disabled={busy}
              onClick={() => handleRiskChange(level)}
            >
              <RiskDot level={level} />
              {level.toUpperCase()}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {riskLevel === 'off' && 'Human decides everything'}
          {riskLevel === 'low' && 'Auto-decide low risk only'}
          {riskLevel === 'medium' && 'Auto-decide up to medium risk'}
          {riskLevel === 'high' && 'Auto-decide up to high risk'}
          {riskLevel === 'all' && 'Auto-decide everything'}
        </p>
      </div>

      {/* Recent decisions */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Recent decisions ({log.length})</label>
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">No decisions recorded yet this session.</p>
          ) : (
            log.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 text-xs py-1 border-b border-border last:border-0">
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
