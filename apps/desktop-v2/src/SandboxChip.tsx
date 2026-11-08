import { Shield, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { type EngineHttp, engineHttp } from './engine-http';
import { readSandboxStatus, type SandboxStatus, sandboxChipKey } from './sandbox-status';

/** How often the posture is read again, as the WebUI's chip polls it. */
export const SANDBOX_POLL_MS = 5000;

/**
 * The conversation engine's sandbox posture (off, or enforced with its tier), read from the
 * engine's read-only status route and refreshed while shown. Hidden until the engine first
 * answers; a failed read keeps the last known posture.
 */
export function SandboxChip({
  sessionId,
  http,
  pollMs = SANDBOX_POLL_MS,
}: {
  /** The desktop session whose engine is asked. */
  sessionId: string;
  /** Overrides the engine route (tests). */
  http?: EngineHttp | undefined;
  pollMs?: number;
}) {
  const { t } = useDesktopText();
  const [status, setStatus] = useState<SandboxStatus | null>(null);
  const reader = useMemo(() => http ?? engineHttp(sessionId), [http, sessionId]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const next = readSandboxStatus(await reader('/api/sandbox/status'));
        if (alive && next) setStatus(next);
      } catch {
        // The engine may still be starting; the last known posture stays.
      }
    };
    void load();
    const timer = setInterval(() => void load(), pollMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [reader, pollMs]);
  if (!status) return null;
  const key = sandboxChipKey(status);
  return (
    <span
      className={`sandbox-chip sandbox-${key === 'off' ? 'off' : 'enforced'}`}
      data-testid="sandbox-status"
      role="status"
      title={t('sandbox.title', {
        mode: status.mode,
        tier: status.tier || '—',
        backend: status.backend || '—',
      })}
    >
      {key === 'off' ? <Shield size={11} /> : <ShieldCheck size={11} />}
      {t(`sandbox.chip.${key}`)}
    </span>
  );
}
