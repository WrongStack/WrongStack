import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RewoundPrompt } from '../src/SessionRecovery';

it('offers the rewound prompt for editing and says attachments are not restored', () => {
  const markup = renderToStaticMarkup(
    createElement(RewoundPrompt, { text: 'Fix the parser', draftEmpty: false, onEdit() {} }),
  );
  expect(markup).toContain('<pre>Fix the parser</pre>');
  expect(markup).toContain('Edit and resend');
  expect(markup).toContain('Copy prompt');
  expect(markup).toContain('Attached files and images are not restored');
  // The replace choice appears only after asking, never in the first view.
  expect(markup).not.toContain('Replace it with this prompt');
});
