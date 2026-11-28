import { useDesktopText } from './desktop-i18n';
import { displayLocale } from './display-dates';

interface Part {
  key: 'system' | 'tools' | 'messages' | 'other' | 'free';
  label: string;
  tokens: number;
}

/** The share of the window in use where the meter turns amber, then red, as the status bar does. */
const WARN = 75;
const CRITICAL = 90;

/**
 * The context at a glance: how full the model's window is (a ring and the numbers beside it),
 * then what fills it — system instructions, tool definitions, messages and what is left — as
 * one bar with a labelled legend. The parts are estimates; whatever they do not account for
 * shows as "other", and nothing is drawn past the window.
 */
export function ContextComposition({
  total,
  max,
  mode,
  system,
  tools,
  messages,
}: {
  total: number;
  /** The model's window; 0 when the engine does not know it (no percent, no free space). */
  max: number;
  mode: string;
  system: number;
  tools: number;
  messages: number;
}) {
  const { t } = useDesktopText();
  const count = (value: number) => value.toLocaleString(displayLocale());
  const known = system + tools + messages;
  const parts: Part[] = [
    { key: 'system', label: t('contextPanel.section.system'), tokens: system },
    { key: 'tools', label: t('contextPanel.section.tools'), tokens: tools },
    { key: 'messages', label: t('contextPanel.section.messages'), tokens: messages },
    { key: 'other', label: t('contextPanel.section.other'), tokens: Math.max(0, total - known) },
  ];
  if (max > 0)
    parts.push({
      key: 'free',
      label: t('contextPanel.section.free'),
      tokens: Math.max(0, max - total),
    });
  const scale = Math.max(1, max > 0 ? Math.max(max, total) : total);
  const shown = parts.filter((part) => part.tokens > 0);
  const percent = max > 0 ? Math.min(100, Math.round((total / max) * 100)) : null;
  const zone =
    percent === null
      ? 'unknown'
      : percent >= CRITICAL
        ? 'critical'
        : percent >= WARN
          ? 'warn'
          : 'ok';
  // The ring's circumference for r = 26 on a 64 box.
  const ring = 2 * Math.PI * 26;
  return (
    <>
      <div className={`context-summary zone-${zone}`}>
        {percent !== null && (
          <svg
            className="context-ring"
            viewBox="0 0 64 64"
            role="img"
            aria-label={t('contextPanel.used', { percent })}
          >
            <circle className="context-ring-track" cx="32" cy="32" r="26" />
            <circle
              className="context-ring-value"
              cx="32"
              cy="32"
              r="26"
              strokeDasharray={`${(ring * percent) / 100} ${ring}`}
            />
            <text x="32" y="36" textAnchor="middle">
              {percent}%
            </text>
          </svg>
        )}
        <div>
          <strong>{count(total)}</strong>
          <span>{t('contextPanel.currentTokens')}</span>
        </div>
        <div>
          <strong>{max > 0 ? count(max) : t('contextPanel.notReported')}</strong>
          <span>{t('contextPanel.window')}</span>
        </div>
        <div>
          <strong>{mode}</strong>
          <span>{t('contextPanel.mode')}</span>
        </div>
      </div>
      <section className="context-breakdown" aria-label={t('contextPanel.sections')}>
        <div
          className="context-stack"
          role="img"
          aria-label={shown.map((part) => `${part.label} ~${count(part.tokens)}`).join(', ')}
        >
          {shown.map((part) => (
            <span
              key={part.key}
              className={`context-part part-${part.key}`}
              style={{ flexGrow: part.tokens / scale }}
              title={`${part.label} · ~${count(part.tokens)}`}
            />
          ))}
        </div>
        <ul className="context-legend">
          {shown.map((part) => (
            <li key={part.key} className={`part-${part.key}`}>
              <i aria-hidden="true" />
              <span>{part.label}</span>
              <strong>~{count(part.tokens)}</strong>
              <small>{Math.round((part.tokens / scale) * 100)}%</small>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
