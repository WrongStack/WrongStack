import { ArrowUpFromLine, Brain, Eye, LockOpen, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';
import { compactCount, type ModelDetailWords, type PickerModel } from './model-picker-details';

const CAPABILITY_ICONS: Record<string, ReactNode> = {
  tools: <Wrench size={12} />,
  reasoning: <Brain size={12} />,
  vision: <Eye size={12} />,
  open_weights: <LockOpen size={12} />,
};

/** The largest context the bar is drawn against; longer windows fill it. */
const CONTEXT_SCALE = 2_000_000;

/**
 * A model's catalog facts at a glance: its context window as a bar, its price, and its
 * capabilities as icons. Each fact still has its words, as the title and accessible name.
 */
export function ModelPickerFacts({
  model,
  words,
}: {
  model: PickerModel;
  words: ModelDetailWords;
}) {
  const context = model.contextWindow;
  const free = model.inputCost === 0 && model.outputCost === 0;
  const priced = model.inputCost !== undefined && model.outputCost !== undefined;
  const contextWords = context ? words.context(compactCount(context)) : '';
  const outputWords = model.maxOutput ? words.output(compactCount(model.maxOutput)) : '';
  const share = context
    ? Math.max(0.06, Math.min(1, Math.log10(context / 4096) / Math.log10(CONTEXT_SCALE / 4096)))
    : 0;
  return (
    <span className="model-facts">
      {context ? (
        <span className="model-fact model-fact-context" title={contextWords}>
          <span className="model-context-bar" aria-hidden="true">
            <span style={{ inlineSize: `${Math.round(share * 100)}%` }} />
          </span>
          <span aria-hidden="true">{compactCount(context)}</span>
          <span className="project-menu-sr">{contextWords}</span>
        </span>
      ) : null}
      {model.maxOutput ? (
        <span className="model-fact model-fact-output" title={outputWords}>
          <ArrowUpFromLine size={11} aria-hidden="true" />
          <span aria-hidden="true">{compactCount(model.maxOutput)}</span>
          <span className="project-menu-sr">{outputWords}</span>
        </span>
      ) : null}
      {priced ? (
        <span
          className={`model-fact model-fact-price ${free ? 'is-free' : ''}`}
          title={
            free
              ? words.noPrice()
              : words.price(model.inputCost as number, model.outputCost as number)
          }
        >
          {free ? '$0' : `$${model.inputCost} · $${model.outputCost}`}
        </span>
      ) : null}
      {model.capabilities.length > 0 && (
        <span className="model-fact-capabilities">
          {model.capabilities.map((id) => (
            <span
              key={id}
              className={`model-capability capability-${id}`}
              role="img"
              aria-label={words.capability(id)}
              title={words.capability(id)}
            >
              {CAPABILITY_ICONS[id] ?? <span aria-hidden="true">{id.slice(0, 1)}</span>}
            </span>
          ))}
        </span>
      )}
      {model.status && model.status !== 'active' && (
        <span className="model-fact model-fact-status">{model.status}</span>
      )}
    </span>
  );
}
