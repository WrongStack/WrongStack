import { ArrowDown, RefreshCw, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CopyButton } from './CopyButton';
import type { EngineCommand } from './engine-operations';
import { entries, record } from './engine-values';
import { HistoryImage } from './HistoryImage';
import { MarkdownContent } from './MarkdownContent';
import type { HistorySearchSelection } from './ProjectHistorySearch';
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
          throw Error(
            'This engine did not return a readable transcript. Update the project runtime before retrying.',
          );
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
      aria-label="Recorded session transcript"
    >
      <header>
        <div>
          <h3>Conversation</h3>
          <p>Retained messages from this project’s journal. Reading does not resume the agent.</p>
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
          Refresh transcript
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
            aria-label="Search full retained transcript"
            value={query}
            maxLength={500}
            placeholder="Search all retained text…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="Transcript message role"
          value={role}
          onChange={(event) => setRole(event.target.value)}
        >
          <option value="">All roles</option>
          <option value="user">User</option>
          <option value="assistant">Assistant</option>
          <option value="system">System</option>
        </select>
        <button type="submit" className="button secondary" disabled={busy}>
          Search transcript
        </button>
      </form>
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {busy && <p role="status">Reading recorded messages…</p>}
      {page && (
        <p className="field-help">
          {String(page['matching'])} matching messages · {String(page['total'])} retained messages.
          Binary attachments stay unloaded; long text can be read in parts.
        </p>
      )}
      {entries(page?.['messages']).map((message) => (
        <article
          className={`history-message history-role-${message['role']}`}
          aria-label={`Recorded message ${Number(message['index']) + 1}`}
          data-message-index={message['index'] as number}
          key={`${page?.['revision']}-${message['index']}-${filters.query}-${filters.role}`}
        >
          <header>
            <strong>
              {message['origin'] === 'runtime'
                ? 'RUNTIME CONTEXT'
                : String(message['role']).toUpperCase()}
            </strong>
            <span>
              #{Number(message['index']) + 1} · {recoveryDate(message['ts'])}
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
        <p className="quiet-state">No retained messages match this search.</p>
      )}
      {page?.['nextOffset'] !== null && page && (
        <button
          type="button"
          className="button secondary"
          disabled={busy}
          onClick={() => void load(false)}
        >
          <ArrowDown size={14} />
          Load next 10 messages
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
      if (typeof next['text'] !== 'string') throw Error('The recorded text could not be read.');
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
          <strong>{String(block['name'] || 'PDF attachment')}</strong>
          <span>
            {block['pages'] ? `${block['pages']} pages · ` : ''}Extracted text; binary PDF not
            loaded.
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
        <CopyButton text={text} label="Copy visible recorded text" />
        {onReuse && text.trim() && (
          <button type="button" className="button secondary small" onClick={() => onReuse(text)}>
            Add visible text to draft
          </button>
        )}
        {!fromStart && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void read(true)}
          >
            Read from start
          </button>
        )}
        {typeof offset === 'number' && (
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void read(false)}
          >
            {busy ? 'Reading…' : 'Read next text part'}
          </button>
        )}
      </div>
      {typeof offset === 'number' && (
        <p className="field-help">
          Showing a bounded text excerpt{!fromStart ? ' around the search match' : ''}. More text is
          available.
        </p>
      )}
    </>
  );
  return block['type'] === 'thinking' ? (
    <details className="history-thinking">
      <summary>Recorded reasoning</summary>
      {body}
    </details>
  ) : block['type'] === 'tool_result' ? (
    <details className={`history-tool ${block['isError'] ? 'history-tool-error' : ''}`}>
      <summary>
        Tool result · {String(block['name'] || block['toolId'])}
        {block['isError'] ? ' · error' : ''}
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
            : 'This engine did not return the remaining blocks.',
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
          {remaining} more blocks in this message.{' '}
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? 'Loading…' : `Load next ${Math.min(100, remaining)} blocks`}
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
            : 'This engine did not return the complete input.',
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
      <summary>Tool request · {String(block['name'])}</summary>
      <div className="approval-arguments">
        <StructuredToolValue value={full ? full.input : block['input']} />
      </div>
      {full ? (
        <p className="field-help">Complete recorded input.</p>
      ) : (
        <p className="field-help">
          Bounded input preview from the journal.{' '}
          <button
            type="button"
            className="button secondary small"
            disabled={busy}
            onClick={() => void load()}
          >
            {busy ? 'Loading…' : 'Show complete input'}
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
