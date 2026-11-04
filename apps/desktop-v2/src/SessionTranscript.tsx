import { ArrowDown, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { HistoryImage } from './HistoryImage';
import { MarkdownContent } from './MarkdownContent';
import type { HistorySearchSelection } from './ProjectHistorySearch';
import { SessionInspectSummary } from './SessionInspectSummary';
import { recoveryDate } from './session-recovery-model';
import { StructuredToolValue } from './ToolApprovalCard';

type Row = Record<string, unknown>;
export function SessionTranscript({
  id,
  command,
  onLink,
  onReuse,
  initialSearch,
}: {
  id: string;
  command: EngineCommand;
  onLink: (href: string) => void;
  onReuse: (text: string) => void;
  initialSearch?: HistorySearchSelection | undefined;
}) {
  const { t } = useDesktopText();
  // Read through a ref so a language change does not reread the transcript.
  const words = useRef(t);
  words.current = t;
  const [page, setPage] = useState<Row | null>(null),
    [error, setError] = useState('');
  const [busy, setBusy] = useState(false),
    [query, setQuery] = useState(initialSearch?.query ?? ''),
    [role, setRole] = useState(initialSearch?.role ?? '');
  const [filters, setFilters] = useState({
    query: initialSearch?.query ?? '',
    role: initialSearch?.role ?? '',
  });
  const expected = useRef(initialSearch?.revision),
    container = useRef<HTMLElement>(null),
    jumped = useRef(false);
  const version = useRef(0),
    snapshot = useRef<Row | null>(null),
    pending = useRef(false);
  const load = useCallback(
    async (reset: boolean) => {
      if (pending.current && !reset) return;
      const generation = ++version.current;
      pending.current = true;
      setBusy(true);
      setError('');
      const previous = snapshot.current;
      if (reset) {
        setPage(null);
        snapshot.current = null;
      }
      try {
        const response = await command(
          'session.inspect',
          {
            id,
            transcriptOnly: true,
            transcript: {
              offset: reset ? 0 : previous?.['nextOffset'],
              limit: 10,
              ...filters,
              ...(reset
                ? expected.current
                  ? { expectedRevision: expected.current }
                  : {}
                : { expectedRevision: previous?.['revision'] }),
            },
          },
          ['session.inspect'],
          { timeoutMs: 90000 },
        );
        if (generation !== version.current) return;
        const data = record(response['transcript']);
        if (typeof data['revision'] !== 'string')
          throw Error(words.current('historyView.transcript.unreadable'));
        const next = {
          ...data,
          messages: reset
            ? entries(data['messages'])
            : [...entries(previous?.['messages']), ...entries(data['messages'])],
        };
        snapshot.current = next;
        setPage(next);
      } catch (error) {
        if (generation === version.current)
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        if (generation === version.current) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
    [command, id, filters],
  );
  useEffect(() => {
    if (!page || !initialSearch || jumped.current) return;
    const target = container.current?.querySelector(
      `[data-message-index="${initialSearch.messageIndex}"]`,
    );
    if (target) {
      target.scrollIntoView({ block: 'center' });
      jumped.current = true;
    }
  }, [page, initialSearch]);
  useEffect(() => {
    void load(true);
    return () => {
      version.current++;
      pending.current = false;
    };
  }, [load]);
  return (
    <section
      ref={container}
      className="history-transcript"
      aria-label={t('historyView.transcript.label')}
    >
      <SessionInspectSummary key={id} id={id} command={command} />
      <header>
        <div>
          <h3>{t('historyView.transcript.title')}</h3>
          <p>{t('historyView.transcript.intro')}</p>
        </div>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => {
            expected.current = undefined;
            jumped.current = true;
            void load(true);
          }}
        >
          <RefreshCw size={13} />
          {t('historyView.transcript.refresh')}
        </button>
      </header>
      <form
        className="history-transcript-search"
        onSubmit={(event) => {
          event.preventDefault();
          expected.current = undefined;
          jumped.current = true;
          setFilters({ query: query.trim(), role });
        }}
      >
        <label>
          <Search size={14} />
          <input
            aria-label={t('historyView.transcript.search')}
            value={query}
            maxLength={500}
            placeholder={t('historyView.transcript.searchPlaceholder')}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label={t('historyView.transcript.role')}
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="">{t('historyView.contentSearch.allRoles')}</option>
          {['user', 'assistant', 'system'].map((value) => (
            <option key={value} value={value}>
              {t(`historyView.contentSearch.role.${value}`)}
            </option>
          ))}
        </select>
        <button type="submit" className="button secondary" disabled={busy}>
          {t('historyView.transcript.submit')}
        </button>
      </form>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {busy && <p role="status">{t('historyView.transcript.reading')}</p>}
      {page && (
        <p className="field-help">
          {t('historyView.transcript.counts', {
            matching: String(page['matching']),
            total: String(page['total']),
          })}
        </p>
      )}
      {entries(page?.['messages']).map((message) => (
        <article
          className={`history-message history-role-${message['role']}`}
          aria-label={t('historyView.transcript.message', { n: Number(message['index']) + 1 })}
          data-message-index={message['index'] as number}
          key={`${page?.['revision']}-${message['index']}-${filters.query}-${filters.role}`}
        >
          <header>
            <strong>
              {message['origin'] === 'runtime'
                ? t('historyView.transcript.runtime')
                : t(`historyView.contentSearch.roleCaps.${String(message['role'])}`, {
                    defaultValue: String(message['role']).toUpperCase(),
                  })}
            </strong>
            <span>
              #{Number(message['index']) + 1} ·{' '}
              {recoveryDate(message['ts'], t('recovery.timeMissing'))}
            </span>
          </header>
          {entries(message['blocks']).map((block) => (
            <TranscriptBlock
              key={String(block['index'])}
              block={block}
              sessionId={id}
              messageIndex={Number(message['index'])}
              revision={String(page?.['revision'])}
              command={command}
              onLink={onLink}
              onReuse={
                message['role'] === 'user' &&
                message['origin'] !== 'runtime' &&
                (typeof message['authoredLength'] !== 'number' ||
                  Number(block['index']) < message['authoredLength']) &&
                block['type'] === 'text'
                  ? onReuse
                  : undefined
              }
            />
          ))}
          {Number(message['omittedBlocks']) > 0 && (
            <MoreMessageBlocks
              key={`${String(page?.['revision'])}:${String(message['index'])}`}
              omitted={Number(message['omittedBlocks'])}
              shown={entries(message['blocks']).length}
              sessionId={id}
              messageIndex={Number(message['index'])}
              revision={String(page?.['revision'])}
              command={command}
              onLink={onLink}
            />
          )}
        </article>
      ))}
      {page && !entries(page['messages']).length && (
        <p className="quiet-state">{t('historyView.transcript.noMatches')}</p>
      )}
      {page?.['nextOffset'] !== null && page && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load(false)}
        >
          <ArrowDown size={14} />
          {t('historyView.transcript.loadMore')}
        </button>
      )}
    </section>
  );
}
function TranscriptBlock({
  block,
  sessionId,
  messageIndex,
  revision,
  command,
  onLink,
  onReuse,
}: {
  block: Row;
  sessionId: string;
  messageIndex: number;
  revision: string;
  command: EngineCommand;
  onLink: (href: string) => void;
  onReuse?: ((text: string) => void) | undefined;
}) {
  const { t } = useDesktopText();
  const [text, setText] = useState(String(block['text'] ?? ''));
  const [offset, setOffset] = useState(block['nextTextOffset']);
  const [fromStart, setFromStart] = useState(Number(block['textOffset'] ?? 0) === 0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const read = async (start: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await command(
        'session.inspect',
        {
          id: sessionId,
          transcriptBlock: {
            messageIndex,
            blockIndex: block['index'],
            expectedRevision: revision,
            offset: start ? 0 : offset,
          },
        },
        ['session.inspect'],
        { timeoutMs: 90000 },
      );
      if (!alive.current) return;
      const next = record(result['transcriptBlock']);
      if (typeof next['text'] !== 'string') throw Error(t('historyView.block.textUnreadable'));
      setText((previous) => (start ? String(next['text']) : previous + next['text']));
      setOffset(next['nextTextOffset']);
      if (start) setFromStart(true);
    } catch (error) {
      if (alive.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  if (block['type'] === 'image')
    return (
      <HistoryImage
        command={command}
        sessionId={sessionId}
        revision={revision}
        messageIndex={messageIndex}
        blockIndex={Number(block['index'])}
        mediaType={String(block['mediaType'])}
      />
    );
  if (block['type'] === 'tool_use')
    return (
      <HistoryToolRequest
        block={block}
        sessionId={sessionId}
        messageIndex={messageIndex}
        revision={revision}
        command={command}
      />
    );
  const body = (
    <>
      {block['type'] === 'document' && (
        <div className="history-attachment">
          <strong>{String(block['name'] || t('historyView.block.pdf'))}</strong>
          <span>
            {block['pages']
              ? t('historyView.block.pdfPages', { n: String(block['pages']) })
              : t('historyView.block.pdfText')}
          </span>
        </div>
      )}
      {block['type'] === 'tool_result' ? (
        <pre className="history-tool-output">{text}</pre>
      ) : (
        <MarkdownContent text={text} onLink={onLink} />
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      <div className="history-message-actions">
        <CopyButton text={text} label={t('historyView.block.copy')} />
        {onReuse && text.trim() && (
          <button type="button" className="button secondary small" onClick={() => onReuse(text)}>
            {t('historyView.block.reuse')}
          </button>
        )}
        {!fromStart && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void read(true)}
          >
            {t('historyView.block.fromStart')}
          </button>
        )}
        {typeof offset === 'number' && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void read(false)}
          >
            {busy ? t('historyView.block.reading') : t('historyView.block.next')}
          </button>
        )}
      </div>
      {typeof offset === 'number' && (
        <p className="field-help">
          {fromStart ? t('historyView.block.excerpt') : t('historyView.block.excerptMatch')}
        </p>
      )}
    </>
  );
  return block['type'] === 'thinking' ? (
    <details className="history-thinking">
      <summary>{t('historyView.block.reasoning')}</summary>
      {body}
    </details>
  ) : block['type'] === 'tool_result' ? (
    <details className={`history-tool ${block['isError'] ? 'history-tool-error' : ''}`}>
      <summary>
        {t(
          block['isError'] ? 'historyView.block.toolResultError' : 'historyView.block.toolResult',
          {
            name: String(block['name'] || block['toolId']),
          },
        )}
      </summary>
      {body}
    </details>
  ) : (
    <div className="history-text-block">{body}</div>
  );
}

/** Blocks a long message has beyond the page's first hundred, read a hundred at a time. */
function MoreMessageBlocks({
  omitted,
  shown,
  sessionId,
  messageIndex,
  revision,
  command,
  onLink,
}: {
  omitted: number;
  shown: number;
  sessionId: string;
  messageIndex: number;
  revision: string;
  command: EngineCommand;
  onLink: (href: string) => void;
}) {
  const { t } = useDesktopText();
  const [more, setMore] = useState<Row[]>([]),
    [next, setNext] = useState<number | null>(shown),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    if (next === null) return;
    setBusy(true);
    setError('');
    try {
      const result = await command(
        'session.inspect',
        {
          id: sessionId,
          transcriptBlocks: { messageIndex, expectedRevision: revision, blockOffset: next },
        },
        ['session.inspect'],
        { timeoutMs: 90000 },
      );
      const page = record(result['transcriptBlocks']);
      if (page['blockOffset'] !== next || !Array.isArray(page['blocks']))
        throw Error(
          typeof result['error'] === 'string'
            ? result['error']
            : t('historyView.block.moreUnreadable'),
        );
      setMore((current) => [...current, ...entries(page['blocks'])]);
      setNext(typeof page['nextBlockOffset'] === 'number' ? page['nextBlockOffset'] : null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const remaining = omitted - more.length;
  return (
    <>
      {more.map((block) => (
        <TranscriptBlock
          key={String(block['index'])}
          block={block}
          sessionId={sessionId}
          messageIndex={messageIndex}
          revision={revision}
          command={command}
          onLink={onLink}
        />
      ))}
      {next !== null && remaining > 0 && (
        <p className="field-help">
          {t('historyView.block.more', { n: remaining })}{' '}
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy
              ? t('historyView.block.loading')
              : t('historyView.block.loadMore', { n: Math.min(100, remaining) })}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </>
  );
}

/** A recorded tool request: the bounded preview, and its complete input on request. */
function HistoryToolRequest({
  block,
  sessionId,
  messageIndex,
  revision,
  command,
}: {
  block: Row;
  sessionId: string;
  messageIndex: number;
  revision: string;
  command: EngineCommand;
}) {
  const { t } = useDesktopText();
  const [full, setFull] = useState<{ input: unknown } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const load = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await command(
        'session.inspect',
        {
          id: sessionId,
          transcriptToolInput: {
            messageIndex,
            blockIndex: block['index'],
            expectedRevision: revision,
          },
        },
        ['session.inspect'],
        { timeoutMs: 90000 },
      );
      const read = record(result['transcriptToolInput']);
      if (read['blockIndex'] !== block['index'] || !('input' in read))
        throw Error(
          typeof result['error'] === 'string'
            ? result['error']
            : t('historyView.block.inputUnreadable'),
        );
      setFull({ input: read['input'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="history-tool">
      <summary>{t('historyView.block.toolRequest', { name: String(block['name']) })}</summary>
      <div className="approval-arguments">
        <StructuredToolValue value={full ? full.input : block['input']} />
      </div>
      {full ? (
        <p className="field-help">{t('historyView.block.inputComplete')}</p>
      ) : (
        <p className="field-help">
          {t('historyView.block.inputPreview')}{' '}
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? t('historyView.block.loading') : t('historyView.block.showInput')}
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </details>
  );
}
