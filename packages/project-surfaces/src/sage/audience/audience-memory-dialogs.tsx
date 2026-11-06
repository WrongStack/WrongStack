import { Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAppTranslation } from '../../lib/i18n';
import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { Input } from '../../ui/input';
import { MEMORY_KINDS, memoryKindLabel, splitList } from '../shared';

export interface CreateEntry {
  text: string;
  kind: string;
  roles: string[];
  taskTypes: string[];
  modes: string[];
}

export function CreateAudienceMemoryDialog({
  open,
  busy,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (entry: CreateEntry) => void;
}) {
  const { t } = useAppTranslation();
  const [text, setText] = useState('');
  const [kind, setKind] = useState('workflow');
  const [roles, setRoles] = useState('');
  const [taskTypes, setTaskTypes] = useState('');
  const [modes, setModes] = useState('');

  useEffect(() => {
    if (open) return;
    setText('');
    setKind('workflow');
    setRoles('');
    setTaskTypes('');
    setModes('');
  }, [open]);

  const parsedRoles = splitList(roles);
  const parsedTaskTypes = splitList(taskTypes);
  const parsedModes = splitList(modes);
  const canSubmit =
    text.trim().length > 0 &&
    (parsedRoles.length > 0 || parsedTaskTypes.length > 0 || parsedModes.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('activity:audienceMem.createTitle')}</DialogTitle>
          <DialogDescription>{t('activity:audienceMem.createBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <label htmlFor="audience-memory-text" className="mb-1.5 block text-xs font-medium">
              {t('activity:audienceMem.fieldMemory')}
            </label>
            <textarea
              id="audience-memory-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('activity:audienceMem.whatShouldMatchingAgentsRemember')}
              rows={4}
              autoFocus
              className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="audience-memory-kind" className="mb-1.5 block text-xs font-medium">
              {t('activity:audienceMem.fieldKind')}
            </label>
            <select
              id="audience-memory-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {MEMORY_KINDS.map((value) => (
                <option key={value} value={value}>
                  {memoryKindLabel(value, t)}
                </option>
              ))}
            </select>
          </div>
          <fieldset className="space-y-3 rounded-md border border-border/70 bg-background/35 p-3">
            <legend className="px-1 text-xs font-medium">
              {t('activity:audienceMem.selectors')}
            </legend>
            <AudienceInput
              id="audience-memory-roles"
              label={t('activity:audienceMem.statRoles')}
              value={roles}
              onChange={setRoles}
              placeholder={t('activity:audienceMem.reviewerRefactorPlanner')}
            />
            <AudienceInput
              id="audience-memory-task-types"
              label={t('activity:audienceMem.fieldTaskTypes')}
              value={taskTypes}
              onChange={setTaskTypes}
              placeholder={t('activity:audienceMem.reviewRefactorBugfix')}
            />
            <AudienceInput
              id="audience-memory-modes"
              label={t('activity:audienceMem.statModes')}
              value={modes}
              onChange={setModes}
              placeholder={t('activity:audienceMem.teachCodeReview')}
            />
            <p className="text-[10px] text-muted-foreground">
              {t('activity:audienceMem.selectorsHint')}
            </p>
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common:action.cancel')}
          </Button>
          <Button
            onClick={() =>
              onCreate({
                text: text.trim(),
                kind,
                roles: parsedRoles,
                taskTypes: parsedTaskTypes,
                modes: parsedModes,
              })
            }
            disabled={!canSubmit || busy}
          >
            {busy ? 'Remembering…' : 'Remember'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AudienceInput({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[6rem_1fr] sm:items-center">
      <label htmlFor={id} className="text-[11px] font-medium text-muted-foreground">
        {label}
      </label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-8 font-mono text-xs"
      />
    </div>
  );
}

export function ImportAudienceMemoryDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (raw: string) => boolean;
}) {
  const { t } = useAppTranslation();
  const [raw, setRaw] = useState('');

  useEffect(() => {
    if (!open) setRaw('');
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('activity:audienceMem.importTitle')}</DialogTitle>
          <DialogDescription>
            {t('activity:audienceMem.importBodyBefore')}{' '}
            <code>{t('activity:audienceMemoryPanel.memoryAudienceExport')}</code>.{' '}
            {t('activity:audienceMem.importBodyAfter')}
          </DialogDescription>
        </DialogHeader>
        <div>
          <label htmlFor="audience-memory-import" className="mb-1.5 block text-xs font-medium">
            {t('activity:audienceMem.jsonArray')}
          </label>
          <textarea
            id="audience-memory-import"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            placeholder={'[\n  { "text": "…", "audience": { "roles": ["reviewer"] } }\n]'}
            rows={10}
            autoFocus
            spellCheck={false}
            className="w-full resize-y rounded-md border border-input bg-background p-3 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:action.cancel')}
          </Button>
          <Button onClick={() => onImport(raw)} disabled={!raw.trim()}>
            <Upload className="size-4" />
            {t('activity:audienceMem.importAction')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
