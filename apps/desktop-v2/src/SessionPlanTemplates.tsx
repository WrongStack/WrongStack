import { ArrowLeft } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import './session-usage.css';
import './session-plan-templates.css';

export interface PlanTemplate {
  name: string;
  description: string;
  category: string;
  items: { title: string; details: string }[];
}

/** The engine's `plan.templates` reply, keeping only well-formed templates. */
export function readPlanTemplates(value: unknown): PlanTemplate[] {
  return entries(value).flatMap((row) =>
    typeof row['name'] === 'string' && row['name']
      ? [
          {
            name: row['name'],
            description: typeof row['description'] === 'string' ? row['description'] : '',
            category: typeof row['category'] === 'string' ? row['category'] : '',
            items: entries(row['items']).flatMap((item) =>
              typeof item['title'] === 'string'
                ? [
                    {
                      title: item['title'],
                      details: typeof item['details'] === 'string' ? item['details'] : '',
                    },
                  ]
                : [],
            ),
          },
        ]
      : [],
  );
}

/**
 * The engine's plan skeletons for this conversation. Applying one adds its items to the
 * conversation's plan (`plan.template_use`); nothing is sent to the model.
 */
export function SessionPlanTemplates({
  command,
  running,
  onBack,
}: {
  command: EngineCommand;
  running: boolean;
  onBack: () => void;
}) {
  const [templates, setTemplates] = useState<PlanTemplate[] | null>(null),
    [selected, setSelected] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    command('plan.templates', {}, ['plan.templates'])
      .then((reply) => {
        if (!live) return;
        const list = readPlanTemplates(reply['templates']);
        setTemplates(list);
        setSelected((current) => current || list[0]?.name || '');
      })
      .catch((failure: unknown) => {
        if (live) setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => {
      live = false;
    };
  }, [command]);
  const template = templates?.find((row) => row.name === selected);
  const apply = async () => {
    if (!template) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const reply = await command('plan.template_use', { template: template.name }, [
        'key.operation_result',
      ]);
      setNotice(typeof reply['message'] === 'string' ? reply['message'] : 'Template applied.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="session-plan-templates" aria-label="Plan templates">
      <header className="session-usage-heading">
        <div>
          <h1>Plan templates</h1>
          <p>
            Add a template's steps to this conversation's plan. The plan shows above the composer;
            the model is not asked to do anything.
          </p>
        </div>
        <div className="session-usage-controls">
          <button type="button" className="button secondary" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to conversation
          </button>
        </div>
      </header>
      {!templates && !error && <p>Loading templates…</p>}
      {templates && !templates.length && <p>This engine offers no plan templates.</p>}
      {!!templates?.length && (
        <>
          <label>
            Template
            <select value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
              {templates.map((row) => (
                <option key={row.name} value={row.name}>
                  {row.name}
                  {row.category ? ` · ${row.category}` : ''}
                </option>
              ))}
            </select>
          </label>
          {template && (
            <>
              <p>{template.description}</p>
              <ol aria-label={`Steps of ${template.name}`}>
                {template.items.map((item, index) => (
                  <li key={index}>
                    {item.title}
                    {item.details && <small> · {item.details}</small>}
                  </li>
                ))}
              </ol>
            </>
          )}
          <button
            type="button"
            className="button primary small"
            disabled={busy || running || !template}
            title={running ? 'Wait until the current turn ends.' : undefined}
            onClick={() => void apply()}
          >
            {busy ? 'Adding…' : 'Add to plan'}
          </button>
        </>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="session-error">
          {error}
        </p>
      )}
    </section>
  );
}
