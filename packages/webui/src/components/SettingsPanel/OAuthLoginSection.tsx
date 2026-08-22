import {
  Bot,
  CheckCircle2,
  Code2,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  User,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { toast } from '@/components/Toaster';
import { i18n, useAppTranslation } from '@/i18n';
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

/** A saved subscription provider profile as seen by the OAuth section. */
export interface SavedProfileInfo {
  id: string;
  hasActiveKey: boolean;
}

export interface OAuthLoginSectionProps {
  ws: WrongStackWebSocketClient;
  /** Existing saved provider profiles grouped by OAuth kind. */
  savedByKind?: Partial<Record<OAuthKind, SavedProfileInfo[]>>;
}

/**
 * Subscription sign-in (ChatGPT / Claude / Copilot) — shows existing accounts
 * and offers "Retry" (re-authenticate an existing profile) and "New account"
 * (log in with a different ChatGPT/Claude/Copilot account) actions per provider.
 */
export function OAuthLoginSection({ ws, savedByKind }: OAuthLoginSectionProps) {
  const { t } = useAppTranslation();
  const [states, setStates] = useState<Record<OAuthKind, OAuthState>>({
    chatgpt: { phase: 'idle' },
    claude: { phase: 'idle' },
    copilot: { phase: 'idle' },
  });
  const [pasteValue, setPasteValue] = useState('');
  const [showPaste, setShowPaste] = useState<OAuthKind | null>(null);
  // "New account" alias input state
  const [newAccountFor, setNewAccountFor] = useState<OAuthKind | null>(null);
  const [newAccountAlias, setNewAccountAlias] = useState('');
  // Expanded account list per kind
  const [expandedKind, setExpandedKind] = useState<OAuthKind | null>(null);

  useEffect(() => {
    const off = ws.on('auth.oauth.status', (msg: WSServerMessage) => {
      if (msg.type !== 'auth.oauth.status') return;
      const p = msg.payload as { kind: OAuthKind; phase: OAuthPhase } & OAuthState;
      setStates((prev) => ({ ...prev, [p.kind]: { ...p } }));
      if (p.phase === 'success') {
        toast.success(
          p.message ?? i18n.t('settings:oauth.signedInToast', { provider: p.providerId ?? p.kind }),
        );
        setShowPaste(null);
        setPasteValue('');
        setNewAccountFor(null);
        setNewAccountAlias('');
      } else if (p.phase === 'error') {
        toast.error(p.message ?? i18n.t('settings:oauth.signInFailed'));
      }
    });
    return () => off?.();
  }, [ws]);

  /** Start a standard sign-in (creates/overwrites the default profile). */
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

  /** Retry login for a specific existing profile alias. */
  const retryLogin = useCallback(
    (kind: OAuthKind, providerId: string) => {
      setStates((prev) => ({
        ...prev,
        [kind]: { phase: kind === 'copilot' ? 'awaiting_code' : 'awaiting_browser' },
      }));
      ws.startOAuth(kind, providerId);
    },
    [ws],
  );

  /** Start a new-account sign-in with a custom alias. */
  const startNewAccount = useCallback(
    (kind: OAuthKind) => {
      const alias = newAccountAlias.trim();
      if (!alias) return;
      setStates((prev) => ({
        ...prev,
        [kind]: { phase: kind === 'copilot' ? 'awaiting_code' : 'awaiting_browser' },
      }));
      ws.startOAuth(kind, alias);
      setNewAccountFor(null);
      setNewAccountAlias('');
    },
    [ws, newAccountAlias],
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

  const profiles = savedByKind ?? {};

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-warning/30 bg-warning/5 p-3">
        <p className="text-xs leading-5 text-warning">{t('settings:oauth.termsWarning')}</p>
      </div>

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
        {PROVIDERS.map((meta) => {
          const st = states[meta.kind];
          const busy = ACTIVE_PHASES.includes(st.phase);
          const kindProfiles = profiles[meta.kind];
          const accountCount = kindProfiles?.length ?? 0;
          const expanded = expandedKind === meta.kind;

          return (
            <div key={meta.kind} className="rounded-lg border border-border bg-background/70 p-3">
              <div className="flex items-center justify-between gap-3 lg:flex-col lg:items-stretch">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="text-muted-foreground">{meta.icon}</span>
                  <div className="min-w-0">
                    <div className="font-medium">{meta.label}</div>
                    <div className="truncate text-xs text-muted-foreground">{meta.subtitle}</div>
                  </div>
                </div>
                {!busy ? (
                  <Button size="sm" onClick={() => start(meta.kind)} className="shrink-0 lg:w-full">
                    {t('settings:oauth.signIn')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => cancel(meta.kind)}
                    className="shrink-0 lg:w-full"
                  >
                    {t('common:action.cancel')}
                  </Button>
                )}
              </div>

              {/* Flow detail — same as before */}
              {st.phase === 'awaiting_browser' && (
                <div className="mt-3 space-y-2 border-t pt-3">
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span>{t('settings:oauth.waitingBrowser')}</span>
                  </div>
                  {st.authorizeUrl && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => window.open(st.authorizeUrl, '_blank', 'noopener,noreferrer')}
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />
                      {t('settings:oauth.openSignIn')}
                    </Button>
                  )}
                  <div>
                    <button
                      type="button"
                      className="text-xs text-muted-foreground underline"
                      onClick={() => setShowPaste(showPaste === meta.kind ? null : meta.kind)}
                    >
                      {st.bound === false
                        ? t('settings:oauth.pasteLoopbackBusy')
                        : t('settings:oauth.pasteCantReach')}
                    </button>
                    {showPaste === meta.kind && (
                      <div className="mt-2 flex gap-2">
                        <Input
                          placeholder={t('activity:oauth.httpLocalhostCallbackCode')}
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
                          {t('settings:oauth.submit')}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {st.phase === 'awaiting_code' && (
                <div className="mt-3 space-y-2 border-t pt-3">
                  <p className="text-sm text-muted-foreground">{t('settings:oauth.enterCode')}</p>
                  <div className="font-mono text-2xl font-bold tracking-widest">
                    {st.userCode ?? '…'}
                  </div>
                  {st.verificationUri && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        window.open(st.verificationUri, '_blank', 'noopener,noreferrer')
                      }
                    >
                      <ExternalLink className="h-3.5 w-3.5 mr-1" />
                      {t('settings:oauth.openVerification')}
                    </Button>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t('settings:oauth.waitingCode')}</span>
                  </div>
                </div>
              )}

              {(st.phase === 'exchanging' || st.phase === 'fetching_models') && (
                <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span>
                    {st.phase === 'exchanging'
                      ? t('settings:oauth.exchanging')
                      : t('settings:oauth.fetchingModels')}
                  </span>
                </div>
              )}

              {st.phase === 'success' && (
                <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm text-success">
                  <CheckCircle2 className="h-4 w-4" />
                  <span>{st.message ?? t('settings:oauth.signedIn')}</span>
                </div>
              )}

              {st.phase === 'error' && st.message && (
                <div className="mt-3 flex items-center gap-2 border-t pt-3 text-sm text-destructive">
                  <XCircle className="h-4 w-4" />
                  <span>{st.message}</span>
                </div>
              )}

              {/* Existing accounts — shown below the card when not busy */}
              {accountCount > 0 && !busy && (
                <div className="mt-3 border-t pt-3">
                  <button
                    type="button"
                    onClick={() => setExpandedKind(expanded ? null : meta.kind)}
                    className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <User className="h-3.5 w-3.5" />
                      <span>{t('settings:oauth.accountCount', { count: accountCount })}</span>
                    </span>
                    <span className="text-[10px]">{expanded ? '▲' : '▼'}</span>
                  </button>

                  {expanded && kindProfiles && (
                    <div className="mt-2 space-y-1.5">
                      {kindProfiles.map((profile) => (
                        <div
                          key={profile.id}
                          className="flex items-center justify-between rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5"
                        >
                          <span className="min-w-0 truncate font-mono text-xs">{profile.id}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {profile.hasActiveKey ? (
                              <span className="inline-flex items-center gap-1 text-[11px] text-success">
                                <CheckCircle2 className="h-3 w-3" />
                                {t('settings:oauth.active')}
                              </span>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {t('settings:oauth.inactive')}
                              </span>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => retryLogin(meta.kind, profile.id)}
                              className="h-6 px-1.5 text-[11px]"
                              title={t('settings:oauth.retryLogin')}
                            >
                              <RefreshCw className="h-3 w-3 mr-0.5" />
                              {t('settings:oauth.retry')}
                            </Button>
                          </div>
                        </div>
                      ))}

                      {/* New account button */}
                      <div className="pt-1">
                        {newAccountFor === meta.kind ? (
                          <div className="flex gap-2">
                            <Input
                              autoFocus
                              placeholder={t('settings:oauth.aliasPlaceholder', {
                                default:
                                  meta.kind === 'chatgpt' ? 'openai-codex-1' : `${meta.kind}-2`,
                              })}
                              value={newAccountAlias}
                              onChange={(e) => setNewAccountAlias(e.target.value)}
                              className="text-xs font-mono"
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') startNewAccount(meta.kind);
                              }}
                            />
                            <Button
                              size="sm"
                              onClick={() => startNewAccount(meta.kind)}
                              disabled={!newAccountAlias.trim()}
                            >
                              {t('settings:oauth.signIn')}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setNewAccountFor(null);
                                setNewAccountAlias('');
                              }}
                            >
                              {t('common:action.cancel')}
                            </Button>
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setNewAccountFor(meta.kind)}
                            className="w-full text-xs"
                          >
                            <Plus className="h-3.5 w-3.5 mr-1" />
                            {t('settings:oauth.newAccount')}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* When no accounts yet, show a single "New account" button */}
              {accountCount === 0 && !busy && (
                <div className="mt-3 border-t pt-3">
                  {newAccountFor === meta.kind ? (
                    <div className="flex gap-2">
                      <Input
                        autoFocus
                        placeholder={t('settings:oauth.aliasPlaceholder', {
                          default: meta.kind === 'chatgpt' ? 'openai-codex-1' : `${meta.kind}-2`,
                        })}
                        value={newAccountAlias}
                        onChange={(e) => setNewAccountAlias(e.target.value)}
                        className="text-xs font-mono"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') startNewAccount(meta.kind);
                        }}
                      />
                      <Button
                        size="sm"
                        onClick={() => startNewAccount(meta.kind)}
                        disabled={!newAccountAlias.trim()}
                      >
                        {t('settings:oauth.signIn')}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setNewAccountFor(null);
                          setNewAccountAlias('');
                        }}
                      >
                        {t('common:action.cancel')}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setNewAccountFor(meta.kind)}
                      className="w-full text-xs"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      {t('settings:oauth.newAccount')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
