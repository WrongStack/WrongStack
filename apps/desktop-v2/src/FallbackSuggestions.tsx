import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { type EngineCommand, EngineReplyError } from './engine-operations';
import { entries, record } from './engine-values';

export interface FallbackSuggestion {
  id: string;
  chain: string[];
  score: number;
  providerCount: number;
  source: string;
  rationale: string;
}

/** The suggestions of a `fallback.suggestions` reply, keeping only usable chains. */
export function readFallbackSuggestions(value: unknown): FallbackSuggestion[] {
  return entries(value).flatMap((row) => {
    const chain = Array.isArray(row['chain'])
      ? row['chain'].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
      : [];
    return typeof row['id'] === 'string' && chain.length
      ? [
          {
            id: row['id'],
            chain,
            score: typeof row['score'] === 'number' ? row['score'] : 0,
            providerCount: Number.isSafeInteger(row['providerCount'])
              ? Number(row['providerCount'])
              : new Set(chain.map((ref) => ref.split('/')[0])).size,
            source: typeof row['source'] === 'string' ? row['source'] : 'heuristic',
            rationale: typeof row['rationale'] === 'string' ? row['rationale'] : '',
          },
        ]
      : [];
  });
}

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((ref): ref is string => typeof ref === 'string') : [];

/**
 * Ready-made fallback chains from the models the profile can reach (`fallback.suggest`). The
 * heuristic pass is offline; "Ask the current model" lets the conversation's model re-rank the
 * same models. A suggestion only changes the draft when the user picks it.
 */
export function FallbackSuggestions({
  command,
  draft,
  onUse,
  onSaveProfile,
}: {
  command: EngineCommand;
  draft: Record<string, unknown>;
  onUse: (chain: string[]) => void;
  onSaveProfile: (id: string, chain: string[]) => void;
}) {
  const [suggestions, setSuggestions] = useState<FallbackSuggestion[] | null>(null),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState('');
  const load = async (mode: 'heuristic' | 'llm') => {
    setBusy(true);
    setNote('');
    const read = (payload: Record<string, unknown>) => {
      const list = readFallbackSuggestions(payload['suggestions']);
      setSuggestions(list);
      const count = Number(payload['candidateCount'] ?? 0);
      const error = typeof payload['error'] === 'string' ? payload['error'] : '';
      setNote(
        [error, list.length ? '' : `No chain could be built from ${count} reachable models.`]
          .filter(Boolean)
          .join(' '),
      );
    };
    try {
      read(
        await command(
          'fallback.suggest',
          {
            mode,
            disabledModels: stringList(draft['disabledModels']),
            disabledProviders: stringList(draft['disabledProviders']),
          },
          ['fallback.suggestions'],
          { timeoutMs: mode === 'llm' ? 120000 : 30000 },
        ),
      );
    } catch (failure) {
      // A failed model pass still carries the heuristic chains with its error.
      if (failure instanceof EngineReplyError) read({ ...failure.details });
      else setNote(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const profiles = record(draft['fallbackProfiles']);
  return (
    <section className="fallback-suggestions" aria-label="Suggested fallback chains">
      <header>
        <strong>
          <Sparkles size={14} /> Suggested chains
        </strong>
        <span className="field-help">
          Built only from models your saved providers list and you have not hidden.
        </span>
      </header>
      <div className="fallback-suggestion-actions">
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          onClick={() => void load('heuristic')}
        >
          {busy ? 'Suggesting…' : 'Suggest chains'}
        </button>
        <button
          type="button"
          className="button secondary small"
          disabled={busy}
          title="The current conversation's model re-ranks the same models; this sends a request."
          onClick={() => void load('llm')}
        >
          Ask the current model
        </button>
      </div>
      {note && <p role="status">{note}</p>}
      {suggestions?.map((suggestion) => {
        const profileId = `suggested-${suggestion.id}`;
        return (
          <article key={suggestion.id} className="fallback-suggestion">
            <h4>
              {suggestion.id}
              <small>
                {' '}
                · {suggestion.providerCount} provider{suggestion.providerCount === 1 ? '' : 's'}
                {suggestion.source === 'llm' ? ' · ranked by the model' : ''}
              </small>
            </h4>
            <ol>
              {suggestion.chain.map((ref) => (
                <li key={ref}>
                  <code>{ref}</code>
                </li>
              ))}
            </ol>
            {suggestion.rationale && <p>{suggestion.rationale}</p>}
            <div className="fallback-suggestion-actions">
              <button
                type="button"
                className="button secondary small"
                onClick={() => onUse(suggestion.chain)}
              >
                Use as default chain
              </button>
              <button
                type="button"
                className="button secondary small"
                disabled={Object.hasOwn(profiles, profileId)}
                title={
                  Object.hasOwn(profiles, profileId)
                    ? `A profile named ${profileId} exists already.`
                    : undefined
                }
                onClick={() => onSaveProfile(profileId, suggestion.chain)}
              >
                Save as profile {profileId}
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
