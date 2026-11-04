import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useDesktopText } from './desktop-i18n';
import { DurableFormDraft, type FormDraftCodec, type FormDraftStorage } from './durable-form-draft';

type Fields = Record<string, string>;
const MAX_VALUE = 2000;

/** Accepts only the listed fields, as bounded strings, for one owner. */
export function fieldsCodec(owner: string, names: readonly string[]): FormDraftCodec<Fields> {
  return {
    serialize: (fields) => ({ version: 1, owner, fields }),
    parse: (value) => {
      if (value === null) return null;
      const saved = (value ?? {}) as Record<string, unknown>;
      const fields = saved['fields'] as Record<string, unknown> | undefined;
      if (
        saved['version'] !== 1 ||
        saved['owner'] !== owner ||
        !fields ||
        typeof fields !== 'object' ||
        Array.isArray(fields) ||
        !Object.entries(fields).every(
          ([name, item]) =>
            names.includes(name) && typeof item === 'string' && item.length <= MAX_VALUE,
        )
      )
        throw Error('Saved form input has an unsupported format or belongs to another form.');
      return { ...(fields as Fields) };
    },
  };
}

// Controllers belong to their storage (one per project), then to the form key inside it.
const drafts = new WeakMap<FormDraftStorage, Map<string, DurableFormDraft<Fields>>>();
/**
 * Small form inputs that should survive a reload before they are submitted. A
 * value equal to the defaults stores nothing, so a successful submit that resets
 * the inputs also removes the saved copy.
 */
export function usePersistedFields<T extends Fields>(
  storage: FormDraftStorage | undefined,
  key: string,
  defaults: T,
): {
  fields: T;
  set: (patch: Partial<T>) => void;
  restored: boolean;
  notice: React.ReactNode;
} {
  const { t } = useDesktopText();
  const names = useMemo(() => Object.keys(defaults), [defaults]);
  const controller = useMemo(() => {
    if (!storage) return null;
    let owned = drafts.get(storage);
    if (!owned) {
      owned = new Map();
      drafts.set(storage, owned);
    }
    let draft = owned.get(key);
    if (!draft) {
      draft = new DurableFormDraft(storage, fieldsCodec(key, names));
      owned.set(key, draft);
    }
    return draft;
  }, [storage, key, names]);
  const state = useSyncExternalStore(controller?.subscribe ?? noop, controller?.snapshot ?? empty);
  const [fields, setFields] = useState<T>(defaults);
  const [hydrated, setHydrated] = useState(!controller);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    if (!controller) return;
    let active = true;
    void controller.load().then(() => {
      if (!active || !controller.snapshot().ready) return;
      const saved = controller.snapshot().value;
      if (saved) {
        setFields({ ...defaults, ...saved });
        setRestored(true);
      }
      setHydrated(true);
    });
    return () => {
      active = false;
    };
  }, [controller, defaults]);
  useEffect(() => {
    if (!controller || !hydrated || state?.review) return;
    const changed = Object.fromEntries(
      Object.entries(fields).filter(([name, value]) => value !== defaults[name]),
    );
    const next = Object.keys(changed).length ? fields : null;
    if (JSON.stringify(next) === JSON.stringify(controller.snapshot().value)) return;
    controller.edit(next);
  }, [controller, hydrated, fields, defaults, state?.review]);
  const set = useCallback((patch: Partial<T>) => setFields((old) => ({ ...old, ...patch })), []);
  const notice =
    controller && state ? (
      <>
        {state.error && (
          <p className="session-error" role="alert">
            {state.error}
          </p>
        )}
        {state.review && (
          <fieldset className="pending-input-review" aria-label={t('persistedFields.label')}>
            <span>{t('persistedFields.conflict')}</span>
            <button
              type="button"
              className="button secondary small"
              onClick={() => void controller.resolve('local')}
            >
              {t('persistedFields.keepLocal')}
            </button>
            <button
              type="button"
              className="button secondary small"
              onClick={() => {
                const saved = state.review?.value;
                void controller.resolve('saved').then((ok) => {
                  if (ok) setFields({ ...defaults, ...(saved ?? {}) });
                });
              }}
            >
              {t('persistedFields.useSaved')}
            </button>
          </fieldset>
        )}
      </>
    ) : null;
  return { fields, set, restored, notice };
}
const noop = () => () => {};
const empty = () => null;
