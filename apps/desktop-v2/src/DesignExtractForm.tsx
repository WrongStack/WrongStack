import { ArrowRight, Palette } from 'lucide-react';
import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import {
  buildDesktopDesignPrompt,
  buildDesktopDesignReviewPrompt,
  type DesktopDesignWorkflow,
} from './design-dna-prompt';
import { useDesktopText } from './desktop-i18n';
import './conversation-welcome.css';
import './design-flow.css';

const PRESETS = ['stripe.com', 'linear.app', 'vercel.com'];
const PAGES = [1, 3, 6, 8];
type Workflow = DesktopDesignWorkflow | 'inspect' | 'compare';

/** The same draft-only launcher in the welcome screen, conversation tools and project studio. */
export function DesignExtractForm({
  onPrepare,
  disabled = false,
  target,
  variant = 'dialog',
}: {
  onPrepare: (prompt: string) => void | Promise<boolean>;
  disabled?: boolean | undefined;
  target?: ReactNode;
  variant?: 'welcome' | 'dialog' | 'studio';
}) {
  const { t } = useDesktopText();
  const [source, setSource] = useState('https://stripe.com');
  const [pages, setPages] = useState(6);
  const [workflow, setWorkflow] = useState<Workflow>('extract');
  const [reviewTarget, setReviewTarget] = useState('');
  const [reference, setReference] = useState('');
  const [surface, setSurface] = useState<'page' | 'app'>('page');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preparing = useRef(false);
  const review = workflow === 'inspect' || workflow === 'compare';
  const title = t(review ? 'designReview.title' : 'chatView.designTitle');
  const ready = review
    ? reviewTarget.trim() && (workflow !== 'compare' || reference.trim())
    : source.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (disabled || preparing.current || !ready) return;
    preparing.current = true;
    setBusy(true);
    setError('');
    try {
      const prompt =
        workflow === 'inspect'
          ? buildDesktopDesignReviewPrompt({ action: workflow, target: reviewTarget, surface })
          : workflow === 'compare'
            ? buildDesktopDesignReviewPrompt({ action: workflow, target: reviewTarget, reference })
            : buildDesktopDesignPrompt({ source, maxPages: pages, workflow });
      const saved = await onPrepare(prompt);
      if (saved === false) setError(t('designFlow.draftRefused'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      preparing.current = false;
      setBusy(false);
    }
  };
  return (
    <form
      className="conversation-welcome-design"
      aria-label={title}
      onSubmit={(event) => void submit(event)}
    >
      {variant !== 'studio' && (
        <div className="conversation-welcome-design-head">
          <Palette size={18} aria-hidden="true" />
          <div>
            <h3>{title}</h3>
            <p>{t(review ? 'designReview.formBody' : 'chatView.designBody')}</p>
          </div>
        </div>
      )}
      {variant === 'welcome' && (
        <ol className="conversation-welcome-design-stages">
          <li>{t('chatView.designStageCrawl')}</li>
          <li>{t('chatView.designStageSubpages')}</li>
          <li>{t('chatView.designStageSynthesis')}</li>
          <li>{t('chatView.designStageSpec')}</li>
        </ol>
      )}
      <fieldset disabled={busy} className="design-flow-fields">
        {target}
        <div
          className={`conversation-welcome-design-controls${review ? ' design-review-controls' : ''}`}
        >
          {review ? (
            <label>
              {t('designReview.targetInput')}
              <input
                type="text"
                value={reviewTarget}
                onChange={(event) => setReviewTarget(event.target.value)}
                placeholder="dist/index.html"
              />
            </label>
          ) : (
            <input
              type="text"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="https://stripe.com"
              aria-label={t('chatView.designSourceLabel')}
            />
          )}
          {workflow === 'inspect' ? (
            <select
              value={surface}
              onChange={(event) => setSurface(event.target.value === 'app' ? 'app' : 'page')}
              aria-label={t('designReview.surface')}
            >
              <option value="page">{t('designReview.page')}</option>
              <option value="app">{t('designReview.app')}</option>
            </select>
          ) : workflow === 'compare' ? (
            <label>
              {t('designReview.referenceInput')}
              <input
                type="text"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder="example-com"
              />
            </label>
          ) : (
            <select
              value={pages}
              onChange={(event) => setPages(Number(event.target.value))}
              aria-label={t('chatView.designPagesLabel')}
            >
              {PAGES.map((n) => (
                <option key={n} value={n}>
                  {t('chatView.designPagesCount', { count: n })}
                </option>
              ))}
            </select>
          )}
          <select
            value={workflow}
            onChange={(event) => setWorkflow(event.target.value as Workflow)}
            aria-label={t('chatView.designWorkflowLabel')}
          >
            <option value="extract">{t('chatView.designWorkflowExtract')}</option>
            <option value="materialize-web">{t('chatView.designWorkflowMaterialize')}</option>
            <option value="materialize-rn">{t('designFlow.materializeNative')}</option>
            {variant !== 'welcome' && (
              <>
                <option value="inspect">{t('designReview.inspect')}</option>
                <option value="compare">{t('designReview.compare')}</option>
              </>
            )}
          </select>
        </div>
        <div className="conversation-welcome-design-footer">
          {!review && (
            <div className="conversation-welcome-design-presets">
              <small>{t('chatView.designPresets')}</small>
              {PRESETS.map((site) => (
                <button type="button" key={site} onClick={() => setSource(`https://${site}`)}>
                  {site}
                </button>
              ))}
            </div>
          )}
          <button type="submit" className="button primary small" disabled={disabled || !ready}>
            {t(review ? 'designReview.prepare' : 'chatView.designStart')}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        </div>
      </fieldset>
      <small>{t('designFlow.draftOnly')}</small>
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
