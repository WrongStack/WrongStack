import { Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Trans } from 'react-i18next';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { surfaceI18n } from './surface-i18n';

export function catalogMatchDefinition(match: Record<string, unknown>) {
  const md: Record<string, unknown> = { name: String(match['name'] ?? match['modelId']) };
  if (typeof match['description'] === 'string') md['description'] = match['description'];
  if (typeof match['releaseDate'] === 'string') md['release_date'] = match['releaseDate'];
  const limit: Record<string, unknown> = {},
    cost: Record<string, unknown> = {};
  for (const [source, target] of [
    ['contextWindow', 'context'],
    ['maxOutput', 'output'],
  ])
    if (typeof match[source!] === 'number') limit[target!] = match[source!];
  for (const [source, target] of [
    ['inputCost', 'input'],
    ['outputCost', 'output'],
  ])
    if (typeof match[source!] === 'number') cost[target!] = match[source!];
  if (Object.keys(limit).length) md['limit'] = limit;
  if (Object.keys(cost).length) md['cost'] = cost;
  const caps = Array.isArray(match['capabilities']) ? match['capabilities'] : [];
  if (caps.includes('tools')) md['tool_call'] = true;
  if (caps.includes('reasoning')) md['reasoning'] = true;
  if (caps.includes('open_weights')) md['open_weights'] = true;
  if (caps.includes('vision')) md['modalities'] = { input: ['text', 'image'] };
  return { modelsDev: md };
}
export function CatalogModelSearch({
  command,
  providerId,
  existing,
  onSelect,
  onClose,
}: {
  command: EngineCommand;
  providerId: string;
  existing: string[];
  onSelect: (id: string, definition: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<Record<string, unknown>[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const search = async () => {
    const seq = ++sequence.current;
    setBusy(true);
    setError('');
    setMatches([]);
    setSearched(false);
    try {
      const result = await command('provider.models.search', { query: query.trim(), limit: 20 }, [
        'provider.models.search_result',
      ]);
      if (seq !== sequence.current) return;
      if (result['query'] !== query.trim()) throw Error(t('registrySearch.otherSearch'));
      setMatches(entries(result['matches']));
      setSearched(true);
    } catch (error) {
      if (seq === sequence.current) setError(String(error));
    } finally {
      if (seq === sequence.current) setBusy(false);
    }
  };
  return (
    <section className="catalog-model-search" aria-label={t('registrySearch.label')}>
      <header>
        <div>
          <h3>{t('registrySearch.title')}</h3>
          <p>
            <Trans
              i18n={surfaceI18n}
              ns="desktop"
              i18nKey="registrySearch.intro"
              values={{ provider: providerId }}
              components={{ strong: <strong /> }}
            />
          </p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label={t('registrySearch.close')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <label>
          {t('registrySearch.query')}
          <input
            aria-label={t('registrySearch.label')}
            value={query}
            onChange={(event) => {
              sequence.current++;
              setQuery(event.target.value);
              setMatches([]);
              setSearched(false);
              setBusy(false);
            }}
          />
        </label>
        <button type="submit" className="button secondary" disabled={!query.trim() || busy}>
          <Search size={14} />
          {t('registrySearch.search')}
        </button>
      </form>
      {busy && <p role="status">{t('registrySearch.searching')}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
      {searched && !matches.length && <p>{t('registrySearch.none')}</p>}
      <div className="registry-model-results">
        {matches.map((match) => (
          <article key={`${match['providerId']}:${match['modelId']}`}>
            <div>
              <strong>{String(match['name'])}</strong>
              <code>{String(match['modelId'])}</code>
              <small>
                {t('registrySearch.line', {
                  provider: String(match['providerName']),
                  context:
                    typeof match['contextWindow'] === 'number'
                      ? match['contextWindow'].toLocaleString()
                      : t('registrySearch.notReported'),
                })}
              </small>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={existing.includes(String(match['modelId']))}
              onClick={() => onSelect(String(match['modelId']), catalogMatchDefinition(match))}
            >
              {existing.includes(String(match['modelId']))
                ? t('registrySearch.defined')
                : t('registrySearch.review')}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
