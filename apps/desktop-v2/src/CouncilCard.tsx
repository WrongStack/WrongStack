import { CouncilDecisionCard } from '@wrongstack/project-surfaces/council/CouncilDecisionCard';
import type { CouncilDecisionData } from '@wrongstack/project-surfaces/council/types';
import { I18nextProvider } from 'react-i18next';
import { surfaceI18n } from './surface-i18n';
import './surfaces.css';

/**
 * A Brain council's decision in the conversation, drawn by the WebUI's own card inside the
 * WebUI theme scope. Loaded on first use, so the shared stylesheet stays out of the chat's
 * startup bundle.
 */
export default function CouncilCard({ decision }: { decision: CouncilDecisionData }) {
  return (
    <I18nextProvider i18n={surfaceI18n}>
      <div className="ws-surfaces">
        <CouncilDecisionCard decision={decision} />
      </div>
    </I18nextProvider>
  );
}
