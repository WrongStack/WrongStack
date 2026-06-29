import { Bot, CheckCircle2, Code2, ExternalLink, Loader2, Sparkles, XCircle } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toaster';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import type { WSServerMessage } from '@/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

type OAuthKind = 'chatgpt' | 'claude' | 'copilot';

type OAuthPhase =
  | 'idle'
  | 'awaiting_browser'
  | 'awaiting_code'
  | 'exchanging'
  | 'fetching_models'
  | 'success'
  | 'error';

interface OAuthState {
  phase: OAuthPhase;
  providerId?: string | undefined;
  authorizeUrl?: string | undefined;
  verificationUri?: string | undefined;
  userCode?: string | undefined;
  bound?: boolean | undefined;
  message?: string | undefined;
}

interface ProviderMeta {
  kind: OAuthKind;
  label: string;
  subtitle: string;
  icon: ReactNode;
}

const PROVIDERS: ProviderMeta[] = [
  {
    kind: 'chatgpt',
    label: 'ChatGPT',
    subtitle: 'Plus / Pro / Team → openai-codex',
    icon: <Sparkles className="h-5 w-5" />,
  },
  {
    kind: 'claude',
    label: 'Claude',
    subtitle: 'Pro / Max → anthropic-oauth',
    icon: <Bot className="h-5 w-5" />,
  },
  {
    kind: 'copilot',
    label: 'GitHub Copilot',
    subtitle: 'Copilot → github-copilot',
    icon: <Code2 className="h-5 w-5" />,
  },
];

const ACTIVE_PHASES: OAuthPhase[] = [
  'awaiting_browser',
  'awaiting_code',
  'exchanging',
  'fetching_models',
];

export interface OAuthLoginSectionProps {
  ws: WrongStackWebSocketClient;
}

/**
 * Subscription sign-in (ChatGPT / Claude / Copilot). Self-contained: subscribes
 * to `auth.oauth.status` and drives the server-side OAuth engine over the WS
 * client. Loopback flows (ChatGPT/Claude) open the authorize URL in a new tab
 * and capture the redirect on the server's loopback; the Copilot device flow
 * shows a user code. A manual-paste fallback covers a busy loopback port or a
 * remotely-accessed WebUI.
 */
export function OAuthLoginSection({ ws }: OAuthLoginSectionProps) {
  const [states, setStates] = useState<Record<OAuthKind, OAuthState>>({
    chatgpt: { phase: 'idle' },
    claude: { phase: 'idle' },
    copilot: { phase: 'idle' },
  });
  const [pasteValue, setPasteValue] = useState('');
  const [showPaste, setShowPaste] = useState<OAuthKind | null>(null);

  useEffect(() => {
    const off = ws.on('auth.oauth.status', (msg: WSServerMessage) => {
      if (msg.type !== 'auth.oauth.status') return;
      const p = msg.payload as { kind: OAuthKind; phase: OAuthPhase } & OAuthState;
      setStates((prev) => ({ ...prev, [p.kind]: { ...p } }));
      if (p.phase === 'success') {
        toast.success(p.message ?? `Signed in — ${p.providerId ?? p.kind}`);
        setShowPaste(null);
        setPasteValue('');
      } else if (p.phase === 'error') {
        toast.error(p.message ?? 'Sign-in failed');
      }
    });
    return () => off?.();
  }, [ws]);

  const start = useCallback(
    (kind: OAuthKind) => {
      setStates((prev) => ({
        ...prev,
        [kind]: { phase: kind === 'copilot' ? 'awaiting_code' : 'awaiting_browser' },
      }));
      ws.startOAuth(kind);
    },
    [ws],
  );

  const cancel = useCallback(
    (kind: OAuthKind) => {
      ws.cancelOAuth(kind);
      setStates((prev) => ({ ...prev, [kind]: { phase: 'idle' } }));
      setShowPaste(null);
    },
    [ws],
  );

  const submitPaste = useCallback(
    (kind: OAuthKind) => {
      const input = pasteValue.trim();
      if (!input) return;
      ws.submitOAuthCode(kind, input);
      setStates((prev) => ({ ...prev, [kind]: { ...prev[kind], phase: 'exchanging' } }));
    },
    [pasteValue, ws],
  );

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Sign in with a subscription instead of an API key. Using a subscription outside its
          official client may violate the provider's Terms — your account could be rate-limited or
          banned. An API key is the sanctioned path for programmatic use.
        </p>
      </div>

      {PROVIDERS.map((meta) => {
        const st = states[meta.kind];
        const busy = ACTIVE_PHASES.includes(st.phase);
        return (
          <div key={meta.kind} className="rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-muted-foreground">{meta.icon}</span>
                <div className="min-w-0">
                  <div className="font-medium">{meta.label}</div>
                  <div className="text-xs text-muted-foreground truncate">{meta.subtitle}</div>
                </div>
              </div>
              {!busy ? (
                <Button size="sm" onClick={() => start(meta.kind)}>
                  Sign in
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => cancel(meta.kind)}>
                  Cancel
                </Button>
              )}
            </div>

            {/* Flow detail */}
            {st.phase === 'awaiting_browser' && (
              <div className="mt-3 space-y-2 border-t pt-3">
                <div className="flex items-center gap-2 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span>Waiting for you to sign in…</span>
                </div>
                {st.authorizeUrl && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(st.authorizeUrl, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="h-3.5 w-3.5 mr-1" />
                    Open sign-in page
                  </Button>
                )}
                <div>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline"
                    onClick={() => setShowPaste(showPaste === meta.kind ? null : meta.kind)}
                  >
                    {st.bound === false
                      ? 'Loopback port busy — paste the redirect URL'
                      : 'Browser can’t reach this server? Paste the redirect URL'}
                  </button>
                  {showPaste === meta.kind && (
                    <div className="mt-2 flex gap-2">
                      <Input
                        placeholder="http://localhost:.../callback?code=…"
                        value={pasteValue}
                        onChange={(e) => setPasteValue(e.target.value)}
                        className="font-mono text-xs"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitPaste(meta.kind);
                        }}
                      />
                      <Button
                        size="sm"
                        onClick={() => submitPaste(meta.kind)}
                        disabled={!pasteValue.trim()}
                      >
                        Submit
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {st.phase === 'awaiting_code' && (
              <div className="mt-3 space-y-2 border-t pt-3">
                <p className="text-sm text-muted-foreground">
                  Enter this code at the verification page:
                </p>
                <div className="font-mono text-2xl font-bold tracking-widest">
                  {st.userCode ?? '…'}
                </div>
                {st.verificationUri && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => window.open(st.verificationUri, '_blank', 'noopener,noreferrer')}
                  >
                    <ExternalLink className="h-3.5 w-3.5 mr-1" />
                    Open verification page
                  </Button>
                )}
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>Waiting for authorization…</span>
                </div>
              </div>
            )}

            {(st.phase === 'exchanging' || st.phase === 'fetching_models') && (
              <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span>{st.phase === 'exchanging' ? 'Exchanging tokens…' : 'Fetching models…'}</span>
              </div>
            )}

            {st.phase === 'success' && (
              <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm text-green-600">
                <CheckCircle2 className="h-4 w-4" />
                <span>{st.message ?? 'Signed in.'}</span>
              </div>
            )}

            {st.phase === 'error' && st.message && (
              <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm text-destructive">
                <XCircle className="h-4 w-4" />
                <span>{st.message}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
