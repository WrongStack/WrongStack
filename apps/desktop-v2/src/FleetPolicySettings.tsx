import type { LucideIcon } from 'lucide-react';
import { BookOpen, Brain, Compass, Layers3, ListChecks, Sparkles } from 'lucide-react';
import { useDesktopText } from './desktop-i18n';
import './fleet-policy.css';

export function FleetPolicySettings({
  draft,
  change,
}: {
  draft: Record<string, unknown>;
  change: (key: string, value: unknown) => void;
}) {
  const { t } = useDesktopText();
  const toggle = (key: string, label: string, description: string, Icon: LucideIcon) => {
    const known = typeof draft[key] === 'boolean';
    return (
      <label className="fleet-policy-switch" key={key}>
        <Icon size={19} />
        <span>
          <strong>{label}</strong>
          <small>{description}</small>
          <em>
            {known
              ? draft[key]
                ? t('fleetPolicy.enabled')
                : t('fleetPolicy.disabled')
              : t('fleetPolicy.unreported')}
          </em>
        </span>
        <input
          type="checkbox"
          aria-label={label}
          disabled={!known}
          checked={draft[key] === true}
          onChange={(event) => change(key, event.target.checked)}
        />
      </label>
    );
  };
  return (
    <div className="fleet-policy-settings">
      <article className="fleet-capacity-card">
        <header>
          <Layers3 size={23} />
          <div>
            <span className="eyebrow">{t('fleetPolicy.eyebrow')}</span>
            <h3>{t('fleetPolicy.title')}</h3>
          </div>
        </header>
        <p>{t('fleetPolicy.intro')}</p>
        <div className="fleet-capacity-fields">
          <label>
            <strong>{t('fleetPolicy.concurrent')}</strong>
            <input
              aria-label={t('fleetPolicy.concurrent')}
              type="number"
              required
              min={1}
              step={1}
              value={typeof draft['maxConcurrent'] === 'number' ? draft['maxConcurrent'] : ''}
              onChange={(event) =>
                change(
                  'maxConcurrent',
                  event.target.value === '' ? undefined : Number(event.target.value),
                )
              }
            />
            <small>{t('fleetPolicy.concurrentHelp')}</small>
          </label>
          <label>
            <strong>{t('fleetPolicy.chatDetail')}</strong>
            <select
              aria-label={t('fleetPolicy.chatDetail')}
              value={String(draft['fleetChatVerbosity'] ?? '')}
              onChange={(event) => change('fleetChatVerbosity', event.target.value)}
            >
              <option value="" disabled>
                {t('fleetPolicy.notReported')}
              </option>
              <option value="off">{t('fleetPolicy.quiet')}</option>
              <option value="full">{t('fleetPolicy.detailed')}</option>
            </select>
            <small>{t('fleetPolicy.chatHelp')}</small>
          </label>
        </div>
      </article>
      <section className="fleet-companions" aria-label={t('fleetPolicy.companionsLabel')}>
        <header>
          <div>
            <span className="eyebrow">{t('fleetPolicy.companionsEyebrow')}</span>
            <h3>{t('fleetPolicy.companionsTitle')}</h3>
          </div>
          <p>{t('fleetPolicy.companionsIntro')}</p>
        </header>
        {toggle(
          'memoryCompanionEnabled',
          t('fleetPolicy.memory'),
          t('fleetPolicy.memoryHelp'),
          Brain,
        )}
        {toggle(
          'exploreCompanionEnabled',
          t('fleetPolicy.explore'),
          t('fleetPolicy.exploreHelp'),
          Compass,
        )}
        {toggle(
          'skillCompanionEnabled',
          t('fleetPolicy.skill'),
          t('fleetPolicy.skillHelp'),
          BookOpen,
        )}
      </section>
      <section className="fleet-next-step-policy" aria-label={t('fleetPolicy.nextLabel')}>
        <header>
          <span className="eyebrow">{t('fleetPolicy.nextEyebrow')}</span>
          <h3>{t('fleetPolicy.nextTitle')}</h3>
          <p>{t('fleetPolicy.nextIntro')}</p>
        </header>
        {toggle(
          'nextPrediction',
          t('fleetPolicy.prediction'),
          t('fleetPolicy.predictionHelp'),
          Sparkles,
        )}
        {toggle('nextStepsTool', t('fleetPolicy.tool'), t('fleetPolicy.toolHelp'), ListChecks)}
      </section>
    </div>
  );
}
