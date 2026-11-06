import { Archive, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime, displayLocale } from './display-dates';
import { Modal } from './Modal';
import type { ModelProfileIdentity } from './ModelCatalogProfile';
import {
  type ClassifiedModelDraft,
  canDiscardHere,
  canOpenProvider,
  classifyModelDrafts,
  discardListedDraft,
  type ModelDraftAdminStorage,
  readModelDraftListing,
  standingDetail,
  standingLabel,
  standingOrder,
} from './model-draft-admin';
import { request } from './platform';

const nativeStorage: ModelDraftAdminStorage = {
  list: () => request<unknown>('profile-draft.list', {}),
  save: (formKey, value, expectedRevision) =>
    request<{ revision: number }>('profile-draft.save', { formKey, value, expectedRevision }),
};
const kib = (bytes: number) =>
  `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(displayLocale())} KiB`;

/** Review parked model-editor drafts that the provider editor cannot reach on its own. */
export function ModelDraftAdministration({
  profile,
  savedProviders,
  disabled,
  onOpenProvider,
  storage = nativeStorage,
}: {
  profile: ModelProfileIdentity;
  savedProviders: readonly string[];
  disabled: boolean;
  onOpenProvider: (providerId: string) => void;
  storage?: ModelDraftAdminStorage;
}) {
  const { t } = useDesktopText();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="button secondary"
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Archive size={14} />
        {t('draftAdmin.savedDrafts')}
      </button>
      {open && (
        <ModelDraftAdministrationDialog
          profile={profile}
          savedProviders={savedProviders}
          storage={storage}
          onClose={() => setOpen(false)}
          onOpenProvider={(providerId) => {
            setOpen(false);
            onOpenProvider(providerId);
          }}
        />
      )}
    </>
  );
}

function ModelDraftAdministrationDialog({
  profile,
  savedProviders,
  storage,
  onClose,
  onOpenProvider,
}: {
  profile: ModelProfileIdentity;
  savedProviders: readonly string[];
  storage: ModelDraftAdminStorage;
  onClose: () => void;
  onOpenProvider: (providerId: string) => void;
}) {
  const { t } = useDesktopText();
  const [drafts, setDrafts] = useState<ClassifiedModelDraft[] | null>(null);
  const [truncated, setTruncated] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  // Leaves any shown error in place: a refused discard must stay visible after the refresh.
  const load = useCallback(async () => {
    try {
      const listing = readModelDraftListing(await storage.list());
      setDrafts(await classifyModelDrafts(listing.drafts, profile.id, savedProviders));
      setTruncated(listing.truncated ? listing.limit : null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }, [storage, profile.id, savedProviders]);
  useEffect(() => {
    void load();
  }, [load]);
  const discard = async (draft: ClassifiedModelDraft) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await discardListedDraft(storage, draft);
      setNotice(
        t('draftAdmin.discarded', {
          model: draft.modelId || t('draftAdmin.unnamed'),
          provider: draft.providerId ?? t('draftAdmin.unknownConnectionLower'),
        }),
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setConfirm('');
      await load();
      setBusy(false);
    }
  };
  const groups = standingOrder
    .map((standing) => ({
      standing,
      items: (drafts ?? []).filter((draft) => draft.standing === standing),
    }))
    .filter((group) => group.items.length);
  return (
    <Modal onClose={onClose}>
      <header>
        <div>
          <span className="eyebrow">{t('draftAdmin.eyebrow', { profile: profile.name })}</span>
          <h2 id="dialog-title">{t('draftAdmin.title')}</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('draftAdmin.close')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <div className="model-draft-admin">
        <p>{t('draftAdmin.intro')}</p>
        <div className="model-tier-actions">
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => {
              setNotice('');
              setError('');
              void load();
            }}
          >
            <RefreshCw size={14} />
            {t('draftAdmin.refresh')}
          </button>
        </div>
        {error && (
          <p role="alert" className="session-error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {truncated !== null && <p role="status">{t('draftAdmin.truncated', { n: truncated })}</p>}
        {drafts === null && !error && <p role="status">{t('draftAdmin.reading')}</p>}
        {drafts?.length === 0 && <p>{t('draftAdmin.none')}</p>}
        {groups.map(({ standing, items }) => (
          <section
            key={standing}
            aria-label={t(`draftAdmin.standing.${standing}`, {
              defaultValue: standingLabel[standing],
            })}
          >
            <h3>
              {t(`draftAdmin.standing.${standing}`, { defaultValue: standingLabel[standing] })}{' '}
              <span className="model-draft-count">{items.length}</span>
            </h3>
            <ul className="model-draft-admin-list">
              {items.map((draft) => (
                <li key={draft.formKey}>
                  <div className="model-draft-admin-row">
                    <div>
                      <strong>
                        {draft.modelId || draft.originalId || t('draftAdmin.unnamedModel')}
                      </strong>
                      <span>
                        {draft.providerId ?? t('draftAdmin.unknownConnection')} ·{' '}
                        {draft.standing === 'other-profile'
                          ? draft.profileName
                            ? t('draftAdmin.nameWhenSaved', { name: draft.profileName })
                            : t('draftAdmin.unnamedProfile')
                          : draft.standing === 'editable' || draft.standing === 'orphaned'
                            ? profile.name
                            : draft.standing === 'unverified'
                              ? t('draftAdmin.ownerNotVerified')
                              : t('draftAdmin.noOwner')}{' '}
                        ·{' '}
                        {draft.updatedAt
                          ? displayDateTime(draft.updatedAt)
                          : t('draftAdmin.timeUnknown')}{' '}
                        · {kib(draft.bytes)}
                      </span>
                    </div>
                    <div className="model-tier-actions">
                      {canOpenProvider(draft) && (
                        <button
                          type="button"
                          className="button secondary small"
                          disabled={busy}
                          onClick={() => onOpenProvider(draft.providerId!)}
                        >
                          {t('draftAdmin.open', { provider: draft.providerId })}
                        </button>
                      )}
                      {canDiscardHere(draft) &&
                        (confirm === draft.formKey ? (
                          <>
                            <button
                              type="button"
                              className="button danger small"
                              disabled={busy}
                              onClick={() => {
                                void discard(draft);
                              }}
                            >
                              {t('draftAdmin.confirmDiscard')}
                            </button>
                            <button
                              type="button"
                              className="button secondary small"
                              disabled={busy}
                              onClick={() => setConfirm('')}
                            >
                              {t('draftAdmin.keep')}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button secondary small"
                            disabled={busy}
                            onClick={() => setConfirm(draft.formKey)}
                          >
                            {t('draftAdmin.discard')}
                          </button>
                        ))}
                    </div>
                  </div>
                  <p>
                    {t(
                      `draftAdmin.detail.${
                        draft.standing === 'unassigned'
                          ? draft.providerSaved
                            ? 'unassignedSaved'
                            : 'unassignedMissing'
                          : draft.standing
                      }`,
                      { defaultValue: standingDetail(draft) },
                    )}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Modal>
  );
}
