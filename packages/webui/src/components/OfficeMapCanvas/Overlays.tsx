import { Send } from 'lucide-react';
import { type KeyboardEvent } from 'react';
import { useAppTranslation } from '@/i18n';

export function OfficeMapLegends() {
  const { t } = useAppTranslation();

  return (
    <>
      <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-border/70 bg-card/90 p-3 text-[10px] shadow-xl backdrop-blur">
        <div className="mb-2 font-bold text-foreground">{t('activity:office.legendStatus')}</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-success" />
            <span className="text-muted-foreground">{t('activity:office.legendActive')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-muted-foreground" />
            <span className="text-muted-foreground">{t('activity:office.legendIdle')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-destructive" />
            <span className="text-muted-foreground">{t('activity:office.legendError')}</span>
          </div>
        </div>
      </div>

      <div className="absolute bottom-4 right-4 z-10 rounded-lg border border-border/70 bg-card/90 p-3 text-[10px] shadow-xl backdrop-blur">
        <div className="mb-2 font-bold text-foreground">
          {t('activity:office.legendConnections')}
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-warning">✉</span>
            <span className="text-muted-foreground">{t('activity:office.legendMail')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-primary">→</span>
            <span className="text-muted-foreground">{t('activity:office.legendTask')}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-success">●</span>
            <span className="text-muted-foreground">{t('activity:office.legendStatusConn')}</span>
          </div>
        </div>
      </div>
    </>
  );
}

type BroadcastComposerProps = {
  draft: string;
  isSending: boolean;
  result: string | null;
  onClose: () => void;
  onDraftChange: (draft: string) => void;
  onSend: () => void;
};

export function BroadcastComposer({
  draft,
  isSending,
  result,
  onClose,
  onDraftChange,
  onSend,
}: BroadcastComposerProps) {
  const { t } = useAppTranslation();

  const handleKeyDown = (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      onSend();
    }
  };

  return (
    <div className="absolute right-4 top-16 z-30 w-80 rounded-xl border border-warning/35 bg-card/95 p-3 shadow-2xl backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
          <Send className="h-3.5 w-3.5" /> {t('activity:office.broadcastToAll')}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-base leading-none text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </div>
      <textarea
        value={draft}
        onChange={(ev) => onDraftChange(ev.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        placeholder={t('activity:office.broadcastPlaceholder')}
        className="w-full resize-none rounded-md border border-border/70 bg-background/70 px-2 py-1 text-[11px] text-foreground placeholder:text-muted-foreground focus:border-warning/45 focus:outline-none"
      />
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[9px] text-muted-foreground">
          {t('activity:office.broadcastSendHint')}
        </span>
        <button
          type="button"
          onClick={onSend}
          disabled={isSending || !draft.trim()}
          className="rounded-md border border-warning/35 bg-warning/12 px-2.5 py-1 text-[11px] text-warning transition-colors hover:bg-warning/18 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isSending ? '…' : t('activity:office.broadcast')}
        </button>
      </div>
      {result && <div className="mt-1 text-[10px] text-muted-foreground">{result}</div>}
    </div>
  );
}
