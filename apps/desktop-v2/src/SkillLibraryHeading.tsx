import { useDesktopText } from './desktop-i18n';

export function SkillLibraryHeading({ scope }: { scope: 'project' | 'profile' }) {
  const { t } = useDesktopText();
  return (
    <div>
      <span className="eyebrow">
        {scope === 'project' ? t('skillLib.eyebrowProject') : t('skillLib.eyebrowProfile')}
      </span>
      <h1>{scope === 'profile' ? t('settings.section.skills') : t('skillLib.title')}</h1>
      <p>{t('skillLib.intro')}</p>
    </div>
  );
}
