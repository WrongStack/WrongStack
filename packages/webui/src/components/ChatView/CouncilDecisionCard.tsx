import { CouncilDecisionCard as SharedCouncilDecisionCard } from '@wrongstack/project-surfaces/council/CouncilDecisionCard';
import { memo } from 'react';
import type { ChatMessage } from '@/stores';

export { parseCouncilMarkdown } from '@wrongstack/project-surfaces/council/CouncilDecisionCard';

/** A chat message's council decision, drawn by the card the desktop shares. */
export const CouncilDecisionCard = memo(function CouncilDecisionCard({
  message,
}: {
  message: ChatMessage;
}) {
  return <SharedCouncilDecisionCard decision={message.councilDecision} content={message.content} />;
});
