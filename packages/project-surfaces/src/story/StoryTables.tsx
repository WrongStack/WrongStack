import { useState } from 'react';
import { displayDecimal, useAppTranslation } from '../lib/i18n';
import type { storyStats } from './session-story-stats';

type Stats = ReturnType<typeof storyStats>;
const ms = (value: number | undefined) =>
  value === undefined
    ? '—'
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${displayDecimal(value / 1000, 2)} s`;

export function StoryTables({
  stats,
  type,
  onInspect,
}: {
  stats: Stats;
  type: 'tools' | 'files';
  onInspect(value: string): void;
}) {
  const { t } = useAppTranslation();
  const [search, setSearch] = useState('');
  const [limit, setLimit] = useState(50);
  const tools = stats.tools.filter((tool) =>
    tool.name.toLowerCase().includes(search.toLowerCase()),
  );
  const files = stats.files.filter((file) =>
    file.path.toLowerCase().includes(search.toLowerCase()),
  );
  const count = type === 'tools' ? tools.length : files.length;
  const max = Math.max(1, ...stats.tools.map((tool) => tool.calls));
  return (
    <section className="story-enter rounded-2xl border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            {t(type === 'tools' ? 'activity:story.toolPerformance' : 'activity:story.fileActivity')}
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {type === 'tools'
              ? t('activity:story.toolsSubtitle')
              : t('activity:story.filesSubtitle', {
                  files: stats.files.length,
                  dirs: stats.directories,
                })}
          </p>
        </div>
        <input
          aria-label={t(
            type === 'tools'
              ? 'activity:story.searchToolsLabel'
              : 'activity:story.searchFilesLabel',
          )}
          placeholder={t(
            type === 'tools'
              ? 'activity:story.searchToolsPlaceholder'
              : 'activity:story.searchFilesPlaceholder',
          )}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setLimit(50);
          }}
          className="rounded-xl border bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="mt-5 overflow-x-auto">
        {type === 'tools' ? (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                {[
                  'tool',
                  'calls',
                  'success',
                  'failed',
                  'unsettled',
                  'avg',
                  'p95',
                  'measured',
                  'totalTime',
                ].map((label) => (
                  <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">
                    {t(`activity:storyText.col.${label}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tools.slice(0, limit).map((tool) => (
                <tr key={tool.name} className="border-t hover:bg-muted/30">
                  <td className="min-w-44 px-3 py-3">
                    <button
                      type="button"
                      onClick={() => onInspect(tool.name)}
                      className="font-mono text-xs text-info underline"
                    >
                      {tool.name}
                    </button>
                    <div className="mt-2 h-1.5 rounded-full bg-muted">
                      <div
                        className="story-meter h-full rounded-full bg-info"
                        style={{ width: `${(tool.calls / max) * 100}%` }}
                      />
                    </div>
                  </td>
                  {[
                    tool.calls,
                    tool.success,
                    tool.failed,
                    tool.pending,
                    ms(tool.avg),
                    ms(tool.p95),
                    `${tool.measured}/${tool.calls}`,
                    ms(tool.measured ? tool.total : undefined),
                  ].map((value, index) => (
                    <td key={index} className="whitespace-nowrap px-3 py-3 font-mono text-xs">
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                {[
                  'file',
                  'reads',
                  'edits',
                  'writes',
                  'readLines',
                  'addedRemoved',
                  'lineEvidence',
                ].map((label) => (
                  <th key={label} className="whitespace-nowrap px-3 py-3 font-medium">
                    {t(`activity:storyText.col.${label}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {files.slice(0, limit).map((file) => (
                <tr key={file.path} className="border-t hover:bg-muted/30">
                  <td className="max-w-96 break-all px-3 py-3">
                    <button
                      type="button"
                      onClick={() => onInspect(file.path)}
                      className="text-left font-mono text-xs text-info underline"
                    >
                      {file.path}
                    </button>
                    {file.conflicted && (
                      <span
                        title={t('activity:story.conflictFileNote', {
                          defaultValue:
                            'A failed tool call left this file changed on disk (patch --merge writes conflict markers). No line counts were measured.',
                        })}
                        className="ml-2 inline-block border border-destructive/40 px-1 py-0.5 align-middle font-mono text-[10px] uppercase tracking-wide text-destructive"
                      >
                        {t('activity:storyText.conflict')}
                      </span>
                    )}
                    <div
                      className="mt-2 flex h-1.5 w-28 overflow-hidden rounded-full bg-muted"
                      title={t('activity:storyText.barTitle', {
                        reads: file.reads,
                        edits: file.edits,
                        writes: file.writes,
                      })}
                    >
                      {file.reads > 0 && <span className="bg-info" style={{ flex: file.reads }} />}
                      {file.edits > 0 && (
                        <span className="bg-primary" style={{ flex: file.edits }} />
                      )}
                      {file.writes > 0 && (
                        <span className="bg-success" style={{ flex: file.writes }} />
                      )}
                    </div>
                  </td>
                  {[
                    file.reads,
                    file.edits,
                    file.writes,
                    file.readMeasured
                      ? `${file.readLines}${file.readMeasured < file.reads ? '+' : ''}`
                      : '—',
                  ].map((value, index) => (
                    <td key={index} className="px-3 py-3 font-mono text-xs">
                      {value}
                    </td>
                  ))}
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-xs">
                    {file.changeMeasured ? (
                      <>
                        <span className="text-success">+{file.added}</span> /{' '}
                        <span className="text-destructive">−{file.removed}</span>
                        {file.partial || file.changeMeasured < file.edits + file.writes
                          ? ` (${t('activity:storyText.partial')})`
                          : ''}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">
                    {t('activity:storyText.evidenceCounts', {
                      readMeasured: file.readMeasured,
                      reads: file.reads,
                      changeMeasured: file.changeMeasured,
                      changes: file.edits + file.writes,
                    })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {count === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t(type === 'tools' ? 'activity:storyText.noTools' : 'activity:storyText.noFiles')}
        </p>
      )}
      {count > limit && (
        <button
          type="button"
          onClick={() => setLimit((value) => value + 50)}
          className="mt-4 rounded-lg border px-3 py-2 text-xs"
        >
          {t('activity:storyText.showMore')}
        </button>
      )}
      {type === 'files' && (
        <p className="mt-3 text-xs text-muted-foreground">
          {t('activity:storyText.legend')}
          {stats.files.some((file) => file.conflicted) &&
            ` · ${t('activity:storyText.legendConflict')}`}
        </p>
      )}
      {type === 'files' && stats.conflictedTruncated && (
        <p
          role="status"
          className="mt-2 border-l-2 border-destructive/60 pl-2 text-xs text-destructive"
        >
          {t('activity:storyText.truncated')}
        </p>
      )}
      <p className="mt-5 text-[11px] leading-5 text-muted-foreground">
        {type === 'tools' ? t('activity:storyText.toolsNote') : t('activity:storyText.filesNote')}{' '}
        {t('activity:storyText.clickName')}
      </p>
    </section>
  );
}
