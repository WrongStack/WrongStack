import { Activity } from 'lucide-react';
import { useState } from 'react';
import { type EngineCommand, EngineReplyError } from './engine-operations';
import { record } from './engine-values';

const STATUS_TEXT: Record<string, string> = {
  ok: 'Reachable',
  unreachable: 'Unreachable',
  timeout: 'Timed out',
  http_error: 'HTTP error',
  invalid_response: 'Unexpected response',
  skipped: 'Not checked',
  no_provider: 'Not a saved connection',
  no_base_url: 'No endpoint URL to check (a built-in provider)',
};

/** One line for a `provider.probe` reply. */
export function probeOutcome(value: unknown): string {
  const result = record(value);
  const status = String(result['status'] ?? '');
  const parts = [STATUS_TEXT[status] ?? status ?? 'Unknown'];
  if (typeof result['httpStatus'] === 'number') parts.push(`HTTP ${result['httpStatus']}`);
  if (typeof result['elapsedMs'] === 'number') parts.push(`${result['elapsedMs']} ms`);
  if (typeof result['modelCount'] === 'number')
    parts.push(`${result['modelCount']} ${result['modelCount'] === 1 ? 'model' : 'models'} listed`);
  if (typeof result['detail'] === 'string' && result['detail']) parts.push(result['detail']);
  return parts.join(' · ');
}

/**
 * Checks a saved connection's OpenAI-compatible `/v1/models` endpoint with its active key
 * (`provider.probe`). Reachability only: it does not send a prompt or prove a model works.
 */
export function ProviderProbe({
  providerId,
  command,
}: {
  providerId: string;
  command: EngineCommand;
}) {
  const [busy, setBusy] = useState(false),
    [outcome, setOutcome] = useState(''),
    [ok, setOk] = useState<boolean | null>(null);
  const probe = async () => {
    setBusy(true);
    setOutcome('');
    try {
      const reply = await command('provider.probe', { providerId, timeoutMs: 8000 }, [
        'provider.probe',
      ]);
      setOk(reply['ok'] === true);
      setOutcome(probeOutcome(reply));
    } catch (failure) {
      // A failed probe is a reply with ok:false, which the transport raises with the reply.
      setOk(false);
      setOutcome(
        failure instanceof EngineReplyError && typeof failure.details['status'] === 'string'
          ? probeOutcome(failure.details)
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="provider-probe">
      <button
        type="button"
        className="button secondary small"
        disabled={busy}
        aria-label={`Check the endpoint of ${providerId}`}
        onClick={() => void probe()}
      >
        <Activity size={12} /> {busy ? 'Checking…' : 'Check endpoint'}
      </button>
      {outcome && (
        <small role="status" className={ok ? '' : 'session-error'}>
          {outcome}
        </small>
      )}
    </div>
  );
}
