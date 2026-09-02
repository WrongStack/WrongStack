import { describe, expect, it } from 'vitest';
import { AGENTS_BY_PHASE } from '../../../core/src/coordination/agents/index';
import { MATRIX_PHASE_KEYS } from '../../../core/src/coordination/model-matrix';
import {
  formatModelMatrixRouteLabel,
  MODEL_MATRIX_DEFAULT_ROUTE,
  MODEL_MATRIX_KNOWN_ROUTES,
  MODEL_MATRIX_PHASE_ROUTES,
  MODEL_MATRIX_ROLE_ROUTES,
  MODEL_MATRIX_ROUTE_GROUPS,
} from '../../src/lib/model-matrix-routes';

describe('model matrix route metadata', () => {
  it('matches the core agent catalog route order', () => {
    expect(MODEL_MATRIX_PHASE_ROUTES).toEqual(MATRIX_PHASE_KEYS);
    expect(
      MODEL_MATRIX_ROUTE_GROUPS.map((group) => [group.phase, group.roles.map((role) => role.role)]),
    ).toEqual(
      Object.entries(AGENTS_BY_PHASE).map(([phase, definitions]) => [
        phase,
        definitions.map((definition) => definition.config.role),
      ]),
    );
  });

  it('includes default, phase, and role keys as selectable routes', () => {
    expect(MODEL_MATRIX_KNOWN_ROUTES[0]).toBe(MODEL_MATRIX_DEFAULT_ROUTE);
    expect(MODEL_MATRIX_KNOWN_ROUTES).toEqual([
      MODEL_MATRIX_DEFAULT_ROUTE,
      ...MODEL_MATRIX_PHASE_ROUTES,
      ...MODEL_MATRIX_ROLE_ROUTES,
    ]);
    expect(new Set(MODEL_MATRIX_KNOWN_ROUTES).size).toBe(MODEL_MATRIX_KNOWN_ROUTES.length);
  });

  it('formats route labels for display', () => {
    expect(formatModelMatrixRouteLabel('*')).toBe('Default (*)');
    expect(formatModelMatrixRouteLabel('verify')).toBe('Phase: Verify (verify)');
    expect(formatModelMatrixRouteLabel('security-scanner')).toBe(
      'Security Scanner (security-scanner)',
    );
    expect(formatModelMatrixRouteLabel('legacy-route')).toBe('Custom: legacy-route');
  });
});
