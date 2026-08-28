interface ModelMatrixRouteRole {
  role: string;
  name: string;
}

interface ModelMatrixRouteGroup {
  phase: string;
  label: string;
  roles: readonly ModelMatrixRouteRole[];
}

export const MODEL_MATRIX_DEFAULT_ROUTE = '*';

// Browser-safe projection of the core catalog. The contract test compares
// this compact UI metadata with AGENTS_BY_PHASE so catalog changes cannot
// silently leave the settings route picker stale. Importing the runtime
// catalog here would pull its Node-only prompt and project identity modules
// into the browser bundle.
const BROWSER_AGENT_ROUTES = {
  discovery: [['explore', 'Explore'], ['search', 'Search'], ['research', 'Research']],
  planning: [['analyst', 'Analyst'], ['planner', 'Planner'], ['architect', 'Architect'], ['critic', 'Critic'], ['refactor-planner', 'Refactor Planner']],
  build: [['executor', 'Executor'], ['refactor', 'Refactor'], ['simplifier', 'Simplifier'], ['migration', 'Migration'], ['vision', 'Vision'], ['debugger', 'Debugger'], ['tracer', 'Tracer'], ['concurrency', 'Concurrency']],
  verify: [['realtime', 'Realtime'], ['resilience-engineer', 'Resilience Engineer'], ['chaos-engineer', 'Chaos Engineer'], ['verifier', 'Verifier'], ['test', 'Test'], ['e2e', 'E2E'], ['browser', 'Browser'], ['performance', 'Performance'], ['chaos', 'Chaos'], ['security-scanner', 'Security Scanner'], ['bug-hunter', 'Bug Hunter'], ['audit-log', 'Audit Log']],
  review: [['threat-modeler', 'Threat Modeler'], ['secure-coding-coach', 'Secure Coding Coach'], ['compliance-auditor', 'Compliance Auditor'], ['privacy-engineer', 'Privacy Engineer'], ['reviewer', 'Reviewer'], ['code-reviewer', 'Code Reviewer'], ['security-reviewer', 'Security Reviewer'], ['accessibility', 'Accessibility'], ['compliance', 'Compliance']],
  domain: [['android', 'Android'], ['desktop', 'Desktop'], ['distributed-systems', 'Distributed Systems'], ['database', 'Database'], ['api', 'API'], ['auth', 'Auth'], ['data', 'Data'], ['frontend', 'Frontend'], ['backend', 'Backend'], ['designer', 'Designer'], ['ios', 'iOS'], ['payments', 'Payments'], ['messaging', 'Messaging'], ['search-relevance', 'Search Relevance'], ['storage', 'Storage'], ['ml-engineer', 'ML Engineer'], ['data-governance', 'Data Governance']],
  knowledge: [['document', 'Document'], ['uml', 'UML'], ['i18n', 'I18n'], ['prompt', 'Prompt']],
  delivery: [['platform-engineer', 'Platform Engineer'], ['git', 'Git'], ['release', 'Release'], ['devops', 'DevOps'], ['observability', 'Observability'], ['dependency', 'Dependency']],
  meta: [['skill-manage', 'Skill Manager'], ['self-improving', 'Self-Improving'], ['context', 'Context'], ['cost', 'Cost'], ['tech-stack', 'Tech Stack Validator'], ['plugin-author', 'Plugin Author'], ['tool-author', 'Tool Author'], ['prompt-evaluator', 'Prompt Evaluator'], ['benchmark-engineer', 'Benchmark Engineer'], ['memory-curator', 'Memory Curator'], ['fleet-coordinator', 'Fleet Coordinator']],
} as const;

export const MODEL_MATRIX_ROUTE_GROUPS: readonly ModelMatrixRouteGroup[] = Object.entries(
  BROWSER_AGENT_ROUTES,
).map(([phase, roles]) => ({
  phase,
  label: `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`,
  roles: roles.map(([role, name]) => ({ role, name })),
}));

export const MODEL_MATRIX_PHASE_ROUTES = MODEL_MATRIX_ROUTE_GROUPS.map((group) => group.phase);

const MODEL_MATRIX_ROUTE_ROLES: readonly ModelMatrixRouteRole[] =
  MODEL_MATRIX_ROUTE_GROUPS.flatMap((group) => [...group.roles]);

export const MODEL_MATRIX_ROLE_ROUTES = MODEL_MATRIX_ROUTE_ROLES.map((role) => role.role);

export const MODEL_MATRIX_KNOWN_ROUTES = [
  MODEL_MATRIX_DEFAULT_ROUTE,
  ...MODEL_MATRIX_PHASE_ROUTES,
  ...MODEL_MATRIX_ROLE_ROUTES,
];

export function formatModelMatrixRouteLabel(route: string): string {
  if (route === MODEL_MATRIX_DEFAULT_ROUTE) return 'Default (*)';
  const phase = MODEL_MATRIX_ROUTE_GROUPS.find((group) => group.phase === route);
  if (phase) return `Phase: ${phase.label} (${phase.phase})`;
  const role = MODEL_MATRIX_ROUTE_ROLES.find((candidate) => candidate.role === route);
  return role ? `${role.name} (${role.role})` : `Custom: ${route}`;
}
