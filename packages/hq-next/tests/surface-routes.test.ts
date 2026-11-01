import { describe, expect, it } from 'vitest';
import { surfaceHref } from '../src/lib/surface-routes';

describe('surfaceHref', () => {
  it('leaves every link alone on the desktop', () => {
    expect(surfaceHref('desktop', '/fleet/console/?session=s1')).toBe('/fleet/console/?session=s1');
  });

  it('maps routes with a phone twin, keeping the query', () => {
    expect(surfaceHref('mobile', '/fleet/console/?session=s1&agent=a')).toBe(
      '/mobile/chat/?session=s1&agent=a',
    );
    expect(surfaceHref('mobile', '/inbox/?item=approval%3Ax')).toBe('/mobile/?item=approval%3Ax');
    expect(surfaceHref('mobile', '/work/mailbox/')).toBe('/mobile/mail/');
    expect(surfaceHref('mobile', '/fleet/machines/?machine=host%3Alab-02')).toBe(
      '/mobile/fleet/?machine=host%3Alab-02',
    );
    expect(surfaceHref('mobile', '/work')).toBe('/mobile/board/');
    expect(surfaceHref('mobile', '/')).toBe('/mobile/');
  });

  it('keeps routes without a twin on the desktop rather than guessing', () => {
    expect(surfaceHref('mobile', '/inbox/alerts/')).toBe('/inbox/alerts/');
    expect(surfaceHref('mobile', '/fleet/')).toBe('/fleet/');
    expect(surfaceHref('mobile', '/system/security/')).toBe('/system/security/');
  });
});
