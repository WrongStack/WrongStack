import { Pencil, Square } from 'lucide-react';
import { Button } from '../ui/button';

export function StopControls({
  stopEditTitle,
  abortTitle,
  onStopAndEdit,
  onAbort,
}: {
  stopEditTitle: string;
  abortTitle: string;
  onStopAndEdit: () => void;
  onAbort: () => void;
}) {
  return (
    <>
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={onStopAndEdit}
        className="h-[44px] w-[44px] shrink-0 rounded-md"
        title={stopEditTitle}
        data-testid="stop-and-edit"
      >
        <Pencil className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant="destructive"
        onClick={onAbort}
        className="h-[44px] w-[44px] shrink-0 rounded-md"
        title={abortTitle}
        data-testid="stop"
      >
        <Square className="h-4 w-4 fill-current" />
      </Button>
    </>
  );
}
