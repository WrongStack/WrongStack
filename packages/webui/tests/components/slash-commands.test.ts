import { describe, expect, it } from 'vitest';
import {
  SLASH_COMMANDS,
  SLASH_CATEGORY_ORDER,
  detectAtMention,
  matchSlash,
} from '@/components/ChatInput/slash-commands';

describe('SLASH_CATEGORY_ORDER', () => {
  it('contains all expected categories', () => {
    expect(SLASH_CATEGORY_ORDER).toEqual(['Run', 'Session', 'Inspect', 'Agent', 'Config', 'App']);
  });
});

describe('SLASH_COMMANDS', () => {
  it('has commands in each category', () => {
    const byCategory = new Map(SLASH_CATEGORY_ORDER.map((c) => [c, 0]));
    for (const cmd of SLASH_COMMANDS) {
      byCategory.set(cmd.category, (byCategory.get(cmd.category) ?? 0) + 1);
    }
    for (const cat of SLASH_CATEGORY_ORDER) {
      expect(byCategory.get(cat) ?? 0).toBeGreaterThan(0);
    }
  });

  it('has no duplicate command names', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only advertises commands with WebUI behavior', () => {
    const names = new Set(SLASH_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    for (const command of [
      '/agents', '/compact!', '/enhance', '/load',
      '/next', '/repair', '/resume', '/suggest',
    ]) {
      expect(names.has(command)).toBe(true);
    }
  });
});

describe('matchSlash', () => {
  // The empty / "/" query hides commands flagged `hidden` (the f1–f12 aliases),
  // so the visible count is the non-hidden subset, not the full registry.
  const visibleCount = SLASH_COMMANDS.filter((c) => !c.hidden).length;

  it('returns all visible commands for empty string', () => {
    expect(matchSlash('')).toHaveLength(visibleCount);
    expect(matchSlash('').some((c) => c.hidden)).toBe(false);
  });

  it('returns all visible commands for "/"', () => {
    expect(matchSlash('/')).toHaveLength(visibleCount);
    expect(matchSlash('/').some((c) => c.hidden)).toBe(false);
  });

  it('matches exact command name', () => {
    expect(matchSlash('/new').map((c) => c.name)).toEqual(['/new']);
  });

  it('matches command prefix', () => {
    expect(matchSlash('/comp').map((c) => c.name)).toEqual(['/compact', '/compact!']);
  });

  it('matches aliases', () => {
    expect(matchSlash('/resume').map((c) => c.name)).toEqual(['/load']);
    expect(matchSlash('/skills').map((c) => c.name)).toEqual(['/skill']);
  });

  it('matches case-insensitively', () => {
    expect(matchSlash('/RES').map((c) => c.name)).toEqual(['/load']);
    expect(matchSlash('/COMP').map((c) => c.name)).toEqual(['/compact', '/compact!']);
  });

  it('returns empty array for no match', () => {
    expect(matchSlash('/xyznotexist')).toHaveLength(0);
  });

  it('returns single match for unique prefix', () => {
    expect(matchSlash('/exit').map((c) => c.name)).toEqual(['/exit']);
  });

  it('returns multiple matches for ambiguous prefix', () => {
    const results = matchSlash('/s');
    const names = results.map((c) => c.name);
    expect(names.length).toBeGreaterThan(1);
    expect(names).toContain('/save');
    expect(names).toContain('/skill');
  });
});

describe('detectAtMention', () => {
  it('detects @ at start of string', () => {
    expect(detectAtMention('@src/App', 8)).toEqual({ start: 0, query: 'src/App' });
  });

  it('detects @ preceded by space', () => {
    expect(detectAtMention('open @pack', 10)).toEqual({ start: 5, query: 'pack' });
  });

  it('returns null for email-like pattern', () => {
    expect(detectAtMention('email@domain.test', 16)).toBeNull();
  });

  it('returns null for cursor inside query after @mention', () => {
    expect(detectAtMention('open @src and keep typing', 14)).toBeNull();
  });

  it('returns null for cursor at 0', () => {
    expect(detectAtMention('@foo', 0)).toBeNull();
  });

  it('returns null when @ preceded by non-space non-empty char', () => {
    expect(detectAtMention('x@foo', 5)).toBeNull();
  });

  it('handles cursor at end of mention query', () => {
    expect(detectAtMention('@user', 5)).toEqual({ start: 0, query: 'user' });
    expect(detectAtMention('@u', 2)).toEqual({ start: 0, query: 'u' });
    expect(detectAtMention('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('returns null when @ is part of a larger word', () => {
    // "foo@bar" — @ at index 3, char before is 'o' (not whitespace, not start)
    expect(detectAtMention('foo@bar', 7)).toBeNull();
  });

  it('returns null when second @ encountered before cursor', () => {
    // "a@b@c" at cursor 5 — @ at index 3, char before it is 'b' (not whitespace)
    expect(detectAtMention('a@b@c', 5)).toBeNull();
  });
});
