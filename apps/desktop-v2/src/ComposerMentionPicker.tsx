import { matchSkillMentions, type SkillMentionCandidate } from '@wrongstack/webui-protocol';
import { FileText, LoaderCircle, Sparkles } from 'lucide-react';
import { type MutableRefObject, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { entries } from './engine-values';
import { RuntimeGate } from './RuntimeGate';
import { useProjectEngine } from './useEngine';

export function ComposerMentionPicker(props: {
  projectId: string;
  kind: 'file' | 'skill';
  query: string;
  onPick: (value: string) => void;
  onDismiss: () => void;
  keys: MutableRefObject<((key: string) => void) | null>;
}) {
  return (
    <div className="composer-mention-popup">
      <RuntimeGate scope="project" projectId={props.projectId}>
        <ProjectMentionPicker {...props} />
      </RuntimeGate>
    </div>
  );
}
function ProjectMentionPicker({
  projectId,
  kind,
  query,
  onPick,
  onDismiss,
  keys,
}: {
  projectId: string;
  kind: 'file' | 'skill';
  query: string;
  onPick: (value: string) => void;
  onDismiss: () => void;
  keys: MutableRefObject<((key: string) => void) | null>;
}) {
  const { t } = useDesktopText();
  const [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [rows, setRows] = useState<Array<{ value: string; description: string }>>([]),
    [index, setIndex] = useState(0);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const { state, command } = useProjectEngine(projectId, report);
  useEffect(() => {
    let active = true;
    setRows([]);
    setLoading(true);
    setError('');
    setIndex(0);
    if (!state.connected)
      return () => {
        active = false;
      };
    const timer = setTimeout(() => {
      void command(
        kind === 'file' ? 'files.list' : 'skills.list',
        kind === 'file' ? { query, limit: 40 } : {},
        [kind === 'file' ? 'files.list' : 'skills.list'],
      )
        .then((result) => {
          if (!active) return;
          if (kind === 'file')
            setRows(
              (Array.isArray(result['files']) ? result['files'] : [])
                .filter((value): value is string => typeof value === 'string')
                .map((value) => ({ value, description: '' })),
            );
          else
            setRows(
              matchSkillMentions(
                entries(result['skills']) as unknown as SkillMentionCandidate[],
                query,
              )
                .slice(0, 12)
                .map((skill) => ({ value: skill.name, description: skill.description ?? '' })),
            );
        })
        .catch((e) => {
          if (active) report(e);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 80);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, kind, state.connected, command, report]);
  useLayoutEffect(() => {
    keys.current = (key) => {
      if (key === 'Escape') onDismiss();
      if (key === 'ArrowDown' || key === 'ArrowUp')
        setIndex((value) =>
          rows.length ? (value + (key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length : 0,
        );
      if ((key === 'Enter' || key === 'Tab') && rows[index]) onPick(rows[index]!.value);
    };
    return () => {
      keys.current = null;
    };
  }, [rows, index, onPick, onDismiss, keys]);
  useEffect(() => {
    document.getElementById(`mention-choice-${index}`)?.scrollIntoView({ block: 'nearest' });
  }, [index]);
  return (
    <section
      aria-label={
        kind === 'file' ? t('mentionPicker.fileSuggestions') : t('mentionPicker.skillSuggestions')
      }
    >
      <header>
        {kind === 'file' ? <FileText size={14} /> : <Sparkles size={14} />}{' '}
        {kind === 'file' ? t('mentionPicker.files') : t('mentionPicker.skills')}
        <small>{t('mentionPicker.keys')}</small>
      </header>
      {loading ? (
        <p role="status">
          <LoaderCircle size={13} className="spin" /> {t('mentionPicker.loading')}
        </p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !rows.length ? (
        <p>{kind === 'file' ? t('mentionPicker.noFiles') : t('mentionPicker.noSkills')}</p>
      ) : (
        <div
          role="listbox"
          aria-label={kind === 'file' ? t('mentionPicker.files') : t('mentionPicker.skillsList')}
        >
          {rows.map((row, i) => (
            <button
              type="button"
              role="option"
              aria-selected={i === index}
              key={row.value}
              id={`mention-choice-${i}`}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => onPick(row.value)}
              onMouseEnter={() => setIndex(i)}
            >
              <strong>
                {kind === 'skill' ? '$' : ''}
                {row.value}
              </strong>
              <span>{kind === 'file' ? t('mentionPicker.fileDescription') : row.description}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
