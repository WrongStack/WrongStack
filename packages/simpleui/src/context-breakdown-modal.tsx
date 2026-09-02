import { BarChart3, MessageSquare, Minimize2, RefreshCw, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from './hooks/use-focus-trap.js';
import { type SocketRequestHandle, socketRequest } from './lib/socket-request.js';
import { compactTokens, formatUptime } from './lib/session-helpers.js';
import type { SimpleSocket } from './lib/ws.js';
import type { ContextInfo } from './types.js';

/**
 * Parsed `context.debug` reply. Mirrors `ContextBreakdown` in
 * webui-server/src/server/token-estimator.ts plus the `mode`/`policy` fields
 * the session handler layers on from `context.meta`.
 */
export interface ContextDebugPayload {
  total: number;
  mode?: string | undefined;
  systemPrompt: number;
  tools: { total: number; count: number; breakdown: Array<{ name: string; tokens: number }> };
  messages: {
    total: number;
    count: number;
    breakdown: Array<{ index: number; role: string; tokens: number; preview: string }>;
  };
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Defensive parse of the wire payload. The `context.debug` reply arrives as
 * `Record<string, unknown>`, so every field is coerced through a finite-number
 * or string guard instead of being trusted by cast. Returns `null` when the
 * top-level shape is unusable (missing tools/messages sections).
 */
export function parseContextDebugPayload(payload: unknown): ContextDebugPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const tools = p['tools'];
  const messages = p['messages'];
  if (!tools || typeof tools !== 'object' || !messages || typeof messages !== 'object') {
    return null;
  }
  const t = tools as Record<string, unknown>;
  const m = messages as Record<string, unknown>;
  const toolBreakdown = Array.isArray(t['breakdown']) ? (t['breakdown'] as unknown[]) : [];
  const messageBreakdown = Array.isArray(m['breakdown']) ? (m['breakdown'] as unknown[]) : [];
  return {
    total: finiteNumber(p['total']),
    mode: typeof p['mode'] === 'string' ? p['mode'] : undefined,
    systemPrompt: finiteNumber(p['systemPrompt']),
    tools: {
      total: finiteNumber(t['total']),
      count: finiteNumber(t['count']),
      breakdown: toolBreakdown.map((entry) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        return { name: String(e['name'] ?? ''), tokens: finiteNumber(e['tokens']) };
      }),
    },
    messages: {
      total: finiteNumber(m['total']),
      count: finiteNumber(m['count']),
      breakdown: messageBreakdown.map((entry) => {
        const e = (entry ?? {}) as Record<string, unknown>;
        return {
          index: finiteNumber(e['index']),
          role: String(e['role'] ?? ''),
          tokens: finiteNumber(e['tokens']),
          preview: String(e['preview'] ?? ''),
        };
      }),
    },
  };
}

interface ContextBreakdownModalProps {
  open: boolean;
  onClose: () => void;
  socketRef: React.RefObject<SimpleSocket | null>;
  context: ContextInfo;
  sessionId: string | null;
  /** Epoch ms of the session start — drives the UPTIME summary card. */
  sessionStart: number | null;
  running: boolean;
  /** Compact the session context. The parent owns the send + close. */
  onCompact: () => void;
}

/** Width share of the mini bar, with a 2% floor so tiny rows stay visible. */
function barWidth(value: number, total: number): number {
  return total > 0 ? Math.max(2, Math.min(100, (value / total) * 100)) : 0;
}

function sharePct(value: number, total: number): string {
  return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';
}

/** Zone-derived color for a token value relative to its section total. */
function tokenClass(tokens: number, total: number): string {
  if (total <= 0) return 'muted';
  const share = tokens / total;
  if (share > 0.5) return 'danger';
  if (share > 0.25) return 'warning';
  if (share > 0.1) return 'accent';
  return 'muted';
}

function roleClass(role: string): string {
  if (role === 'user') return 'user';
  if (role === 'assistant') return 'assistant';
  if (role === 'tool') return 'tool';
  return 'other';
}

function roleColor(role: string): string {
  if (role === 'assistant') return 'var(--accent)';
  if (role === 'user') return 'var(--warning)';
  if (role === 'tool') return 'var(--success)';
  return 'var(--muted)';
}

export function ContextBreakdownModal({
  open,
  onClose,
  socketRef,
  context,
  sessionId,
  sessionStart,
  running,
  onCompact,
}: ContextBreakdownModalProps) {
  const [data, setData] = useState<ContextDebugPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Increment to restart the debug-data fetch (refresh button).
  const [refreshGen, setRefreshGen] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(dialogRef, open);

  // Tick the UPTIME summary card while the modal is open.
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);

  // Fetch debug data when the modal opens or refresh is requested. The reply
  // shares the `context.debug` type with the request; the correlated request
  // helper settles on the first reply (5s timeout) and cancels on unmount.
  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    setData(null);
    const socket = socketRef.current;
    if (!socket) {
      setLoading(false);
      setError('Not connected');
      return;
    }
    const payload: Record<string, unknown> = {};
    if (sessionId) payload['sessionId'] = sessionId;
    let handle: SocketRequestHandle;
    try {
      handle = socketRequest({
        socket,
        sendType: 'context.debug',
        payload,
        expectType: 'context.debug',
        timeoutMs: 5000,
      });
    } catch {
      setLoading(false);
      setError('Could not request context data');
      return;
    }
    void handle.promise.then((reply) => {
      if (!reply) {
        setLoading(false);
        setError('No response from server');
        return;
      }
      const parsed = parseContextDebugPayload(reply);
      if (!parsed) {
        setLoading(false);
        setError('Unexpected response from server');
        return;
      }
      setData(parsed);
      setLoading(false);
    });
    return () => handle.cancel();
  }, [open, socketRef, sessionId, refreshGen]);

  // Focus the close button and bind Escape while open.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const ctxPct =
    context.maxContext > 0
      ? Math.min(100, Math.round((context.tokens / context.maxContext) * 100))
      : 0;
  const categories = [
    { key: 'system', label: 'SYSTEM', value: data?.systemPrompt ?? 0, color: 'var(--accent)' },
    { key: 'tools', label: 'TOOLS', value: data?.tools.total ?? 0, color: 'var(--warning)' },
    {
      key: 'messages',
      label: 'MESSAGES',
      value: data?.messages.total ?? 0,
      color: 'var(--success)',
    },
  ];

  return (
    <>
      <button
        type="button"
        className="ctx-breakdown-overlay"
        tabIndex={-1}
        aria-label="Close context breakdown"
        onClick={onClose}
      />
      <div
        className="ctx-breakdown-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Context breakdown"
        ref={dialogRef}
        tabIndex={-1}
      >
        <header className="ctx-breakdown-head">
          <span className="ctx-breakdown-title">
            <BarChart3 size={13} aria-hidden="true" /> CONTEXT
          </span>
          <div className="ctx-breakdown-head-actions">
            <button
              type="button"
              className="ctx-breakdown-icon-btn"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => setRefreshGen((gen) => gen + 1)}
            >
              <RefreshCw
                size={13}
                className={loading ? 'ctx-spin' : undefined}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              className="ctx-breakdown-icon-btn"
              aria-label="Close"
              title="Close"
              onClick={onClose}
              ref={closeRef}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        </header>

        <div className="ctx-breakdown-body">
          {loading ? (
            <div className="ctx-breakdown-status">FETCHING…</div>
          ) : error ? (
            <div className="ctx-breakdown-status error" role="alert">
              {error}
            </div>
          ) : data ? (
            <>
              <div className="ctx-breakdown-summary">
                <div className="ctx-breakdown-stat">
                  <span>UPTIME</span>
                  <strong>{formatUptime(sessionStart ? now - sessionStart : 0)}</strong>
                  <em>session age</em>
                </div>
                <div className="ctx-breakdown-stat">
                  <span>WINDOW</span>
                  <strong>
                    {compactTokens(context.tokens)} / {compactTokens(context.maxContext)}
                  </strong>
                  <em>{ctxPct}% used</em>
                </div>
                <div className="ctx-breakdown-stat">
                  <span>MODE</span>
                  <strong>{data.mode ?? '—'}</strong>
                  <em>context mode</em>
                </div>
                <div className="ctx-breakdown-stat">
                  <span>TOOLS</span>
                  <strong>{data.tools.count}</strong>
                  <em>{compactTokens(data.tools.total)} tokens</em>
                </div>
                <div className="ctx-breakdown-stat">
                  <span>MESSAGES</span>
                  <strong>{data.messages.count}</strong>
                  <em>{compactTokens(data.messages.total)} tokens</em>
                </div>
                <div className="ctx-breakdown-stat">
                  <span>CACHE</span>
                  <strong>
                    {context.cache && context.cache.readTokens + context.cache.writeTokens > 0
                      ? `${(context.cache.hitRatio * 100).toFixed(1)}%`
                      : '—'}
                  </strong>
                  <em>
                    {context.cache && context.cache.coverageTokens > 0
                      ? `covers ${compactTokens(context.cache.coverageTokens)} of ${compactTokens(context.maxContext)}`
                      : 'prompt-cache hit'}
                  </em>
                </div>
              </div>

              {context.cache && context.cache.coverageTokens > 0 && context.maxContext > 0 ? (
                <section className="ctx-breakdown-section">
                  <div className="ctx-breakdown-section-head">
                    <span>CACHE COVERAGE</span>
                    <em>
                      {compactTokens(context.cache.coverageTokens)} of{' '}
                      {compactTokens(context.maxContext)} cached (
                      {((context.cache.coverageTokens / context.maxContext) * 100).toFixed(1)}%)
                    </em>
                  </div>
                  <div
                    className="ctx-breakdown-bar ctx-breakdown-bar-cache"
                    role="img"
                    aria-label="Prompt-cache coverage"
                  >
                    <span
                      style={{
                        width: `${(context.cache.coverageTokens / context.maxContext) * 100}%`,
                        background: 'var(--success)',
                      }}
                      title={`Cached prefix: ${compactTokens(context.cache.coverageTokens)}`}
                    />
                  </div>
                  <p className="ctx-breakdown-cache-note">
                    The first {compactTokens(context.cache.coverageTokens)} of this prompt are
                    served from the provider cache; everything past that boundary is fresh and
                    billed at full input rate.
                  </p>
                </section>
              ) : null}

              <section className="ctx-breakdown-section">
                <div className="ctx-breakdown-section-head">
                  <span>
                    <BarChart3 size={12} aria-hidden="true" /> ALLOCATION
                  </span>
                  <em>{compactTokens(data.total)} estimated total</em>
                </div>
                <div
                  className="ctx-breakdown-bar"
                  role="img"
                  aria-label="Token allocation by category"
                >
                  {categories.map((category) => (
                    <span
                      key={category.key}
                      style={{
                        width: `${data.total > 0 ? (category.value / data.total) * 100 : 0}%`,
                        background: category.color,
                      }}
                      title={`${category.label}: ${compactTokens(category.value)}`}
                    />
                  ))}
                </div>
                <div className="ctx-breakdown-legend">
                  {categories.map((category) => (
                    <span key={category.key} className="ctx-breakdown-legend-item">
                      <i style={{ background: category.color }} aria-hidden="true" />
                      <em>{category.label}</em>
                      <b>{sharePct(category.value, data.total)}</b>
                    </span>
                  ))}
                </div>
              </section>

              {data.tools.breakdown.length > 0 && (
                <section className="ctx-breakdown-section">
                  <div className="ctx-breakdown-section-head">
                    <span>
                      <Wrench size={12} aria-hidden="true" /> TOOL BREAKDOWN
                    </span>
                    <em>
                      {data.tools.breakdown.length} tools · {compactTokens(data.tools.total)}
                    </em>
                  </div>
                  <div className="ctx-breakdown-list">
                    {data.tools.breakdown.map((tool) => (
                      <div key={tool.name} className="ctx-breakdown-row">
                        <span className="ctx-breakdown-name" title={tool.name}>
                          {tool.name}
                        </span>
                        <span className="ctx-breakdown-minibar" aria-hidden="true">
                          <i
                            style={{
                              width: `${barWidth(tool.tokens, data.tools.total)}%`,
                              background: 'var(--warning)',
                            }}
                          />
                        </span>
                        <span className={`ctx-token ${tokenClass(tool.tokens, data.tools.total)}`}>
                          {tool.tokens.toLocaleString()}
                        </span>
                        <span className="ctx-breakdown-pct">
                          {sharePct(tool.tokens, data.tools.total)}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="ctx-breakdown-section">
                <div className="ctx-breakdown-section-head">
                  <span>
                    <MessageSquare size={12} aria-hidden="true" /> MESSAGE BREAKDOWN
                  </span>
                  <em>
                    {data.messages.count} messages · {compactTokens(data.messages.total)}
                  </em>
                </div>
                <div className="ctx-breakdown-list">
                  {data.messages.breakdown.map((msg) => (
                    <div key={msg.index} className="ctx-breakdown-row">
                      <span className="ctx-breakdown-index">{msg.index}</span>
                      <span className={`ctx-role-chip ${roleClass(msg.role)}`}>{msg.role}</span>
                      <span className="ctx-breakdown-minibar" aria-hidden="true">
                        <i
                          style={{
                            width: `${barWidth(msg.tokens, data.messages.total)}%`,
                            background: roleColor(msg.role),
                          }}
                        />
                      </span>
                      <span className={`ctx-token ${tokenClass(msg.tokens, data.messages.total)}`}>
                        {msg.tokens.toLocaleString()}
                      </span>
                      <span className="ctx-breakdown-preview" title={msg.preview}>
                        {msg.preview.slice(0, 80)}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </>
          ) : null}
        </div>

        <footer className="ctx-breakdown-foot">
          <em>Server-side estimate · refresh for live numbers</em>
          <button
            type="button"
            className="ctx-breakdown-compact"
            disabled={running || !sessionId}
            title={running ? 'Context is busy — compact after the run finishes' : 'Compact context'}
            onClick={onCompact}
          >
            <Minimize2 size={12} aria-hidden="true" /> COMPACT CONTEXT
          </button>
        </footer>
      </div>
    </>
  );
}
