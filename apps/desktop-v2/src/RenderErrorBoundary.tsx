import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Component, type ReactNode } from 'react';
import { useDesktopText } from './desktop-i18n';
import './render-error.css';

/** Contains renderer failures without changing the native host or its running sessions. */
export class RenderErrorBoundary extends Component<
  { children: ReactNode; onHome?: (() => void) | undefined },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? <RenderRecovery onHome={this.props.onHome} /> : this.props.children;
  }
}

function RenderRecovery({ onHome }: { onHome?: (() => void) | undefined }) {
  const { t } = useDesktopText();
  return (
    <section className="runtime-state" role="alert">
      <AlertTriangle size={25} aria-hidden="true" />
      <h2>{t('renderError.title')}</h2>
      <p>{t('renderError.body')}</p>
      <div className="render-recovery-actions">
        {onHome && (
          <button type="button" className="button secondary" onClick={onHome}>
            {t('rail.missionControl')}
          </button>
        )}
        <button type="button" className="button secondary" onClick={() => window.location.reload()}>
          <RefreshCw size={15} aria-hidden="true" />
          {t('renderError.reload')}
        </button>
      </div>
    </section>
  );
}
