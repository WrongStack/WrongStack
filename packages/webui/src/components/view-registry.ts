/**
 * Single source of truth for the per-view main-area rendering.
 *
 * Each entry tells `MainViewSlot` how to render one `View`:
 *
 *  - `Component` — the lazy or eager component. Eager ones are still passed
 *    through `<Suspense>` for symmetry; that's a no-op on a non-lazy module.
 *  - `wrapperClassName` — the wrapping `<div>` class (most views use the
 *    standard flex/min-h-0/min-w-0/overflow-hidden shell; some override it
 *    for a different scroll axis).
 *  - `boundaryNameKey` — i18n key for the ErrorBoundary `name` prop, so a
 *    crash inside a panel is reported under that panel's name and not the
 *    chat one.
 *  - `loadingLabelKey` — optional i18n key for a named Suspense fallback.
 *    When omitted, `PanelSuspense` renders its unlabeled spinner.
 *  - `props` — extra props the entry's component expects (e.g. `onClose`
 *    for panels that go back to chat on ×, or `className` for components
 *    that have to fill a fixed-height parent).
 *
 * `chat` is not in this map because it is mounted for the session lifetime
 * and rendered separately by `ViewRouter`. Anywhere `View` lands at runtime
 * falls back to a "not registered" placeholder — `RoutedView` catches that
 * during the one-time AssertNever check, so an entry can never fall through
 * in CI.
 *
 * See docs/audit/webui-full-review-2026-09-03.md B-17 for the context and
 * view-router/shell examples.
 */
import { lazy, type ComponentType } from 'react';
import type { View } from '@/stores/ui-store';

// Lazy at module scope: one chunk per view, identical to the previous
// `ViewRouter` behaviour. Eager entries (chat, settings, context) are not
// listed because chat is handled separately and the other two are tiny.
const AnalyticsDashboard = lazy(() =>
  import('./AnalyticsDashboard').then((m) => ({ default: m.AnalyticsDashboard })),
);
const AgentRosterView = lazy(() =>
  import('./AgentRosterView').then((m) => ({ default: m.AgentRosterView })),
);
const ChangesView = lazy(() => import('./ChangesView').then((m) => ({ default: m.ChangesView })));
const ChronicleDashboard = lazy(() =>
  import('./ChronicleDashboard').then((m) => ({ default: m.ChronicleDashboard })),
);
const CodeEditor = lazy(() => import('./CodeEditor').then((m) => ({ default: m.CodeEditor })));
const CodeMap = lazy(() => import('./CodeMap').then((m) => ({ default: m.CodeMap })));
const DebugDashboard = lazy(() =>
  import('./DebugDashboard').then((m) => ({ default: m.DebugDashboard })),
);
const DesignGalleryView = lazy(() =>
  import('./DesignGalleryView').then((m) => ({ default: m.DesignGalleryView })),
);
const GoalView = lazy(() => import('./GoalView').then((m) => ({ default: m.GoalView })));
const KanbanView = lazy(() => import('./KanbanView').then((m) => ({ default: m.KanbanView })));
const MailboxDetailView = lazy(() =>
  import('./MailboxDetailView').then((m) => ({ default: m.MailboxDetailView })),
);
const PromptJournalView = lazy(() =>
  import('./PromptJournalView').then((m) => ({ default: m.PromptJournalView })),
);
const RefreshDebugView = lazy(() =>
  import('./RefreshDebugView').then((m) => ({ default: m.RefreshDebugView })),
);
const SageTabs = lazy(() =>
  import('./MemoryManager/SageTabs').then((m) => ({ default: m.SageTabs })),
);
const RequirementIntakeView = lazy(() =>
  import('./RequirementIntakeView').then((m) => ({ default: m.RequirementIntakeView })),
);
const SddHub = lazy(() => import('./SddHub').then((m) => ({ default: m.SddHub })));
const SessionsDashboard = lazy(() =>
  import('./SessionsDashboard').then((m) => ({ default: m.SessionsDashboard })),
);
const SessionInspectView = lazy(() =>
  import('./SessionInspectView').then((m) => ({ default: m.SessionInspectView })),
);
const SkillDetailView = lazy(() =>
  import('./SkillDetailView').then((m) => ({ default: m.SkillDetailView })),
);
const TechStackView = lazy(() =>
  import('./TechStackView').then((m) => ({ default: m.TechStackView })),
);
const DeadCodeScanPanel = lazy(() =>
  import('./DeadCodeScanPanel/DeadCodeScanPanel').then((m) => ({ default: m.DeadCodeScanPanel })),
);
const ChimeraReviewsView = lazy(() =>
  import('./ChimeraReviewsView').then((m) => ({ default: m.ChimeraReviewsView })),
);
const SetupScreen = lazy(() => import('./SetupScreen').then((m) => ({ default: m.SetupScreen })));

// Eager ones stay eager — they're small and chat is in front anyway. Errors
// in `SettingsPanel` and `ContextDashboard` would otherwise double-import
// the same chunk twice (lazy splits it into its own) for no benefit.
import { ContextDashboard } from './ContextDashboard';
import { SettingsPanel } from './SettingsPanel';

export interface ViewMeta {
  /**
   * The view component. Typed as `ComponentType<any>` because individual
   * components take stricter prop shapes (e.g. `KanbanView` requires
   * `onClose`); the registry entry is what guarantees runtime props match.
   */
  Component: ComponentType<any>;
  /** Tailwind class for the wrapping `<div>`. Pass `''` for no wrapper. */
  wrapperClassName: string;
  /**
   * i18n key under the `activity` namespace (e.g. `activity:panels.chat`)
   * used as the ErrorBoundary's `name`. Crashes inside the view are reported
   * under this name so the boundary log can attribute them to the panel.
   */
  boundaryNameKey: string;
  /**
   * Optional i18n key (without i18next quoting — the slot passes it through
   * the hook itself) for a named Suspense fallback. The previous `ViewRouter`
   * mixed both: some views passed a named label to `PanelSuspense`, others
   * rendered the spinner bare. Centralising the choice here means adding a
   * view can no longer omit the label and produce a silent flash.
   *
   * When `null`, the unlabeled spinner is used.
   */
  loadingLabelKey: string | null;
  /**
   * Extra props merged onto the view component at render time. `onClose`
   * for views that × back to chat (Kanban, Goal), `className` for views that
   * have to fill a fixed-height parent (Changes, Mailbox, DesignGallery,
   * SkillDetail, Chimera Reviews).
   */
  props?: Record<string, unknown>;
}

/**
 * Per-view metadata. Order is mostly irrelevant — the slot looks up by view
 * id. `chat` is intentionally absent.
 *
 * Declared with `satisfies`, NOT a type annotation: an annotation widens
 * `typeof VIEW_REGISTRY` to `Partial<Record<View, ViewMeta>>`, whose `keyof`
 * is already the FULL `View` union (optional mapped keys still contribute to
 * keyof) — which made the UnroutedView/StaleRegistryEntry checks below
 * vacuous: they could never fire, and a registry routing zero views compiled
 * clean (round r1-viewregistry-guard-20260903). `satisfies` checks the same
 * ViewMeta shape while keeping the literal keys on the strict const, so the
 * checks read the keys that ACTUALLY exist. The widened export below
 * preserves consumers' `ViewMeta | undefined` lookup type.
 */
const VIEW_REGISTRY_STRICT = {
  settings: {
    Component: SettingsPanel as unknown as ComponentType<Record<string, unknown>>,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.settings',
    // Eager — but the Suspense is still applied so adding a `lazy()` here
    // later only needs touching this entry, not the slot.
    loadingLabelKey: null,
  },
  memory: {
    Component: SageTabs,
    wrapperClassName: '',
    boundaryNameKey: 'activity:panels.sageMemory',
    loadingLabelKey: 'activity:panels.sageMemory',
  },
  roster: {
    Component: AgentRosterView,
    wrapperClassName: 'flex min-h-0 min-w-0 flex-1 overflow-hidden',
    boundaryNameKey: 'activity:panels.agentRoster',
    loadingLabelKey: 'activity:panels.agentRoster',
  },
  context: {
    // Eager, no wrapper, no Suspense label — `ContextDashboard` is the
    // lightweight token bar that needs the surrounding flex to land
    // directly.
    Component: ContextDashboard as unknown as ComponentType<Record<string, unknown>>,
    wrapperClassName: '',
    boundaryNameKey: 'activity:panels.contextDashboard',
    loadingLabelKey: null,
  },
  setup: {
    Component: SetupScreen,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.setup',
    loadingLabelKey: null,
  },
  goal: {
    Component: GoalView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.goal',
    loadingLabelKey: null,
    props: { onClose: 'PANEL_CLOSE_TO_CHAT' },
  },
  sddhub: {
    Component: SddHub,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.sddHub',
    loadingLabelKey: null,
  },
  kanban: {
    Component: KanbanView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.kanban',
    loadingLabelKey: null,
    props: { onClose: 'PANEL_CLOSE_TO_CHAT' },
  },
  sessions: {
    Component: SessionsDashboard,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.sessions',
    loadingLabelKey: null,
  },
  'session-inspect': {
    Component: SessionInspectView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.sessionInspect',
    loadingLabelKey: 'activity:panels.sessionInspect',
  },
  chronicle: {
    Component: ChronicleDashboard,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.chronicle',
    loadingLabelKey: null,
  },
  intake: {
    Component: RequirementIntakeView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.requirementsIntake',
    loadingLabelKey: null,
  },
  prompts: {
    // Uses `activity:nav.prompts` rather than `panels.prompts` — preserved
    // verbatim from the previous ViewRouter.
    Component: PromptJournalView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:nav.prompts',
    loadingLabelKey: 'activity:nav.prompts',
  },
  debug: {
    Component: DebugDashboard,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.debugDashboard',
    loadingLabelKey: null,
  },
  'refresh-debug': {
    Component: RefreshDebugView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.refreshDebug',
    loadingLabelKey: 'activity:panels.refreshDebug',
  },
  files: {
    Component: CodeEditor,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.editor',
    loadingLabelKey: 'activity:panels.editor',
  },
  changes: {
    Component: ChangesView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.changes',
    loadingLabelKey: 'activity:panels.changes',
    props: { className: 'h-full min-h-0' },
  },
  mailbox: {
    Component: MailboxDetailView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.mailbox',
    loadingLabelKey: null,
    props: { className: 'h-full min-h-0' },
  },
  'design-gallery': {
    Component: DesignGalleryView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.designGallery',
    loadingLabelKey: null,
    props: { className: 'h-full' },
  },
  skill: {
    Component: SkillDetailView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.skill',
    loadingLabelKey: null,
    props: { className: 'h-full' },
  },
  analytics: {
    Component: AnalyticsDashboard,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.analytics',
    loadingLabelKey: null,
  },
  codemap: {
    Component: CodeMap,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.codemap',
    loadingLabelKey: 'activity:panels.codemap',
  },
  techstack: {
    Component: TechStackView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:panels.techstack',
    loadingLabelKey: 'activity:panels.techstack',
  },
  deadcode: {
    // Different scroll axis (`overflow-y-auto` vs the standard
    // `overflow-hidden`) — preserved verbatim.
    Component: DeadCodeScanPanel,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-y-auto',
    boundaryNameKey: 'activity:panels.deadcode',
    loadingLabelKey: 'activity:panels.deadcode',
  },
  chimera: {
    Component: ChimeraReviewsView,
    wrapperClassName: 'flex-1 min-h-0 min-w-0 overflow-hidden',
    boundaryNameKey: 'activity:nav.chimera',
    loadingLabelKey: null,
  },
} satisfies Partial<Record<View, ViewMeta>>;

/** Widened view for consumers: `VIEW_REGISTRY[view]` reads `ViewMeta | undefined`. */
export const VIEW_REGISTRY: Partial<Record<View, ViewMeta>> = VIEW_REGISTRY_STRICT;

/**
 * Compile-time proof that every `View` is routed.
 *
 * `keyof typeof VIEW_REGISTRY_STRICT` is the set of keys ACTUALLY PRESENT
 * (the `satisfies` above preserves the literal keys), so
 * `Exclude<View, 'chat' | keyof typeof VIEW_REGISTRY_STRICT>` is `never`
 * only when every non-chat view has a registry entry. A new view added to
 * the store without a route entry fails the build here rather than silently
 * 404ing in production — the same trick `view-navigation.ts` uses to
 * partition the navigation buckets (B-02). `chat` is excluded because it is
 * deliberately registry-less — ViewRouter mounts it for the session
 * lifetime; `StaleRegistryEntry` still rejects any registry key the store
 * has lost.
 */
type AssertNever<T extends never> = T;
type UnroutedView = AssertNever<
  Exclude<Exclude<View, 'chat'>, keyof typeof VIEW_REGISTRY_STRICT>
>;
type StaleRegistryEntry = AssertNever<Exclude<keyof typeof VIEW_REGISTRY_STRICT, View>>;

/**
 * The runtime fallback for `onClose: 'PANEL_CLOSE_TO_CHAT'`. The registry
 * uses a sentinel so the function identity can stay stable across re-renders
 * (one closure per slot, not per registry lookup) while still pointing to a
 * real handler owned by `ViewRouter`.
 */
export const PANEL_CLOSE_TO_CHAT_SENTINEL = 'PANEL_CLOSE_TO_CHAT' as const;
