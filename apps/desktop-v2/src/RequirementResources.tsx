import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { FormDraftStorage } from './durable-form-draft';
import { entries, record } from './engine-state';
import { usePersistedFields } from './usePersistedFields';

const editorDefaults = {
  name: '',
  kind: 'file',
  location: '',
  locationType: 'path',
  resourceTitle: '',
  resourceKind: 'doc',
  reference: '',
};
const appendDefaults = {
  category: 'attachment',
  kind: 'file',
  name: '',
  reference: '',
  isUrl: 'false',
};

export interface RequirementAttachment {
  name: string;
  kind: string;
  path?: string;
  url?: string;
}
export interface RequirementResource {
  kind: string;
  reference: string;
  title?: string;
}
export function isRequirementUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function RequirementResourceEditor({
  attachments,
  resources,
  onAttachments,
  onResources,
  disabled,
  storage,
}: {
  attachments: RequirementAttachment[];
  resources: RequirementResource[];
  onAttachments: (items: RequirementAttachment[]) => void;
  onResources: (items: RequirementResource[]) => void;
  disabled: boolean;
  /** Keeps typed-but-not-added inputs across reloads. */
  storage?: FormDraftStorage;
}) {
  const { t } = useDesktopText();
  const input = usePersistedFields(storage, 'requirement-resource-input:new', editorDefaults);
  const { name, kind, location, resourceTitle, resourceKind, reference } = input.fields;
  const locationType = input.fields.locationType === 'url' ? 'url' : 'path';
  const setName = (value: string) => input.set({ name: value });
  const setKind = (value: string) => input.set({ kind: value });
  const setLocation = (value: string) => input.set({ location: value });
  const setLocationType = (value: 'path' | 'url') => input.set({ locationType: value });
  const setResourceTitle = (value: string) => input.set({ resourceTitle: value });
  const setResourceKind = (value: string) => input.set({ resourceKind: value });
  const setReference = (value: string) => input.set({ reference: value });
  const [error, setError] = useState('');
  return (
    <section className="requirement-resource-editor" aria-label={t('reqRes.label')}>
      <h4>{t('reqRes.heading')}</h4>
      <p>{t('reqRes.intro')}</p>
      {input.notice}
      {input.restored && (name || location || reference || resourceTitle) && (
        <p className="field-help" role="status">
          {t('reqRes.restoredAdd')}
        </p>
      )}
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      <div className="requirement-resource-list">
        {attachments.map((item, index) => (
          <article key={`attachment-${index}`}>
            <div>
              <strong>{item.name}</strong>
              <small>
                {t(`reqRes.kind.${item.kind}`, { defaultValue: item.kind })} ·{' '}
                {item.path ?? item.url}
              </small>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() => onAttachments(attachments.filter((_, i) => i !== index))}
            >
              {t('reqRes.removeReference')}
            </button>
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !name.trim() || !location.trim() || attachments.length >= 20) return;
          if (locationType === 'url' && !isRequirementUrl(location.trim())) {
            setError(t('reqRes.badAttachmentLink'));
            return;
          }
          onAttachments([
            ...attachments,
            {
              name: name.trim(),
              kind,
              ...(locationType === 'path' ? { path: location.trim() } : { url: location.trim() }),
            },
          ]);
          setName('');
          setLocation('');
          setError('');
        }}
      >
        <div className="requirement-pair">
          <label>
            {t('reqRes.attachmentName')}
            <input
              aria-label={t('reqRes.attachmentName')}
              value={name}
              maxLength={200}
              disabled={disabled}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            {t('reqRes.attachmentKind')}
            <select
              aria-label={t('reqRes.attachmentKind')}
              value={kind}
              disabled={disabled}
              onChange={(e) => setKind(e.target.value)}
            >
              {['file', 'image', 'document', 'link', 'other'].map((value) => (
                <option key={value} value={value}>
                  {t(`reqRes.kind.${value}`, { defaultValue: value })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="requirement-pair">
          <label>
            {t('reqRes.referenceType')}
            <select
              aria-label={t('reqRes.referenceTypeLabel')}
              value={locationType}
              disabled={disabled}
              onChange={(e) => setLocationType(e.target.value === 'url' ? 'url' : 'path')}
            >
              <option value="path">{t('reqRes.filePath')}</option>
              <option value="url">{t('reqRes.webLink')}</option>
            </select>
          </label>
          <label>
            {t('reqRes.attachmentReference')}
            <input
              aria-label={t('reqRes.attachmentReference')}
              value={location}
              maxLength={500}
              disabled={disabled}
              onChange={(e) => setLocation(e.target.value)}
              placeholder={
                locationType === 'path' ? 'docs/design.md' : 'https://example.com/evidence'
              }
            />
          </label>
        </div>
        <button
          type="submit"
          className="button secondary"
          disabled={disabled || !name.trim() || !location.trim() || attachments.length >= 20}
        >
          {t('reqRes.addAttachment')}
        </button>
        <small>{t('reqRes.noUpload')}</small>
      </form>
      <div className="requirement-resource-list">
        {resources.map((item, index) => (
          <article key={`resource-${index}`}>
            <div>
              <strong>{item.title || item.reference}</strong>
              <small>
                {t(`reqRes.kind.${item.kind}`, { defaultValue: item.kind })} · {item.reference}
              </small>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={disabled}
              onClick={() => onResources(resources.filter((_, i) => i !== index))}
            >
              {t('reqRes.removeResource')}
            </button>
          </article>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled || !reference.trim() || resources.length >= 50) return;
          if (resourceKind === 'url' && !isRequirementUrl(reference.trim())) {
            setError(t('reqRes.badResourceLink'));
            return;
          }
          onResources([
            ...resources,
            {
              kind: resourceKind,
              reference: reference.trim(),
              ...(resourceTitle.trim() ? { title: resourceTitle.trim() } : {}),
            },
          ]);
          setResourceTitle('');
          setReference('');
          setError('');
        }}
      >
        <div className="requirement-pair">
          <label>
            {t('reqRes.resourceTitle')}
            <input
              aria-label={t('reqRes.resourceTitle')}
              value={resourceTitle}
              maxLength={200}
              disabled={disabled}
              onChange={(e) => setResourceTitle(e.target.value)}
            />
          </label>
          <label>
            {t('reqRes.resourceKind')}
            <select
              aria-label={t('reqRes.resourceKind')}
              value={resourceKind}
              disabled={disabled}
              onChange={(e) => setResourceKind(e.target.value)}
            >
              {['spec', 'issue', 'pr', 'doc', 'url', 'other'].map((value) => (
                <option key={value} value={value}>
                  {t(`reqRes.kind.${value}`, { defaultValue: value })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {t('reqRes.resourceReference')}
          <input
            aria-label={t('reqRes.resourceReference')}
            value={reference}
            maxLength={500}
            disabled={disabled}
            onChange={(e) => setReference(e.target.value)}
            placeholder={t('reqRes.resourcePlaceholder')}
          />
        </label>
        <button
          type="submit"
          className="button secondary"
          disabled={disabled || !reference.trim() || resources.length >= 50}
        >
          {t('reqRes.addResource')}
        </button>
      </form>
    </section>
  );
}

const SOURCES = new Set(['user', 'llm', 'deterministic', 'system']);
const FIELDS = new Set([
  'title',
  'normalized_summary',
  'request_type',
  'priority',
  'business_goal',
  'target_users',
  'expected_outcome',
  'scope_notes',
  'constraints',
  'provided_context',
  'attachments',
  'related_resources',
]);
export function RequirementEvidence({
  detail,
  busy = false,
  onDecision,
}: {
  detail: Record<string, unknown>;
  busy?: boolean;
  onDecision?: (id: string, decision: 'accept' | 'reject') => void;
}) {
  const { t } = useDesktopText();
  const attachments = entries(detail['attachments']);
  const resources = entries(detail['relatedResources']);
  const proposals = entries(detail['llmSuggestions']);
  const sources = Object.entries(record(detail['fieldSources'])).filter(
    ([, value]) => typeof value === 'string',
  );
  return (
    <section className="requirement-evidence" aria-label={t('reqRes.evidenceLabel')}>
      {(attachments.length > 0 || resources.length > 0) && (
        <>
          <h4>{t('reqRes.heading')}</h4>
          <div className="requirement-resource-list">
            {attachments.map((item, i) => (
              <article key={`a-${i}`}>
                <strong>
                  {typeof item['name'] === 'string' ? item['name'] : t('reqRes.attachment')}
                </strong>
                <small>
                  {typeof item['kind'] === 'string'
                    ? t(`reqRes.kind.${item['kind']}`, { defaultValue: item['kind'] })
                    : t('reqRes.fileReference')}
                </small>
                <p>
                  {typeof item['path'] === 'string'
                    ? item['path']
                    : typeof item['url'] === 'string'
                      ? item['url']
                      : t('reqRes.referenceMissing')}
                </p>
              </article>
            ))}
            {resources.map((item, i) => (
              <article key={`r-${i}`}>
                <strong>
                  {typeof item['title'] === 'string' ? item['title'] : t('reqRes.relatedResource')}
                </strong>
                <small>
                  {typeof item['kind'] === 'string'
                    ? t(`reqRes.kind.${item['kind']}`, { defaultValue: item['kind'] })
                    : t('reqRes.resource')}
                </small>
                <p>
                  {typeof item['reference'] === 'string'
                    ? item['reference']
                    : t('reqRes.referenceMissing')}
                </p>
              </article>
            ))}
          </div>
        </>
      )}
      {proposals.length > 0 && (
        <>
          <h4>{t('reqRes.suggestions')}</h4>
          <p>{t('reqRes.suggestionsHelp')}</p>
          <div className="requirement-suggestions">
            {proposals.map((item, i) => {
              const value = item['value'];
              const question = record(value);
              return (
                <article key={typeof item['id'] === 'string' ? item['id'] : i}>
                  <header>
                    <strong>
                      {FIELDS.has(String(item['field']))
                        ? t(`reqRes.field.${String(item['field'])}`)
                        : item['kind'] === undefined || item['kind'] === null
                          ? t('reqRes.suggestion')
                          : t(`reqRes.suggestionKind.${String(item['kind'])}`, {
                              defaultValue: String(item['kind']).replaceAll('_', ' '),
                            })}
                    </strong>
                    <span>
                      {typeof item['status'] === 'string'
                        ? t(`reqRes.status.${item['status']}`, { defaultValue: item['status'] })
                        : t('reqRes.statusMissing')}
                    </span>
                  </header>
                  {typeof value === 'string' ? (
                    <p>{value}</p>
                  ) : typeof question['question'] === 'string' ? (
                    <p>{question['question']}</p>
                  ) : Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? (
                    <ul>
                      {value.map((entry, index) => (
                        <li key={index}>{entry}</li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t('reqRes.noPreview')}</p>
                  )}
                  {typeof item['rationale'] === 'string' && <p>{item['rationale']}</p>}
                  {onDecision && item['status'] === 'pending' && typeof item['id'] === 'string' && (
                    <div className="sdd-actions">
                      <button
                        type="button"
                        className="button primary"
                        disabled={busy}
                        onClick={() => onDecision(item['id'] as string, 'accept')}
                      >
                        {t('reqRes.accept')}
                      </button>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={busy}
                        onClick={() => onDecision(item['id'] as string, 'reject')}
                      >
                        {t('reqRes.reject')}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </>
      )}
      {sources.length > 0 && (
        <details className="requirement-provenance">
          <summary>{t('reqRes.provenance')}</summary>
          <dl>
            {sources.map(([field, value]) => (
              <div key={field}>
                <dt>
                  {FIELDS.has(field) ? t(`reqRes.field.${field}`) : field.replaceAll('_', ' ')}
                </dt>
                <dd>
                  {SOURCES.has(String(value))
                    ? t(`reqRes.source.${String(value)}`)
                    : t('reqRes.sourceMissing')}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  );
}

export function RequirementResourceAppend({
  disabled,
  onSave,
  owner,
  storage,
}: {
  disabled: boolean;
  /** Intake id that owns these typed-but-not-saved inputs. */
  owner: string;
  storage?: FormDraftStorage;
  onSave: (input: {
    attachment?: RequirementAttachment;
    relatedResource?: RequirementResource;
  }) => Promise<boolean>;
}) {
  const { t } = useDesktopText();
  const input = usePersistedFields(storage, `requirement-resource-input:${owner}`, appendDefaults);
  const { kind, name, reference } = input.fields;
  const category = input.fields.category === 'relatedResource' ? 'relatedResource' : 'attachment';
  const isUrl = input.fields.isUrl === 'true';
  const setCategory = (value: 'attachment' | 'relatedResource') => input.set({ category: value });
  const setKind = (value: string) => input.set({ kind: value });
  const setName = (value: string) => input.set({ name: value });
  const setReference = (value: string) => input.set({ reference: value });
  const setIsUrl = (value: boolean) => input.set({ isUrl: String(value) });
  const [error, setError] = useState('');
  return (
    <details className="requirement-append">
      <summary>{t('reqRes.appendTitle')}</summary>
      {input.notice}
      {input.restored && (name || reference) && (
        <p className="field-help" role="status">
          {t('reqRes.restoredSave')}
        </p>
      )}
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || !reference.trim() || (category === 'attachment' && !name.trim())) return;
          if (
            ((category === 'attachment' && isUrl) ||
              (category === 'relatedResource' && kind === 'url')) &&
            !isRequirementUrl(reference.trim())
          ) {
            setError(t('reqRes.badLink'));
            return;
          }
          setError('');
          const input =
            category === 'attachment'
              ? {
                  attachment: {
                    name: name.trim(),
                    kind,
                    ...(isUrl ? { url: reference.trim() } : { path: reference.trim() }),
                  },
                }
              : {
                  relatedResource: {
                    kind,
                    reference: reference.trim(),
                    ...(name.trim() ? { title: name.trim() } : {}),
                  },
                };
          try {
            if (await onSave(input)) {
              setName('');
              setReference('');
            }
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        {error && (
          <p className="session-error" role="alert">
            {error}
          </p>
        )}
        <div className="requirement-pair">
          <label>
            {t('reqRes.category')}
            <select
              aria-label={t('reqRes.category')}
              disabled={disabled}
              value={category}
              onChange={(e) => {
                const value = e.target.value === 'attachment' ? 'attachment' : 'relatedResource';
                setCategory(value);
                setKind(value === 'attachment' ? 'file' : 'doc');
              }}
            >
              <option value="attachment">{t('reqRes.attachmentReference')}</option>
              <option value="relatedResource">{t('reqRes.relatedResource')}</option>
            </select>
          </label>
          <label>
            {t('reqRes.kindLabel')}
            <select
              aria-label={t('reqRes.kindLabel')}
              disabled={disabled}
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              {(category === 'attachment'
                ? ['file', 'image', 'document', 'link', 'other']
                : ['spec', 'issue', 'pr', 'doc', 'url', 'other']
              ).map((value) => (
                <option value={value} key={value}>
                  {t(`reqRes.kind.${value}`, { defaultValue: value })}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          {t('reqRes.name')}
          <input
            aria-label={t('reqRes.name')}
            disabled={disabled}
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {category === 'attachment' && (
          <label>
            <input
              type="checkbox"
              disabled={disabled}
              checked={isUrl}
              onChange={(e) => setIsUrl(e.target.checked)}
            />{' '}
            {t('reqRes.isWebLink')}
          </label>
        )}
        <label>
          {t('reqRes.reference')}
          <input
            aria-label={t('reqRes.reference')}
            disabled={disabled}
            maxLength={500}
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </label>
        <p>{t('reqRes.onlyReference')}</p>
        <button
          type="submit"
          className="button primary"
          disabled={disabled || !reference.trim() || (category === 'attachment' && !name.trim())}
        >
          {t('reqRes.save')}
        </button>
      </form>
    </details>
  );
}
