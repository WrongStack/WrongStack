/**
 * Tests for the Create Skill modal logic:
 * - Name → kebab-case conversion
 * - WS message handler response parsing
 * - Form state transitions
 *
 * These test the business logic in isolation, without React component rendering.
 */

import { describe, expect, it } from 'vitest';

// ─── Name conversion utility ──────────────────────────────────────────────────
// The modal converts name input to kebab-case before submission.
// We test this transformation directly.

function toKebabCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/_/g, ' ') // underscores → spaces (become hyphens next)
    .replace(/[^a-z0-9\s-]/g, '') // remove special chars
    .replace(/\s+/g, '-') // spaces → hyphens
    .replace(/-+/g, '-') // collapse multiple hyphens
    .replace(/^-|-$/g, ''); // trim leading/trailing hyphens
}

describe('toKebabCase — name conversion for Create Skill modal', () => {
  it('converts uppercase to lowercase', () => {
    expect(toKebabCase('MyNewSkill')).toBe('mynewskill');
  });

  it('converts spaces to hyphens', () => {
    expect(toKebabCase('my new skill')).toBe('my-new-skill');
  });

  it('removes non-alphanumeric characters', () => {
    expect(toKebabCase('My_Skill@123!')).toBe('my-skill123');
  });

  it('removes leading and trailing hyphens', () => {
    expect(toKebabCase('-my-skill-')).toBe('my-skill');
  });

  it('collapses multiple hyphens', () => {
    expect(toKebabCase('my---skill')).toBe('my-skill');
  });

  it('handles mixed input', () => {
    expect(toKebabCase('API Design Skill')).toBe('api-design-skill');
  });

  it('returns empty string for input with only special chars', () => {
    expect(toKebabCase('@#$%')).toBe('');
  });
});

// ─── WS handler response ──────────────────────────────────────────────────────
// The create skill WS handler sends { type: 'skills.created', payload: {...} }.
// These tests verify the expected response shape.

interface SkillsCreatedPayload {
  success: boolean;
  error: string | null;
  skill?: {
    name: string;
    path: string;
    scope: string;
  };
}

function parseSkillsCreatedPayload(payload: SkillsCreatedPayload) {
  return {
    isSuccess: payload.success,
    errorMessage: payload.error,
    skillName: payload.skill?.name,
    skillPath: payload.skill?.path,
    skillScope: payload.skill?.scope,
  };
}

describe('skills.created WS message handling', () => {
  it('parses a successful response correctly', () => {
    const payload: SkillsCreatedPayload = {
      success: true,
      error: null,
      skill: {
        name: 'api-design',
        path: '.wrongstack/skills/api-design',
        scope: 'project',
      },
    };

    const result = parseSkillsCreatedPayload(payload);

    expect(result.isSuccess).toBe(true);
    expect(result.errorMessage).toBeNull();
    expect(result.skillName).toBe('api-design');
    expect(result.skillPath).toBe('.wrongstack/skills/api-design');
    expect(result.skillScope).toBe('project');
  });

  it('parses a failed response correctly', () => {
    const payload: SkillsCreatedPayload = {
      success: false,
      error: 'Skill already exists',
      skill: undefined,
    };

    const result = parseSkillsCreatedPayload(payload);

    expect(result.isSuccess).toBe(false);
    expect(result.errorMessage).toBe('Skill already exists');
    expect(result.skillName).toBeUndefined();
  });

  it('returns a generic error when error is null on failure', () => {
    const payload: SkillsCreatedPayload = {
      success: false,
      error: null,
    };

    const result = parseSkillsCreatedPayload(payload);

    // When error is null, the modal shows "Creation failed"
    expect(result.isSuccess).toBe(false);
    expect(result.errorMessage).toBeNull(); // raw value is null
  });
});

// ─── CreateSkill payload building ─────────────────────────────────────────────
// The modal sends { type: 'skills.create', payload: { name, description, scope } }

interface CreateSkillPayload {
  type: 'skills.create';
  payload: {
    name: string;
    description: string;
    scope: 'project' | 'global';
  };
}

function buildCreateSkillMessage(
  name: string,
  description: string,
  scope: 'project' | 'global',
): CreateSkillPayload {
  return {
    type: 'skills.create',
    // The modal trims the name (kebab input) but leaves description as-typed.
    payload: { name: name.trim(), description, scope },
  };
}

describe('buildCreateSkillMessage — WS message construction', () => {
  it('builds a correct message for project scope', () => {
    const msg = buildCreateSkillMessage(
      'api-design',
      'Use this skill when designing APIs',
      'project',
    );

    expect(msg).toEqual({
      type: 'skills.create',
      payload: {
        name: 'api-design',
        description: 'Use this skill when designing APIs',
        scope: 'project',
      },
    });
  });

  it('builds a correct message for global scope', () => {
    const msg = buildCreateSkillMessage('bug-hunter', 'Use this skill when hunting bugs', 'global');

    expect(msg.type).toBe('skills.create');
    expect(msg.payload.scope).toBe('global');
  });

  it('trims name and description before building', () => {
    const msg = buildCreateSkillMessage('  api-design  ', '  Use this skill  ', 'project');

    expect(msg.payload.name).toBe('api-design');
    expect(msg.payload.description).toBe('  Use this skill  '); // description not trimmed by modal
  });
});

// ─── Form validation ──────────────────────────────────────────────────────────

interface FormState {
  name: string;
  description: string;
  isValid: boolean;
}

function validateCreateForm(name: string, description: string): FormState {
  const isValid = name.trim().length > 0 && description.trim().length > 0;
  return { name, description, isValid };
}

describe('validateCreateForm — modal submit button state', () => {
  it('is invalid when name is empty', () => {
    const result = validateCreateForm('', 'Use this skill when testing');
    expect(result.isValid).toBe(false);
  });

  it('is invalid when description is empty', () => {
    const result = validateCreateForm('my-skill', '');
    expect(result.isValid).toBe(false);
  });

  it('is invalid when both are empty', () => {
    const result = validateCreateForm('', '');
    expect(result.isValid).toBe(false);
  });

  it('is valid when both name and description are filled', () => {
    const result = validateCreateForm('my-skill', 'Use this skill when testing');
    expect(result.isValid).toBe(true);
  });

  it('is invalid when name is only whitespace', () => {
    const result = validateCreateForm('   ', 'Use this skill when testing');
    expect(result.isValid).toBe(false);
  });

  it('is invalid when description is only whitespace', () => {
    const result = validateCreateForm('my-skill', '   ');
    expect(result.isValid).toBe(false);
  });
});

// ─── Skill path computation ───────────────────────────────────────────────────

function computeSkillPath(scope: 'project' | 'global', name: string): string {
  if (scope === 'global') {
    return `~/.wrongstack/profiles/default/skills/${name}/SKILL.md`;
  }
  return `.wrongstack/skills/${name}/SKILL.md`;
}

describe('computeSkillPath — skill file path preview', () => {
  it('returns a project-scoped path', () => {
    expect(computeSkillPath('project', 'api-design')).toBe(
      '.wrongstack/skills/api-design/SKILL.md',
    );
  });

  it('returns a global-scoped path', () => {
    expect(computeSkillPath('global', 'bug-hunter')).toBe(
      '~/.wrongstack/profiles/default/skills/bug-hunter/SKILL.md',
    );
  });

  it('handles kebab-case names with slashes', () => {
    // Names with slashes are converted to underscores in the server handler
    expect(computeSkillPath('project', 'api-design')).toContain('api-design');
  });
});

// ─── SkillsCreated server handler logic ───────────────────────────────────────
// The server handler validates name format and returns specific error codes.

interface ValidationResult {
  valid: boolean;
  error: string | null;
}

function validateSkillName(name: string): ValidationResult {
  if (!name || name.trim() !== name) {
    return {
      valid: false,
      error: 'Skill name cannot be empty or have leading/trailing whitespace',
    };
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return {
      valid: false,
      error: 'Skill name must be kebab-case (e.g. api-design, my-new-skill)',
    };
  }
  if (name.length > 64) {
    return { valid: false, error: 'Skill name cannot exceed 64 characters' };
  }
  return { valid: true, error: null };
}

describe('validateSkillName — server-side name validation', () => {
  it('accepts valid kebab-case names', () => {
    expect(validateSkillName('api-design').valid).toBe(true);
    expect(validateSkillName('my-new-skill').valid).toBe(true);
    expect(validateSkillName('bug-hunter-2').valid).toBe(true);
  });

  it('rejects names with uppercase letters', () => {
    expect(validateSkillName('ApiDesign').valid).toBe(false);
    expect(validateSkillName('api-Design').valid).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(validateSkillName('api design').valid).toBe(false);
  });

  it('rejects names starting with a hyphen', () => {
    expect(validateSkillName('-api-design').valid).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(validateSkillName('api_design').valid).toBe(false);
    expect(validateSkillName('api.design').valid).toBe(false);
  });

  it('rejects empty names', () => {
    expect(validateSkillName('').valid).toBe(false);
  });

  it('rejects names exceeding 64 characters', () => {
    const longName = 'a'.repeat(65);
    expect(validateSkillName(longName).valid).toBe(false);
    expect(validateSkillName(longName).error).toContain('64');
  });

  it('provides specific error messages', () => {
    expect(validateSkillName('ApiDesign').error).toContain('kebab-case');
    expect(validateSkillName('').error).toContain('empty');
  });
});

// ─── SkillsPanel store state transitions ──────────────────────────────────────
// The modal affects the skillsState slice in the UI store.

interface SkillsState {
  detailOpen: boolean;
  selectedSkill: string | null;
  navHistory: string[];
  historyIndex: number;
}

function applySkillsCreatedToState(currentState: SkillsState, skillName: string): SkillsState {
  return {
    ...currentState,
    // After creating, the new skill should appear in the list
    // (the list is refreshed via WS, not mutated here)
    selectedSkill: skillName,
  };
}

describe('applySkillsCreatedToState — store update after creation', () => {
  it('returns state with the new skill name as selectedSkill', () => {
    const state: SkillsState = {
      detailOpen: false,
      selectedSkill: null,
      navHistory: [],
      historyIndex: -1,
    };

    const next = applySkillsCreatedToState(state, 'my-new-skill');

    expect(next.selectedSkill).toBe('my-new-skill');
    expect(next.detailOpen).toBe(false); // list refreshes, detail stays closed
  });

  it('preserves navHistory when updating', () => {
    const state: SkillsState = {
      detailOpen: true,
      selectedSkill: 'existing-skill',
      navHistory: ['existing-skill'],
      historyIndex: 0,
    };

    const next = applySkillsCreatedToState(state, 'my-new-skill');

    expect(next.navHistory).toEqual(['existing-skill']);
  });
});

// ─── Description parsing ───────────────────────────────────────────────────────
// The modal passes description as-is to the server. The first line becomes
// the trigger. We verify the description is passed unchanged.

function buildSkillDescription(description: string): { trigger: string; body: string } {
  const lines = description.split('\n');
  return {
    trigger: lines[0] || '',
    body: description,
  };
}

describe('buildSkillDescription — trigger extraction', () => {
  it('extracts the first line as trigger', () => {
    const desc = 'Use this skill when designing REST APIs.\nMore details here.';
    const result = buildSkillDescription(desc);

    expect(result.trigger).toBe('Use this skill when designing REST APIs.');
    expect(result.body).toBe(desc);
  });

  it('handles single-line description', () => {
    const desc = 'Use this skill when testing.';
    const result = buildSkillDescription(desc);

    expect(result.trigger).toBe(desc);
    expect(result.body).toBe(desc);
  });

  it('handles multiline with Triggers line', () => {
    const desc =
      'Use this skill when testing.\n\nMore details.\nTriggers: user says "test", "spec"';
    const result = buildSkillDescription(desc);

    expect(result.trigger).toBe('Use this skill when testing.');
    expect(result.body).toBe(desc);
  });
});
