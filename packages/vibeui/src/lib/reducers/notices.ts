import { text } from '../session-coercion';
import type { FrameReducerTable } from './types';

/** Review reports surface as a notice only when actionable and for this session. */
export const noticeReducers: FrameReducerTable = {
  'chimera.report_available': (state, p) => {
    const reportSessionId = text(p.sessionId);
    if (reportSessionId && state.id && reportSessionId !== state.id) return state;
    if (p.hasActionableFindings === false) return state;
    return {
      ...state,
      notice: text(p.message) || 'A review report is ready. Open WebUI to inspect it.',
    };
  },
};
