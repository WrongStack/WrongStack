import { Building2, Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from '@/components/Toaster';
import { useAppTranslation } from '@/i18n';
import type { WrongStackWebSocketClient } from '@/lib/ws-client';
import type { WSHqState, WSServerMessage } from '@/types';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

type HqState = WSHqState['payload'];

/**
 * "Import from HQ": connect this machine to a WrongStack HQ key vault and
 * take the providers it grants. The server does the work (`hq.*` messages);
 * every answer is a full `hq.state`, and imports also refresh the saved list.
 */
export function ProviderHqImport({ ws }: { ws: WrongStackWebSocketClient }) {
  const { t } = useAppTranslation();
  const [state, setState] = useState<HqState | null>(null);
  const [busy, setBusy] = useState(false);
  const [hqUrl, setHqUrl] = useState('');
  const [token, setToken] = useState('');

  useEffect(() => {
    const off = ws.on('hq.state', (msg: WSServerMessage) => {
      if (msg.type !== 'hq.state') return;
      setBusy(false);
      setState(msg.payload);
      if (msg.payload.error) toast.error(msg.payload.error);
      else if (msg.payload.report?.length) toast.success(msg.payload.report.join('\n'));
      if (msg.payload.enrolled) setToken('');
    });
    ws.hqStatus();
    return () => off?.();
  }, [ws]);

  // A host without an HQ client (or before the first answer) shows nothing.
  if (!state?.available) return null;

  const act = (send: () => void) => {
    setBusy(true);
    send();
  };

  return (
    <div className="space-y-2 border-t pt-2" data-testid="provider-hq-import">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        {t('settings:hq.heading')}
      </h3>
      <p className="text-xs text-muted-foreground">{t('settings:hq.body')}</p>

      {!state.enrolled ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!hqUrl.trim() || !token.trim() || busy) return;
            act(() => ws.hqEnroll(hqUrl.trim(), token.trim()));
          }}
        >
          <p className="text-xs text-muted-foreground">{t('settings:hq.notEnrolled')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              aria-label={t('settings:hq.hqUrl')}
              placeholder={t('settings:hq.hqUrl')}
              value={hqUrl}
              onChange={(event) => setHqUrl(event.target.value)}
            />
            <Input
              aria-label={t('settings:hq.token')}
              placeholder={t('settings:hq.token')}
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !hqUrl.trim() || !token.trim()}>
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t('settings:hq.enroll')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="space-y-2 rounded-lg border border-border/80 bg-card/70 p-3">
          <p className="text-sm">{t('settings:hq.connected', { url: state.hqUrl ?? '' })}</p>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {t('settings:hq.fingerprints', {
              hq: state.hqFingerprint ?? '',
              device: state.deviceFingerprint ?? '',
            })}
          </p>
          {state.grantedError ? (
            <p className="text-xs text-warning">{state.grantedError}</p>
          ) : state.granted && state.granted.length > 0 ? (
            <ul className="space-y-1 text-xs">
              <li className="text-muted-foreground">
                {t('settings:hq.granted', { count: state.granted.length })}
              </li>
              {state.granted.map((p) => (
                <li key={p.id} className="font-mono">
                  {p.id}
                  <span className="text-muted-foreground">
                    {' '}
                    · {p.family ?? p.type}
                    {p.baseUrl ? ` · ${p.baseUrl}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('settings:hq.noneGranted')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || !state.granted?.length}
              onClick={() => act(() => ws.hqImport())}
            >
              {busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              {t('settings:hq.importAll')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => act(() => ws.hqSync())}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              {t('settings:hq.sync')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => act(() => ws.hqUnenroll(false))}
            >
              {t('settings:hq.disconnect')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={busy}
              onClick={() => act(() => ws.hqUnenroll(true))}
            >
              {t('settings:hq.disconnectRemove')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
