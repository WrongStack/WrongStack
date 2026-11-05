import { Trans } from 'react-i18next';
import type { ManifestView } from './chronicle-manifest';
import { useDesktopText } from './desktop-i18n';
import { surfaceI18n } from './surface-i18n';

const short = (hash: string) => (hash ? hash.slice(0, 12) : '—');

/** What a provider request sent, from the manifest Chronicle recorded for it. */
export function ChronicleManifest({ manifest }: { manifest: ManifestView }) {
  const { system, tools } = manifest;
  const { t } = useDesktopText();
  const missing = t('chronicleView.manifest.notRecorded');
  const shown = (value: number | null) => (value === null ? missing : value.toLocaleString());
  return (
    <section className="chronicle-manifest" aria-label={t('chronicleView.manifest.title')}>
      <h3>{t('chronicleView.manifest.title')}</h3>
      <dl>
        <div>
          <dt>{t('chronicleView.manifest.messages')}</dt>
          <dd>{shown(manifest.messageCount)}</dd>
        </div>
        <div>
          <dt>{t('chronicleView.manifest.messageTokens')}</dt>
          <dd>{shown(manifest.estimatedMessageTokens)}</dd>
        </div>
        <div>
          <dt>{t('chronicleView.manifest.contentBytes')}</dt>
          <dd>{shown(manifest.contentBytes)}</dd>
        </div>
        <div>
          <dt>{t('chronicleView.manifest.roles')}</dt>
          <dd>
            {manifest.roles.map(([role, value]) => `${role} ${value}`).join(' · ') || missing}
          </dd>
        </div>
        <div>
          <dt>{t('chronicleView.manifest.blocks')}</dt>
          <dd>
            {manifest.blockKinds.map(([kind, value]) => `${kind} ${value}`).join(' · ') || missing}
          </dd>
        </div>
      </dl>
      <h4>
        {t('chronicleView.manifest.system', {
          blocks: shown(system.blockCount),
          bytes: shown(system.bytes),
        })}{' '}
        <code title={system.hash}>{short(system.hash)}</code>
      </h4>
      {system.blocks ? (
        <table aria-label={t('chronicleView.manifest.composition')}>
          <thead>
            <tr>
              <th scope="col">{t('chronicleView.manifest.layer')}</th>
              <th scope="col">{t('chronicleView.manifest.bytes')}</th>
              <th scope="col">{t('chronicleView.manifest.hash')}</th>
            </tr>
          </thead>
          <tbody>
            {system.blocks.map((block, index) => (
              <tr key={`${index}-${block.hash}`}>
                <td>{block.source}</td>
                <td>{shown(block.bytes)}</td>
                <td>
                  <code title={block.hash}>{short(block.hash)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="field-help">{t('chronicleView.manifest.noBlocks')}</p>
      )}
      <h4>
        {t('chronicleView.manifest.tools', {
          count: shown(tools.count),
          tokens: shown(tools.estimatedDefinitionTokens),
          mutating: shown(tools.mutating),
          destructive: shown(tools.destructive),
        })}
      </h4>
      {tools.names ? (
        <p className="chronicle-manifest-tools">
          {tools.names.join(', ') || t('chronicleView.manifest.noTools')}
        </p>
      ) : (
        <p className="field-help">
          <Trans
            i18n={surfaceI18n}
            ns="desktop"
            i18nKey="chronicleView.manifest.toolsRef"
            values={{ hash: short(tools.namesRef || tools.manifestHash) }}
            components={{ code: <code title={tools.namesRef || tools.manifestHash} /> }}
          />
        </p>
      )}
      <h4>
        {manifest.messagesOmitted
          ? t('chronicleView.manifest.messagesRecent')
          : t('chronicleView.manifest.messages')}
      </h4>
      {manifest.messagesOmitted > 0 && (
        <p className="field-help">
          {t('chronicleView.manifest.omitted', { count: manifest.messagesOmitted })}
        </p>
      )}
      <table aria-label={t('chronicleView.manifest.messagesTable')}>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">{t('chronicleView.manifest.role')}</th>
            <th scope="col">{t('chronicleView.manifest.bytes')}</th>
            <th scope="col">{t('chronicleView.manifest.tokens')}</th>
            <th scope="col">{t('chronicleView.manifest.hash')}</th>
          </tr>
        </thead>
        <tbody>
          {manifest.messages.map((message, index) => (
            <tr key={`${message.index ?? index}-${message.hash}`}>
              <td>{shown(message.index)}</td>
              <td>{message.role}</td>
              <td>{shown(message.bytes)}</td>
              <td>{shown(message.estimatedTokens)}</td>
              <td>
                <code title={message.hash}>{short(message.hash)}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <small>
        {t('chronicleView.manifest.id')} <code>{manifest.manifestId}</code>
      </small>
    </section>
  );
}
