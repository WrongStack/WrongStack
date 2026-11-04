import { Bug, ScanEye } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import { record } from './engine-values';
import {
  ModelCatalog,
  ModelReference,
  type PolicyProps,
  ProfileSelect,
} from './ModelPolicySettings';
import { reviewChainPreview, reviewModelChange, reviewModelReference } from './review-policy-model';

export function ReviewPolicySettings({
  draft,
  saved,
  change,
  command,
}: PolicyProps & { saved: Record<string, unknown> }) {
  const { t } = useDesktopText();
  const preview = reviewChainPreview(saved, draft);
  const model = (prefix: 'chimera' | 'autoReview', value: string) => {
    for (const [key, next] of Object.entries(reviewModelChange(prefix, value))) change(key, next);
  };
  const number = (key: string, label: string, min: number, help: string, max?: number) => (
    <label>
      {label}
      <input
        type="number"
        aria-label={label}
        required
        min={min}
        max={max}
        step={1}
        value={typeof draft[key] === 'number' ? draft[key] : ''}
        onChange={(event) =>
          change(key, event.target.value === '' ? undefined : Number(event.target.value))
        }
      />
      <span>{help}</span>
    </label>
  );
  const select = (key: string, label: string, options: [string, string][]) => (
    <label>
      {label}
      <select
        aria-label={label}
        value={String(draft[key] ?? '')}
        onChange={(event) => change(key, event.target.value)}
      >
        <option value="" disabled>
          {t('reviewPolicy.unreported')}
        </option>
        {options.map(([value, title]) => (
          <option key={value} value={value}>
            {title}
          </option>
        ))}
      </select>
    </label>
  );
  const enabled = (key: string, label: string) => (
    <label className="policy-toggle">
      <input
        type="checkbox"
        checked={draft[key] === true}
        onChange={(event) => change(key, event.target.checked)}
      />
      {label}
    </label>
  );
  return (
    <div className="model-policy-settings review-policy-settings">
      <ModelCatalog command={command} />
      <article className="policy-profile">
        <header>
          <Bug size={19} />
          <div>
            <span className="eyebrow">{t('reviewPolicy.chimeraEyebrow')}</span>
            <h3>{t('reviewPolicy.chimeraTitle')}</h3>
          </div>
        </header>
        <p className="field-help">{t('reviewPolicy.chimeraIntro')}</p>
        {enabled('chimeraEnabled', t('reviewPolicy.chimeraEnable'))}
        <div className="policy-field-grid">
          <ModelReference
            label={t('reviewPolicy.chimeraModel')}
            value={reviewModelReference(draft, 'chimera')}
            onChange={(value) => model('chimera', value)}
          />
          {number(
            'chimeraMaxFiles',
            t('reviewPolicy.chimeraMaxFiles'),
            1,
            t('reviewPolicy.chimeraMaxFilesHelp'),
          )}
          {select('chimeraAutoFix', t('reviewPolicy.chimeraFollowUp'), [
            ['off', t('reviewPolicy.followUp.off')],
            ['ask', t('reviewPolicy.followUp.ask')],
            ['auto', t('reviewPolicy.followUp.auto')],
          ])}
        </div>
        <p className="field-help">{t('reviewPolicy.chimeraNote')}</p>
      </article>
      <article className="policy-profile">
        <header>
          <ScanEye size={19} />
          <div>
            <span className="eyebrow">{t('reviewPolicy.contEyebrow')}</span>
            <h3>{t('reviewPolicy.contTitle')}</h3>
          </div>
        </header>
        <p className="field-help">{t('reviewPolicy.contIntro')}</p>
        {enabled('autoReviewEnabled', t('reviewPolicy.contEnable'))}
        <div className="policy-field-grid">
          <ProfileSelect
            label={t('reviewPolicy.contProfile')}
            profiles={record(draft['fallbackProfiles'])}
            value={draft['autoReviewFallbackProfile']}
            onChange={(value) => {
              change('autoReviewFallbackProfile', value);
              if (value) {
                change('autoReviewProvider', '');
                change('autoReviewModel', '');
              }
            }}
          />
          <ModelReference
            label={t('reviewPolicy.contModel')}
            value={reviewModelReference(draft, 'autoReview')}
            onChange={(value) => model('autoReview', value)}
          />
          {select('autoReviewModelSelection', t('reviewPolicy.rotation'), [
            ['round-robin', t('reviewPolicy.rotationOption.round-robin')],
            ['random', t('reviewPolicy.rotationOption.random')],
          ])}
          {select('autoReviewCascadeOn', t('reviewPolicy.cascade'), [
            ['off', t('reviewPolicy.cascadeOption.off')],
            ['high', t('reviewPolicy.cascadeOption.high')],
            ['critical', t('reviewPolicy.cascadeOption.critical')],
          ])}
          {number(
            'autoReviewDebounceMs',
            t('reviewPolicy.delay'),
            0,
            t('reviewPolicy.delayHelp'),
            2_147_483_647,
          )}
          {number(
            'autoReviewMaxFilesPerBatch',
            t('reviewPolicy.batchFiles'),
            1,
            t('reviewPolicy.batchFilesHelp'),
          )}
          {number(
            'autoReviewMaxConcurrentReviews',
            t('reviewPolicy.concurrent'),
            1,
            t('reviewPolicy.concurrentHelp'),
          )}
        </div>
        <p className="field-help">{t('reviewPolicy.contNote')}</p>
        {preview.missing && (
          <p className="session-error" role="status">
            {t('reviewPolicy.missing')}
          </p>
        )}
        <div className="review-chain-evidence">
          <h4>{t('reviewPolicy.chainTitle')}</h4>
          {preview.stale && <p role="status">{t('reviewPolicy.stale')}</p>}
          {preview.chain.length ? (
            <ol>
              {preview.chain.map((item, index) => (
                <li key={`${index}-${item}`}>
                  <code>{item}</code>
                </li>
              ))}
            </ol>
          ) : (
            <p>{t('reviewPolicy.noChain')}</p>
          )}
        </div>
      </article>
      <p className="settings-defaults-note">{t('reviewPolicy.savedNote')}</p>
    </div>
  );
}
