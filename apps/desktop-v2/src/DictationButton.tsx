import { Mic, MicOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { speechStatus, startSpeech, stopSpeech } from './platform';

let cachedStatus: ReturnType<typeof speechStatus> | null = null;

/**
 * Dictation into the draft through the platform recognizer. Shown only where the platform can
 * dictate; when Windows has it turned off the button stays disabled and says why. Recognized
 * phrases are added to the draft, never replacing it; the live guess is shown while listening.
 */
export function DictationButton({
  disabled,
  onText,
}: {
  disabled: boolean;
  onText: (text: string) => void;
}) {
  const { t } = useDesktopText();
  const [status, setStatus] = useState<{ available: boolean; reason?: string } | null>(null),
    [listening, setListening] = useState(false),
    [heard, setHeard] = useState(''),
    [problem, setProblem] = useState('');
  const textRef = useRef(onText);
  textRef.current = onText;
  useEffect(() => {
    cachedStatus ??= speechStatus().catch((failure: unknown) => ({
      available: false,
      reason: failure instanceof Error ? failure.message : String(failure),
    }));
    let live = true;
    void cachedStatus.then((next) => live && setStatus(next));
    return () => {
      live = false;
    };
  }, []);
  useEffect(
    () => () => {
      void stopSpeech().catch(() => {});
    },
    [],
  );
  // Nothing at all where the platform has no recognizer: no microphone that cannot work.
  if (!status || (!status.available && /Windows only|desktop app/.test(status.reason ?? '')))
    return null;
  const toggle = async () => {
    setProblem('');
    if (listening) {
      await stopSpeech().catch(() => {});
      setListening(false);
      setHeard('');
      return;
    }
    setListening(true);
    try {
      await startSpeech((event) => {
        if (event['kind'] === 'hypothesis') setHeard(String(event['text'] ?? ''));
        else if (event['kind'] === 'result') {
          setHeard('');
          textRef.current(String(event['text'] ?? ''));
        } else if (event['kind'] === 'error' || event['kind'] === 'ended') {
          setListening(false);
          setHeard('');
          if (event['kind'] === 'error') setProblem(String(event['message'] ?? ''));
          else if (event['reason'] !== 'listening was stopped')
            setProblem(t('dictation.stopped', { reason: String(event['reason'] ?? '') }));
        }
      });
    } catch (failure) {
      setListening(false);
      setProblem(failure instanceof Error ? failure.message : String(failure));
    }
  };
  const reason = status.available ? '' : (status.reason ?? t('dictation.unavailable'));
  return (
    <>
      <button
        type="button"
        className={`composer-chip${listening ? ' dictation-listening' : ''}`}
        aria-label={listening ? t('dictation.stop') : t('dictation.dictate')}
        aria-pressed={listening}
        title={reason || problem || (listening ? t('dictation.stop') : t('dictation.dictateTitle'))}
        disabled={disabled || !status.available}
        onClick={() => void toggle()}
      >
        {status.available ? <Mic size={14} /> : <MicOff size={14} />}
      </button>
      {(heard || problem) && (
        <span className="dictation-status" role={problem ? 'alert' : 'status'}>
          {problem || heard}
        </span>
      )}
    </>
  );
}
