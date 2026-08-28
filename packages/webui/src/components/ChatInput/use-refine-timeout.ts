import { useEffect } from 'react';
import type { WSUserMessageImage } from '@/types';
import { useChatStore, useUIStore } from '@/stores';
import { toast } from '../Toaster.js';

interface UseRefineTimeoutOptions {
  clientConnected?: boolean | undefined;
  t: (key: string) => string;
  sendMessage: (
    content: string,
    images?: WSUserMessageImage[] | undefined,
    freshContext?: boolean,
  ) => string | null;
  setInput: (value: string) => void;
}

export function useRefineTimeout({
  clientConnected,
  t,
  sendMessage,
  setInput,
}: UseRefineTimeoutOptions) {
  const refinePanel = useUIStore((s) => s.refinePanel);
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const enqueue = useChatStore((s) => s.enqueue);
  const addMessage = useChatStore((s) => s.addMessage);
  const setLoading = useChatStore((s) => s.setLoading);

  useEffect(() => {
    if (!refinePanel || (refinePanel.status ?? 'refining') !== 'refining') return;
    const window = refinePanel.retried ? 210_000 : 105_000;
    const timer = setTimeout(() => {
      const current = useUIStore.getState().refinePanel;
      if (!current || (current.status ?? 'refining') !== 'refining') return;
      setRefinePanel(null);
      toast.info(t('chat:input.refineTimeoutFallback'));
      if (current.mode !== undefined && useChatStore.getState().isLoading) {
        const panelImages = current.images;
        const panelMode =
          panelImages && panelImages.length > 0 && current.mode === 'btw' ? 'queue' : current.mode;
        enqueue(current.original, panelMode, panelImages);
        return;
      }
      if (clientConnected) {
        addMessage({ role: 'user', content: current.original });
        setLoading(true);
        if (current.freshContext === true) sendMessage(current.original, undefined, true);
        else sendMessage(current.original);
      } else {
        setInput(current.original);
        toast.error(t('chat:input.notConnectedDraftKept'));
      }
    }, window);
    return () => clearTimeout(timer);
  }, [refinePanel, clientConnected, addMessage, setLoading, sendMessage, setRefinePanel, enqueue, setInput, t]);
}
