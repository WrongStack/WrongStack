import { number, record, rows, text } from '../session-coercion';
import type { FrameReducer, FrameReducerTable } from './types';

/** provider.model_switched nests the target under `to`; model.switch_result is flat. */
const modelSwitched: FrameReducer = (state, p, frame) => {
  const target = frame.type === 'provider.model_switched' ? record(p.to) : p;
  if (p.success === false) return { ...state, notice: text(p.message) || 'Model switch failed.' };
  return {
    ...state,
    provider: text(target.provider) || state.provider,
    model: text(target.model) || state.model,
  };
};

/** Provider catalog, model lists, model switching and key operations. */
export const providerReducers: FrameReducerTable = {
  'provider.catalog': (state, p) => ({
    ...state,
    providers: rows(p.providers).map((v) => ({
      id: text(v.id),
      name: text(v.name) || text(v.id),
      configured: v.hasApiKey === true,
      family: text(v.family),
      baseUrl: text(v.apiBase),
    })),
  }),
  'provider.models': (state, p) => ({
    ...state,
    models: {
      ...state.models,
      [text(p.provider)]: rows(p.models)
        .filter((m) => text(m.id))
        .map((m) => ({
          id: text(m.id),
          name: text(m.name) || text(m.id),
          contextWindow: number(m.contextWindow),
        })),
    },
  }),
  'provider.model_switched': modelSwitched,
  'model.switch_result': modelSwitched,
  'key.operation_result': (state, p) => ({
    ...state,
    notice:
      text(p.message) || (p.success ? 'Provider connected.' : 'Provider could not be connected.'),
  }),
};
