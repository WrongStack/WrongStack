import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CouncilDecisionCard } from '../src/council/CouncilDecisionCard.js';
import type { CouncilDecisionData } from '../src/council/types.js';

describe('CouncilDecisionCard vote distribution prototype safety', () => {
  it('renders seats whose optionId matches Object.prototype keys without throwing', () => {
    const decision: CouncilDecisionData = {
      question: 'Which method?',
      outcome: 'approved',
      verdict: 'toString',
      seats: [
        {
          persona: 'Reviewer-1',
          status: 'valid',
          optionId: 'toString',
          weight: 1,
        } as CouncilDecisionData['seats'][number],
        {
          persona: 'Reviewer-2',
          status: 'valid',
          optionId: 'constructor',
          weight: 1,
        } as CouncilDecisionData['seats'][number],
      ],
    };

    const html = renderToStaticMarkup(<CouncilDecisionCard decision={decision} />);
    expect(html).toContain('toString');
    expect(html).toContain('constructor');
  });
});
