import {
  type ArtifactPresentation,
  parseArtifactPresentation,
} from '@wrongstack/tools/artifact-presentation';
import { useEffect, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useActiveSessionId } from '@/stores';
import { ToolDiffView } from './DiffView';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog';

export function ArtifactPreview() {
  const sessionId = useActiveSessionId();
  const ws = useWebSocket();
  const [artifact, setArtifact] = useState<ArtifactPresentation | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setArtifact(null);
    const show = (event: Event) => {
      const item = parseArtifactPresentation((event as CustomEvent).detail);
      if (!item || item.sessionId !== sessionId || !['image', 'diff'].includes(item.kind ?? ''))
        return;
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      setArtifact(item);
    };
    window.addEventListener('wrongstack:rich-artifact', show);
    return () => window.removeEventListener('wrongstack:rich-artifact', show);
  }, [sessionId]);
  useEffect(() => {
    setContent(null);
    setError('');
    if (!artifact || artifact.sessionId !== sessionId) return;
    const type = artifact.kind === 'image' ? 'files.image' : 'files.read';
    const requestId = `rich:${artifact.id}`;
    const timeout = setTimeout(() => setError('Artifact preview timed out.'), 15_000);
    const off = ws.client.on(type, (message) => {
      const payload = message.payload as Record<string, unknown>;
      if (
        payload['sessionId'] !== sessionId ||
        payload['filePath'] !== artifact.path ||
        payload['requestId'] !== requestId
      )
        return;
      clearTimeout(timeout);
      const value = payload[artifact.kind === 'image' ? 'dataUrl' : 'content'];
      if (
        payload['error'] ||
        payload['binary'] ||
        payload['tooLarge'] ||
        payload['notImage'] ||
        typeof value !== 'string'
      )
        setError(
          String(payload['error'] ?? 'Artifact is unavailable or exceeds the preview limit.'),
        );
      else setContent(value);
    });
    ws.client.send({
      type,
      payload: { filePath: artifact.path, sessionId: artifact.sessionId, requestId },
    });
    return () => {
      off();
      clearTimeout(timeout);
    };
  }, [artifact, sessionId, ws.client]);
  const current = artifact?.sessionId === sessionId ? artifact : null;
  const loading = current !== null && content === null && error === '';
  return (
    <>
      {/* Mounted before the message changes so assistive tech is watching the
          region when loading starts; a region inserted with its text is not
          reliably announced. */}
      <span role="status" className="sr-only">
        {loading ? 'Loading artifact…' : ''}
      </span>
      <Dialog
        open={current !== null}
        onOpenChange={(open) => {
          if (!open) setArtifact(null);
        }}
      >
        {current && (
          <DialogContent className="max-w-5xl max-h-[85vh] overflow-auto">
            <DialogTitle>{current.title}</DialogTitle>
            <DialogDescription>Read-only preview · {current.path}</DialogDescription>
            {error ? (
              <p role="alert">{error}</p>
            ) : content === null ? (
              <p>Loading artifact…</p>
            ) : current.kind === 'image' ? (
              <img
                src={content}
                alt={current.title}
                className="max-h-[65vh] max-w-full object-contain"
              />
            ) : (
              <ToolDiffView diff={{ mode: 'unified', patchText: content, caption: current.path }} />
            )}
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
