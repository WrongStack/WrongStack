import { useAppTranslation } from '@/i18n';
import type {
  KanbanBoundaryAccess,
  KanbanBoundaryPolicy,
  KanbanBoundarySelector,
  KanbanBoundarySelectorKind,
} from '@wrongstack/kanban';
import { Save, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

const DEFAULT_POLICY: KanbanBoundaryPolicy = {
  enabled: false,
  enforcement: 'confirm',
  shellAccess: 'confirm',
  allow: [],
};

export function KanbanBoundaryEditor({
  title,
  value,
  inherited,
  onSave,
}: {
  title: string;
  value?: KanbanBoundaryPolicy | undefined;
  inherited?: KanbanBoundaryPolicy | undefined;
  onSave: (policy: KanbanBoundaryPolicy | null) => void;
}) {
  const { t } = useAppTranslation();
  const [policy, setPolicy] = useState<KanbanBoundaryPolicy>(value ?? DEFAULT_POLICY);
  const [allowText, setAllowText] = useState(formatBoundarySelectors(value?.allow ?? []));
  const [denyText, setDenyText] = useState(formatBoundarySelectors(value?.deny ?? []));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPolicy(value ?? DEFAULT_POLICY);
    setAllowText(formatBoundarySelectors(value?.allow ?? []));
    setDenyText(formatBoundarySelectors(value?.deny ?? []));
    setError(null);
  }, [value]);

  const save = () => {
    try {
      const allow = parseBoundarySelectors(allowText);
      const deny = parseBoundarySelectors(denyText);
      onSave({ ...policy, allow, deny });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <details className="rounded-md border border-primary/25 bg-primary/5">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold">
        <ShieldCheck size={14} className="text-primary" />
        <span>{title}</span>
        <span className="ml-auto font-normal text-muted-foreground">
          {value?.enabled
            ? `${value.enforcement} · ${value.allow.length} allow · shell ${value.shellAccess}`
            : inherited?.enabled
              ? 'inherits board boundary'
              : 'unrestricted'}
        </span>
      </summary>
      <div className="space-y-2 border-t p-3 text-xs">
        {inherited?.enabled && (
          <div className="rounded border border-warning/25 bg-warning/10 px-2 py-1.5 text-muted-foreground">
            {t('activity:kanbanBoundaryEditor.boardPolicyRemainsAuthoritativeThisTask')}
          </div>
        )}
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={policy.enabled}
            onChange={(event) => setPolicy({ ...policy, enabled: event.target.checked })}
          />
          {t('activity:kanban.enableLayer')}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className="mb-1 block text-[10px] font-medium uppercase text-muted-foreground">
              {t('activity:kanban.outsideScope')}
            </span>
            <select
              value={policy.enforcement}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  enforcement: event.target.value as KanbanBoundaryPolicy['enforcement'],
                })
              }
              className="h-8 w-full rounded border bg-background px-2"
            >
              <option value="confirm">{t('activity:kanban.askPermission')}</option>
              <option value="block">{t('activity:kanban.alwaysBlock')}</option>
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[10px] font-medium uppercase text-muted-foreground">
              {t('activity:kanbanBoundaryEditor.shellOpaqueTools')}
            </span>
            <select
              value={policy.shellAccess}
              onChange={(event) =>
                setPolicy({
                  ...policy,
                  shellAccess: event.target.value as KanbanBoundaryPolicy['shellAccess'],
                })
              }
              className="h-8 w-full rounded border bg-background px-2"
            >
              <option value="confirm">{t('activity:kanban.askPermission')}</option>
              <option value="block">{t('activity:kanban.alwaysBlock')}</option>
              <option value="allow">{t('activity:kanban.allow')}</option>
            </select>
          </label>
        </div>
        <BoundaryTextarea
          label={t('activity:kanban.allowSelectors')}
          value={allowText}
          onChange={setAllowText}
        />
        <BoundaryTextarea
          label={t('activity:kanban.denySelectors')}
          value={denyText}
          onChange={setDenyText}
        />
        <div className="text-[10px] text-muted-foreground">
          One per line: kind:access:path — for example directory:read_write:packages/webui or
          file:read:README.md. Kinds: file, directory, package, glob. If an access type has no allow
          selector, it remains unrestricted except for deny rules.{' '}
          {t('activity:kanban.crossPathSelectors')}
        </div>
        {error && <div className="text-destructive">{error}</div>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            className="inline-flex h-8 flex-1 items-center justify-center gap-2 rounded bg-primary text-primary-foreground"
          >
            <Save size={13} /> {t('activity:kanbanBoundaryEditor.saveBoundary')}
          </button>
          {value && (
            <button
              type="button"
              onClick={() => onSave(null)}
              className="h-8 rounded border px-3 text-muted-foreground hover:bg-muted"
            >
              {t('activity:kanban.removeLayer')}
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

function BoundaryTextarea({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium uppercase text-muted-foreground">
        {label}
      </span>
      <textarea
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded border bg-background px-2 py-1.5 font-mono text-[11px] outline-none focus:border-primary"
      />
    </label>
  );
}

export function formatBoundarySelectors(selectors: readonly KanbanBoundarySelector[]): string {
  return selectors
    .map((selector) => `${selector.kind}:${selector.access}:${selector.path}`)
    .join('\n');
}

export function parseBoundarySelectors(value: string): KanbanBoundarySelector[] {
  const kinds = new Set<KanbanBoundarySelectorKind>(['file', 'directory', 'package', 'glob']);
  const accesses = new Set<KanbanBoundaryAccess>(['read', 'write', 'read_write']);
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const first = line.indexOf(':');
      const second = line.indexOf(':', first + 1);
      if (first <= 0 || second <= first + 1 || second === line.length - 1) {
        throw new Error(`Boundary line ${index + 1} must use kind:access:path.`);
      }
      const kind = line.slice(0, first) as KanbanBoundarySelectorKind;
      const access = line.slice(first + 1, second) as KanbanBoundaryAccess;
      const selectorPath = line.slice(second + 1).trim();
      if (!selectorPath) {
        throw new Error(`Boundary line ${index + 1} must use kind:access:path.`);
      }
      if (!kinds.has(kind)) throw new Error(`Boundary line ${index + 1} has unknown kind.`);
      if (!accesses.has(access)) throw new Error(`Boundary line ${index + 1} has unknown access.`);
      return { kind, access, path: selectorPath };
    });
}
