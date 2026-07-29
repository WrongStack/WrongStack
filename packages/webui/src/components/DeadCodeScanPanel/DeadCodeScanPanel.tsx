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
import type {
  DeadCodeScanOutput,
  DeadFile,
  DeadPackage,
  DeadSymbol,
} from '@wrongstack/tools/codebase-index';

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

const PRIORITY_COLORS: Record<number, string> = {
  0: '#ef4444',
  1: '#f59e0b',
  2: '#3b82f6',
};

export function DeadCodeScanPanel({ projectRoot }: { projectRoot: string }) {
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
        const err = (await res.json()) as { error?: string; detail?: string };
        throw new Error(err.detail ?? err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as DeadCodeScanOutput;
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
    try {
      const res = await fetch('/api/deadcode/action-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scanResult),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string; detail?: string };
        throw new Error(err.detail ?? err.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ActionPlan;
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
    // We fire a session message through the existing completion-handler
    // protocol so the current agent processes the cleanup plan.
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
    <div style={{ padding: '16px', fontFamily: 'system-ui, sans-serif' }}>
      <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: 600 }}>
        🔍 Dead-Code Scan
      </h2>

      {/* Scan button */}
      <button
        onClick={handleScan}
        disabled={scanPhase === 'scanning'}
        style={{
          padding: '8px 16px',
          fontSize: '14px',
          fontWeight: 500,
          background: scanPhase === 'scanning' ? '#94a3b8' : '#3b82f6',
          color: '#fff',
          border: 'none',
          borderRadius: '6px',
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
            background: '#fef2f2',
            color: '#991b1b',
            borderRadius: '6px',
            fontSize: '13px',
          }}
        >
          {error}
          <button
            onClick={() => setError(null)}
            style={{
              marginLeft: '12px',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
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
            <StatCard label="Total Symbols" value={scanResult.stats.totalSymbols} color="#6366f1" />
            <StatCard label="Alive" value={scanResult.stats.alive} color="#22c55e" />
            <StatCard label="Dead" value={scanResult.stats.dead} color="#ef4444" />
          </div>

          {scanResult.deadPackages.length > 0 && (
            <ResultSection title={`Dead Packages (${scanResult.deadPackages.length})`} color="#ef4444">
              {scanResult.deadPackages.map((pkg) => (
                <ResultRow key={pkg.package} columns={[pkg.package, pkg.path, `${pkg.fileCount} file(s)`]} />
              ))}
            </ResultSection>
          )}

          {scanResult.deadFiles.length > 0 && (
            <ResultSection title={`Dead Files (${scanResult.deadFiles.length})`} color="#f59e0b">
              {scanResult.deadFiles.map((f) => (
                <ResultRow key={f.file} columns={[f.file, `${f.symbolCount} symbol(s)`, f.lang]} />
              ))}
            </ResultSection>
          )}

          {scanResult.deadSymbols.length > 0 && (
            <ResultSection title={`Dead Symbols (${scanResult.deadSymbols.length})`} color="#3b82f6">
              {scanResult.deadSymbols.slice(0, 50).map((s) => (
                <ResultRow
                  key={`${s.file}:${s.line}:${s.name}`}
                  columns={[s.name, s.kind, s.file.split('/').pop() ?? s.file, `line ${s.line}`]}
                />
              ))}
              {scanResult.deadSymbols.length > 50 && (
                <div style={{ padding: '6px 8px', color: '#64748b', fontSize: '12px' }}>
                  … and {scanResult.deadSymbols.length - 50} more
                </div>
              )}
            </ResultSection>
          )}

          {/* Action Plan section */}
          {scanPhase === 'done' && (
            <button
              onClick={handleGeneratePlan}
              disabled={planPhase === 'generating'}
              style={{
                marginTop: '12px',
                padding: '8px 16px',
                fontSize: '14px',
                fontWeight: 500,
                background: planPhase === 'generating' ? '#94a3b8' : '#8b5cf6',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
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
            border: '1px solid #e2e8f0',
            borderRadius: '8px',
            padding: '12px',
            background: '#fafafa',
          }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: '15px', fontWeight: 600 }}>
            📋 Action Plan
          </h3>
          <p style={{ fontSize: '13px', color: '#475569', margin: '0 0 12px' }}>
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
                borderBottom: i < actionPlan.files.length - 1 ? '1px solid #e2e8f0' : 'none',
                fontSize: '13px',
              }}
            >
              <span
                style={{
                  background: PRIORITY_COLORS[file.priority] ?? '#94a3b8',
                  color: '#fff',
                  borderRadius: '4px',
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
                  }}
                >
                  {file.file}
                </div>
                <div style={{ color: '#64748b', fontSize: '12px' }}>
                  {file.symbolCount} symbol(s)
                  {file.symbols.length > 0 && ` · ${file.symbols.slice(0, 2).join(', ')}${file.symbols.length > 2 ? '…' : ''}`}
                </div>
              </div>
            </div>
          ))}

          <button
            onClick={handleExecutePlan}
            disabled={planPhase === 'executing'}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              fontSize: '14px',
              fontWeight: 500,
              background: planPhase === 'executing' ? '#94a3b8' : '#22c55e',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
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

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        flex: 1,
        padding: '10px',
        borderRadius: '8px',
        border: `1px solid ${color}22`,
        background: `${color}08`,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: '24px', fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{label}</div>
    </div>
  );
}

function ResultSection({
  title,
  color,
  children,
}: {
  title: string;
  color: string;
  children: React.ReactNode;
}) {
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
          border: '1px solid #e2e8f0',
          borderRadius: '6px',
          overflow: 'hidden',
          fontSize: '13px',
        }}
      >
        {children}
      </div>
    </div>
  );
}

function ResultRow({
  columns,
}: {
  columns: string[];
}) {
  return (
    <div
      style={{
        display: 'flex',
        gap: '8px',
        padding: '5px 8px',
        borderBottom: '1px solid #f1f5f9',
        fontSize: '13px',
        fontFamily: 'monospace',
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
