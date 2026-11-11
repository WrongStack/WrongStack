import { useLayoutEffect, useRef } from 'react';
import { appendToDraft } from './composer-resources-model';

interface DesignDraftTarget {
  owner: string;
  draft: string;
  conflict: boolean;
  validate: () => Promise<boolean>;
  save: (text: string) => Promise<boolean>;
  onPrepared: () => void;
}

/** Waits for revision validation without applying an old prompt to a changed or closed draft. */
export function useDesignDraftPreparation(target: DesignDraftTarget) {
  const current = useRef(target);
  current.current = target;
  const revision = useRef(0);
  const preparing = useRef(false);
  useLayoutEffect(() => {
    revision.current++;
    return () => {
      revision.current++;
    };
  }, [target.owner]);
  return async (prompt: string): Promise<boolean> => {
    const before = current.current;
    const epoch = revision.current;
    if (preparing.current || before.conflict) return false;
    preparing.current = true;
    try {
      if (!(await before.validate())) return false;
      const next = current.current;
      if (
        epoch !== revision.current ||
        next.owner !== before.owner ||
        next.conflict ||
        next.draft !== before.draft
      )
        return false;
      const saved = await next.save(appendToDraft(next.draft, prompt));
      if (saved && epoch === revision.current && current.current.owner === before.owner)
        current.current.onPrepared();
      return saved;
    } finally {
      preparing.current = false;
    }
  };
}
