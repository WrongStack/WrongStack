/**
 * Dead Code Scan Panel — runs the dead-code analysis tool on the
 * server and displays results with action-plan generation.
 *
 * Flow:
 * 1. User clicks "Scan for Dead Code"
 * 2. POST /api/deadcode/scan → returns dead symbols/files/packages
 * 3. Results displayed in categorized tables
 * 4. User clicks "Generate Action Plan" → POST /api/deadcode/action-plan
 * 5. Action plan displayed with "Execute Plan" button
 * 6. Execute sends a message to the current agent via WS to perform cleanup
 */

import { useCallback, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import type { DeadCodeScanOutput, DeadFile, DeadSymbol } from '@wrongstack/tools/codebase-index';

// ─── Action plan types (server response) ─────────────────────────────────

interface ActionPlanFile {
  file: string;
  symbolCount: number;
  symbols: string[];
  priority: number;
}

interface ActionPlan {
  summary: string;
  files: ActionPlanFile[];
  totalDeadSymbols: number;
  totalDeadPackages: number;
  totalDeadFiles: number;
}

type ScanPhase = 'idle' | 'scanning' | 'done' | 'error';
type PlanPhase = 'idle' | 'generating' | 'ready' | 'executing';

const PRIORITY_NAMES: Record<number, string> = {
  0: 'P0 Dead Package',
  1: 'P1 Dead File',
  2: 'P2 Dead Symbol',
};

// Semantic priority roles → theme tokens, not raw hex.
// Each maps to a CSS custom property that adapts to light/dark automatically.
const PRIORITY_TOKEN: Record<number, string> = {
  0: 'hsl(var(--destructive))', // P0 — worst, destructive red
  1: 'hsl(var(--warning))', // P1 — caution amber
  2: 'hsl(var(--info))', // P2 — informational blue
};

/**
 * Safely parse a fetch Response as JSON.
 *
 * The backend should always return JSON, but if the server is misconfigured
 * or the SPA fallback serves index.html, the body will be HTML. Reading
 * `.text()` first and then `JSON.parse` lets us catch that gracefully
 * and surface a useful error instead of the cryptic
 * `Unexpected token '<', "<!doctype "... is not valid JSON`.
 */
async function safeJsonParse<T>(res: Response): Promise<T> {
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Log the raw body (truncated) for debugging.
    const preview = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw;
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'deadcode_parse_error',
        preview,
        timestamp: new Date().toISOString(),
      }),
    );
    throw new Error(
      'The server returned a non-JSON response (possibly an HTML error page). ' +
        'Check that the backend is running and the /api/deadcode/* routes are wired.',
    );
  }
}

export function DeadCodeScanPanel() {
  const { t } = useAppTranslation();
  const [scanPhase, setScanPhase] = useState<ScanPhase>('idle');
  const [planPhase, setPlanPhase] = useState<PlanPhase>('idle');
  const [scanResult, setScanResult] = useState<DeadCodeScanOutput | null>(null);
  const [actionPlan, setActionPlan] = useState<ActionPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleScan = useCallback(async () => {
    setScanPhase('scanning');
    setError(null);
    setScanResult(null);
    setActionPlan(null);
    setPlanPhase('idle');
    try {
      const res = await fetch('/api/deadcode/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await safeJsonParse<{ error?: string; detail?: string }>(res);
        throw new Error(err.detail ?? err.error ?? `HTTP ${res.status}`);
      }
      const data = await safeJsonParse<DeadCodeScanOutput>(res);
      setScanResult(data);
      setScanPhase('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setScanPhase('error');
    }
  }, []);

  const handleGeneratePlan = useCallback(async () => {
    if (!scanResult) return;
    setPlanPhase('generating');
    setError(null);
    try {
      const res = await fetch('/api/deadcode/action-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scanResult),
      });
      if (!res.ok) {
        const err = await safeJsonParse<{ error?: string; detail?: string }>(res);
        throw new Error(err.detail ?? err.error ?? `HTTP ${res.status}`);
      }
      const data = await safeJsonParse<ActionPlan>(res);
      setActionPlan(data);
      setPlanPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPlanPhase('idle');
    }
  }, [scanResult]);

  const handleExecutePlan = useCallback(() => {
    if (!actionPlan) return;
    setPlanPhase('executing');

    // Build a structured prompt for the agent to execute the plan.
    const prompt = [
      '# Dead-Code Cleanup Plan',
      '',
      actionPlan.summary,
      '',
      '## Files to address (in priority order)',
      ...actionPlan.files.map(
        (f, i) =>
          `${i + 1}. [${PRIORITY_NAMES[f.priority]}] ${f.file}` +
          ` — ${f.symbolCount} symbol(s) to remove` +
          (f.symbols.length > 0
            ? `\n   Symbols: ${f.symbols.slice(0, 5).join(', ')}${f.symbols.length > 5 ? ` and ${f.symbols.length - 5} more` : ''}`
            : ''),
      ),
    ].join('\n');

    // Dispatch a new agent task via the WebSocket's message system.
    const ws = (window as typeof window & { __WS?: WebSocket }).__WS;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'user.message',
          payload: {
            text: prompt,
            action: 'send',
          },
        }),
      );
    } else {
      // Fallback: copy to clipboard and notify.
      void navigator.clipboard.writeText(prompt);
      setError('Agent not connected. Plan copied to clipboard — paste it into the chat.');
    }
    setPlanPhase('idle');
  }, [actionPlan]);

  return (
    <div
      style={{
        padding: '16px',
        fontFamily: 'var(--font-sans, system-ui, sans-serif)',
        color: 'hsl(var(--foreground))',
        background: 'hsl(var(--background))',
      }}
    >
      <h2
        style={{
          margin: '0 0 16px',
          fontSize: '18px',
          fontWeight: 600,
          color: 'hsl(var(--foreground))',
        }}
      >
        {t('activity:deadCode.deadCodeScan')}
      </h2>

      {/* Scan button */}
      <button
        type="button"
        onClick={handleScan}
        disabled={scanPhase === 'scanning'}
        style={{
          padding: '8px 16px',
          fontSize: '14px',
          fontWeight: 500,
          background: scanPhase === 'scanning' ? 'hsl(var(--muted))' : 'hsl(var(--primary))',
          color:
            scanPhase === 'scanning'
              ? 'hsl(var(--muted-foreground))'
              : 'hsl(var(--primary-foreground))',
          border: '1px solid hsl(var(--border))',
          borderRadius: '0',
          cursor: scanPhase === 'scanning' ? 'not-allowed' : 'pointer',
        }}
      >
        {scanPhase === 'scanning' ? 'Scanning…' : 'Scan for Dead Code'}
      </button>

      {/* Error display */}
      {error && (
        <div
          style={{
            marginTop: '12px',
            padding: '8px 12px',
            background: 'hsl(var(--destructive) / 0.1)',
            color: 'hsl(var(--destructive))',
            border: '1px solid hsl(var(--destructive) / 0.3)',
            borderRadius: '0',
            fontSize: '13px',
          }}
        >
          {error}
          <button
            type="button"
            onClick={() => setError(null)}
            style={{
              marginLeft: '12px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              color: 'hsl(var(--destructive))',
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Scan results */}
      {scanResult && (
        <div style={{ marginTop: '16px' }}>
          <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
            <StatCard
              label={t('activity:deadCode.totalSymbols')}
              value={scanResult.stats.totalSymbols}
              token="info"
            />
            <StatCard
              label={t('activity:deadCode.alive')}
              value={scanResult.stats.alive}
              token="success"
            />
            <StatCard
              label={t('activity:deadCode.dead')}
              value={scanResult.stats.dead}
              token="destructive"
            />
          </div>

          {scanResult.deadPackages.length > 0 && (
            <ResultSection
              title={`Dead Packages (${scanResult.deadPackages.length})`}
              token="destructive"
            >
              {scanResult.deadPackages.map((pkg) => (
                <ResultRow
                  key={pkg.package}
                  columns={[pkg.package, pkg.path, `${pkg.fileCount} file(s)`]}
                />
              ))}
            </ResultSection>
          )}

          {scanResult.deadFiles.length > 0 && (
            <ResultSection title={`Dead Files (${scanResult.deadFiles.length})`} token="warning">
              {scanResult.deadFiles.map((f: DeadFile) => (
                <ResultRow key={f.file} columns={[f.file, `${f.symbolCount} symbol(s)`, f.lang]} />
              ))}
            </ResultSection>
          )}

          {scanResult.deadSymbols.length > 0 && (
            <ResultSection title={`Dead Symbols (${scanResult.deadSymbols.length})`} token="info">
              {scanResult.deadSymbols.slice(0, 50).map((s: DeadSymbol) => (
                <ResultRow
                  key={`${s.file}:${s.line}:${s.name}`}
                  columns={[s.name, s.kind, s.file.split('/').pop() ?? s.file, `line ${s.line}`]}
                />
              ))}
              {scanResult.deadSymbols.length > 50 && (
                <div
                  style={{
                    padding: '6px 8px',
                    color: 'hsl(var(--muted-foreground))',
                    fontSize: '12px',
                  }}
                >
                  … and {scanResult.deadSymbols.length - 50} more
                </div>
              )}
            </ResultSection>
          )}

          {/* Action Plan section */}
          {scanPhase === 'done' && (
            <button
              type="button"
              onClick={handleGeneratePlan}
              disabled={planPhase === 'generating'}
              style={{
                marginTop: '12px',
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 500,
                background: planPhase === 'generating' ? 'hsl(var(--muted))' : 'hsl(var(--accent))',
                color:
                  planPhase === 'generating'
                    ? 'hsl(var(--muted-foreground))'
                    : 'hsl(var(--accent-foreground))',
                border: '1px solid hsl(var(--border))',
                borderRadius: '0',
                cursor: planPhase === 'generating' ? 'not-allowed' : 'pointer',
              }}
            >
              {planPhase === 'generating' ? 'Generating…' : 'Generate Action Plan'}
            </button>
          )}
        </div>
      )}

      {/* Action plan */}
      {actionPlan && (
        <div
          style={{
            marginTop: '16px',
            border: '1px solid hsl(var(--border))',
            borderRadius: '0',
            padding: '12px',
            background: 'hsl(var(--card))',
          }}
        >
          <h3
            style={{
              margin: '0 0 8px',
              fontSize: '15px',
              fontWeight: 600,
              color: 'hsl(var(--card-foreground))',
            }}
          >
            {t('activity:deadCode.actionPlan')}
          </h3>
          <p
            style={{
              fontSize: '13px',
              color: 'hsl(var(--muted-foreground))',
              margin: '0 0 12px',
            }}
          >
            {actionPlan.summary}
          </p>

          {actionPlan.files.map((file, i) => (
            <div
              key={file.file}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px',
                padding: '6px 0',
                borderBottom:
                  i < actionPlan.files.length - 1 ? '1px solid hsl(var(--border))' : 'none',
                fontSize: '13px',
              }}
            >
              <span
                style={{
                  background: PRIORITY_TOKEN[file.priority] ?? 'hsl(var(--muted-foreground))',
                  color: 'hsl(var(--primary-foreground))',
                  borderRadius: '0',
                  padding: '2px 6px',
                  fontSize: '11px',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {PRIORITY_NAMES[file.priority] ?? `P${file.priority}`}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 500,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: 'hsl(var(--foreground))',
                  }}
                >
                  {file.file}
                </div>
                <div style={{ color: 'hsl(var(--muted-foreground))', fontSize: '12px' }}>
                  {file.symbolCount} symbol(s)
                  {file.symbols.length > 0 &&
                    ` · ${file.symbols.slice(0, 2).join(', ')}${file.symbols.length > 2 ? '…' : ''}`}
                </div>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={handleExecutePlan}
            disabled={planPhase === 'executing'}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              background: planPhase === 'executing' ? 'hsl(var(--muted))' : 'hsl(var(--success))',
              color: 'hsl(var(--primary-foreground))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '0',
              cursor: planPhase === 'executing' ? 'not-allowed' : 'pointer',
            }}
          >
            {planPhase === 'executing' ? 'Sending…' : 'Execute Plan via Agent'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────

type SemanticToken = 'success' | 'warning' | 'info' | 'destructive' | 'primary';

const TOKEN_COLORS: Record<SemanticToken, string> = {
  success: 'hsl(var(--success))',
  warning: 'hsl(var(--warning))',
  info: 'hsl(var(--info))',
  destructive: 'hsl(var(--destructive))',
  primary: 'hsl(var(--primary))',
};

function StatCard({ label, value, token }: { label: string; value: number; token: SemanticToken }) {
  const color = TOKEN_COLORS[token];
  return (
    <div
      style={{
        flex: 1,
        padding: '10px',
        borderRadius: '0',
        border: `1px solid hsl(var(--border))`,
        background: 'hsl(var(--card))',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '24px', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', marginTop: '2px' }}>
        {label}
      </div>
    </div>
  );
}

function ResultSection({
  title,
  token,
  children,
}: {
  title: string;
  token: SemanticToken;
  children: React.ReactNode;
}) {
  const color = TOKEN_COLORS[token];
  return (
    <div style={{ marginBottom: '12px' }}>
      <h3
        style={{
          margin: '0 0 6px',
          fontSize: '14px',
          fontWeight: 600,
          color,
          borderLeft: `3px solid ${color}`,
          paddingLeft: '8px',
        }}
      >
        {title}
      </h3>
      <div
        style={{
          border: '1px solid hsl(var(--border))',
          borderRadius: '0',
          overflow: 'hidden',
          fontSize: '13px',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ResultRow({ columns }: { columns: string[] }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        padding: '5px 8px',
        borderBottom: '1px solid hsl(var(--border))',
        fontSize: '13px',
        fontFamily: 'var(--font-mono, monospace)',
        background: 'hsl(var(--card))',
        color: 'hsl(var(--card-foreground))',
      }}
    >
      {columns.map((col, i) => (
        <span
          key={i}
          style={{
            flex: i === 0 ? 2 : 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {col}
        </span>
      ))}
    </div>
  );
}
