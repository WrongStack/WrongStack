import type React from 'react';
import { useAppTranslation } from '@/i18n';
import { useUIStore } from '@/stores';
import type { RefineDecision } from '../RefinePanel.js';
import { RefinePanel } from '../RefinePanel.js';
import { ModelPickDialog } from '../ModelPickDialog.js';

export const REFINE_RETRY_FEEDBACK =
  'Make another pass that is sharper and more self-contained. Use the provided project memory, current session context, and recent conversation only to resolve references and preserve project vocabulary; keep the original scope unchanged.';

export interface ChatInputRefinePanelHostProps {
  enhanceEnabled: boolean;
  refinePickOpen: boolean;
  setRefinePickOpen: (open: boolean) => void;
  refineModel:
    | ((
        text: string,
        opts?: {
          timeoutMs?: number;
          provider?: string;
          model?: string;
          previousRefined?: string;
          previousEnglish?: string;
          retryFeedback?: string;
        },
      ) => void)
    | undefined;
  clientConnected: boolean;
  addUserMessage: (content: string) => void;
  setLoading: (loading: boolean) => void;
  sendMessage: (text: string) => void;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  resolveCancelInput: (prev: string, original: string) => string;
  notConnectedDraftKept: () => void;
}

export function ChatInputRefinePanelHost({
  enhanceEnabled,
  refinePickOpen,
  setRefinePickOpen,
  refineModel,
  clientConnected,
  addUserMessage,
  setLoading,
  sendMessage,
  setInput,
  resolveCancelInput,
  notConnectedDraftKept,
}: ChatInputRefinePanelHostProps) {
  const { t } = useAppTranslation();
  const refinePanel = useUIStore((s) => s.refinePanel);
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);

  if (!refinePanel || !enhanceEnabled) {
    return (
      <ModelPickDialog
        open={refinePickOpen}
        title={t('activity:refine.pickModelTitle')}
        hint={t('activity:refine.pickModelHint')}
        onClose={() => setRefinePickOpen(false)}
        onPick={() => undefined}
      />
    );
  }

  const retryContext =
    (refinePanel.status ?? 'ready') === 'ready'
      ? {
          previousRefined: refinePanel.refined,
          previousEnglish: refinePanel.english,
          retryFeedback: REFINE_RETRY_FEEDBACK,
        }
      : {};

  const handleDecision = (decision: RefineDecision): void => {
    const { original, refined, english } = refinePanel;

    if (decision === 'cancel') {
      setRefinePanel(null);
      setInput((prev) => resolveCancelInput(prev, original));
      return;
    }

    let text = original;
    if (decision === 'refined') text = refined;
    else if (decision === 'english') text = english;
    else if (decision === 'edit') text = refined;

    if (decision === 'edit') {
      setInput(refined);
      setRefinePanel(null);
      return;
    }

    setRefinePanel(null);
    if (clientConnected) {
      addUserMessage(text);
      setLoading(true);
      sendMessage(text);
    } else {
      setInput(text);
      notConnectedDraftKept();
    }
  };

  return (
    <>
      <RefinePanel
        original={refinePanel.original}
        refined={refinePanel.refined}
        english={refinePanel.english}
        status={refinePanel.status}
        error={refinePanel.error}
        fallbackRef={refinePanel.fallbackRef}
        provider={refinePanel.provider}
        model={refinePanel.model}
        onStartRefine={() => {
          const current = useUIStore.getState().refinePanel;
          if (!current) return;
          setRefinePanel({ ...current, status: 'refining' });
          refineModel?.(current.original);
        }}
        onRetry={() => {
          setRefinePanel({ ...refinePanel, status: 'refining', retried: true });
          refineModel?.(refinePanel.original, { timeoutMs: 180_000, ...retryContext });
        }}
        onRetryFallback={(ref) => {
          const slash = ref.indexOf('/');
          const provider = slash === -1 ? undefined : ref.slice(0, slash);
          const model = slash === -1 ? ref : ref.slice(slash + 1);
          if (!provider || !model) return;
          setRefinePanel({ ...refinePanel, provider, model, status: 'refining', retried: true });
          refineModel?.(refinePanel.original, { timeoutMs: 180_000, provider, model });
        }}
        onPickModel={() => setRefinePickOpen(true)}
        onCopyToInput={(copied) => {
          setRefinePanel(null);
          setInput(copied);
        }}
        onDecision={handleDecision}
      />

      <ModelPickDialog
        open={refinePickOpen}
        title={t('activity:refine.pickModelTitle')}
        hint={t('activity:refine.pickModelHint')}
        onClose={() => setRefinePickOpen(false)}
        onPick={(candidate) => {
          setRefinePickOpen(false);
          const current = useUIStore.getState().refinePanel;
          if (!current) return;
          const candidateRetryContext =
            (current.status ?? 'ready') === 'ready'
              ? {
                  previousRefined: current.refined,
                  previousEnglish: current.english,
                  retryFeedback: REFINE_RETRY_FEEDBACK,
                }
              : {};
          setRefinePanel({
            ...current,
            provider: candidate.provider,
            model: candidate.model,
            status: 'refining',
            retried: true,
          });
          refineModel?.(current.original, {
            timeoutMs: 180_000,
            provider: candidate.provider,
            model: candidate.model,
            ...candidateRetryContext,
          });
        }}
      />
    </>
  );
}
