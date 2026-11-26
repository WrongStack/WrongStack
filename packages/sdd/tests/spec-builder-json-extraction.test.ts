import { describe, expect, it } from 'vitest';
import { extractJSONArrayFromText, extractJSONFromText } from '../src/spec-builder-parsing.js';

describe('raw JSON extraction with trailing prose', () => {
  it('extracts an object followed by prose without braces', () => {
    expect(extractJSONFromText('Spec: {"title":"x","overview":"y"}\nDone.')).toBe(
      '{"title":"x","overview":"y"}',
    );
  });

  it('extracts an object followed by prose containing braces', () => {
    // A greedy first-{ / last-} span swallows the trailing `{that}` and fails
    // JSON.parse, so hasSpecInOutput silently drops an otherwise valid spec.
    expect(extractJSONFromText('Here is the spec:\n{"title":"x"}\nHope {that} helps.')).toBe(
      '{"title":"x"}',
    );
  });

  it('extracts a nested object followed by brace prose', () => {
    expect(extractJSONFromText('Result: {"a":{"b":1}} Thanks {friend}.')).toBe('{"a":{"b":1}}');
  });

  it('does not treat a closing brace inside a string value as the end', () => {
    expect(extractJSONFromText('Spec: {"pattern":"a}b"} Trailing {note}.')).toBe(
      '{"pattern":"a}b"}',
    );
  });

  it('extracts an array followed by prose containing brackets', () => {
    expect(extractJSONArrayFromText('Tasks: [{"id":1}] Note [2] items.')).toBe('[{"id":1}]');
  });

  it('still prefers a ```json fenced block', () => {
    expect(extractJSONFromText('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('returns null when no balanced JSON object exists', () => {
    expect(extractJSONFromText('no json here')).toBeNull();
    expect(extractJSONFromText('{unbalanced')).toBeNull();
  });

  it('returns null when no balanced JSON array exists', () => {
    expect(extractJSONArrayFromText('plain text only')).toBeNull();
    expect(extractJSONArrayFromText('[unbalanced')).toBeNull();
  });
});
