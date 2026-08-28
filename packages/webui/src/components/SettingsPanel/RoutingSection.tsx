import { Layers } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import {
  formatModelMatrixRouteLabel,
  MODEL_MATRIX_DEFAULT_ROUTE,
  MODEL_MATRIX_KNOWN_ROUTES,
  MODEL_MATRIX_ROUTE_GROUPS,
} from '@/lib/model-matrix-routes';
import { type LocalPrefs, useLocalPrefs } from '@/stores/local-prefs';
import { Button } from '../ui/button';

type ModelRouteEntry = LocalPrefs['modelMatrix'][string];
type ModelRouteRuntime = NonNullable<ModelRouteEntry['modelRuntime']>;
type ModelRouteReasoning = NonNullable<ModelRouteRuntime['reasoning']>;
type RouteReasoningModeControl = '' | NonNullable<ModelRouteReasoning['mode']>;
type RouteReasoningEffortControl =
  | ''
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';
type RoutePreserveControl = '' | 'on' | 'off';

const ROUTE_REASONING_MODES: Array<{ value: RouteReasoningModeControl; label: string }> = [
  { value: '', label: 'mode: inherit' },
  { value: 'auto', label: 'mode: auto' },
  { value: 'on', label: 'mode: on' },
  { value: 'off', label: 'mode: off' },
];

const ROUTE_REASONING_EFFORTS: Array<{ value: RouteReasoningEffortControl; label: string }> = [
  { value: '', label: 'effort: inherit' },
  { value: 'none', label: 'effort: none' },
  { value: 'minimal', label: 'effort: minimal' },
  { value: 'low', label: 'effort: low' },
  { value: 'medium', label: 'effort: medium' },
  { value: 'high', label: 'effort: high' },
  { value: 'xhigh', label: 'effort: xhigh' },
  { value: 'max', label: 'effort: max' },
];

const ROUTE_PRESERVE_OPTIONS: Array<{ value: RoutePreserveControl; label: string }> = [
  { value: '', label: 'preserve: inherit' },
  { value: 'on', label: 'preserve: on' },
  { value: 'off', label: 'preserve: off' },
];

const MODEL_MATRIX_KNOWN_ROUTE_SET = new Set(MODEL_MATRIX_KNOWN_ROUTES);

function buildRouteRuntime(
  mode: RouteReasoningModeControl,
  effort: RouteReasoningEffortControl,
  preserve: RoutePreserveControl,
): ModelRouteRuntime | undefined {
  const reasoning: ModelRouteReasoning = {};
  if (mode) reasoning.mode = mode;
  if (effort) reasoning.effort = effort;
  if (preserve) reasoning.preserve = preserve === 'on';
  return Object.keys(reasoning).length > 0 ? { reasoning } : undefined;
}

function routeRuntimeParts(reasoning: ModelRouteReasoning | undefined): string[] {
  if (!reasoning) return [];
  return [
    reasoning.mode ? `mode:${reasoning.mode}` : '',
    reasoning.effort ? `effort:${reasoning.effort}` : '',
    reasoning.preserve !== undefined ? `preserve:${reasoning.preserve ? 'on' : 'off'}` : '',
  ].filter(Boolean);
}

interface ModelCandidate {
  provider: string;
  model: string;
  label: string;
}

interface RoutingSectionProps {
  syncPref: (key: string, value: unknown) => void;
  /** Candidate models for the route target dropdown. */
  candidates?: ModelCandidate[] | undefined;
}

export function RoutingSection({ syncPref, candidates }: RoutingSectionProps) {
  const localPrefs = useLocalPrefs();
  const { t } = useAppTranslation();

  const [newRouteKey, setNewRouteKey] = useState(MODEL_MATRIX_DEFAULT_ROUTE);
  const [newRouteTarget, setNewRouteTarget] = useState('');
  const [newRouteReasoningMode, setNewRouteReasoningMode] = useState<RouteReasoningModeControl>('');
  const [newRouteReasoningEffort, setNewRouteReasoningEffort] =
    useState<RouteReasoningEffortControl>('');
  const [newRoutePreserve, setNewRoutePreserve] = useState<RoutePreserveControl>('');

  const setModelMatrix = useCallback(
    (next: typeof localPrefs.modelMatrix) => syncPref('modelMatrix', next),
    [syncPref],
  );

  const addModelRoute = useCallback(() => {
    const key = newRouteKey.trim();
    const target = newRouteTarget.trim();
    const runtime = buildRouteRuntime(
      newRouteReasoningMode,
      newRouteReasoningEffort,
      newRoutePreserve,
    );
    if (!key || (!target && !runtime)) return;
    const entry: ModelRouteEntry = target
      ? localPrefs.fallbackProfiles[target]
        ? { fallbackProfile: target }
        : target.includes('/')
          ? {
              provider: target.slice(0, target.indexOf('/')),
              model: target.slice(target.indexOf('/') + 1),
            }
          : { model: target }
      : {};
    const previousRuntime = localPrefs.modelMatrix[key]?.modelRuntime;
    if (runtime) entry.modelRuntime = runtime;
    else if (previousRuntime) entry.modelRuntime = previousRuntime;
    setModelMatrix({ ...localPrefs.modelMatrix, [key]: entry });
    setNewRouteTarget('');
    setNewRouteReasoningMode('');
    setNewRouteReasoningEffort('');
    setNewRoutePreserve('');
  }, [
    localPrefs.fallbackProfiles,
    localPrefs.modelMatrix,
    newRouteKey,
    newRoutePreserve,
    newRouteReasoningEffort,
    newRouteReasoningMode,
    newRouteTarget,
    setModelMatrix,
  ]);

  const removeModelRoute = useCallback(
    (key: string) => {
      const { [key]: _removed, ...rest } = localPrefs.modelMatrix;
      setModelMatrix(rest);
    },
    [localPrefs.modelMatrix, setModelMatrix],
  );

  const updateModelRouteReasoning = useCallback(
    (
      key: string,
      field: 'mode' | 'effort' | 'preserve',
      value: RouteReasoningModeControl | RouteReasoningEffortControl | RoutePreserveControl,
    ) => {
      const matrix = { ...localPrefs.modelMatrix };
      const entry = { ...(matrix[key] ?? {}) } as ModelRouteEntry;
      const modelRuntime = { ...(entry.modelRuntime ?? {}) } as ModelRouteRuntime;
      const reasoning = { ...(modelRuntime.reasoning ?? {}) } as ModelRouteReasoning;

      if (field === 'mode') {
        if (value) reasoning.mode = value as NonNullable<ModelRouteReasoning['mode']>;
        else delete reasoning.mode;
      } else if (field === 'effort') {
        if (value) reasoning.effort = value;
        else delete reasoning.effort;
      } else if (value) {
        reasoning.preserve = value === 'on';
      } else {
        delete reasoning.preserve;
      }

      if (Object.keys(reasoning).length > 0) modelRuntime.reasoning = reasoning;
      else delete modelRuntime.reasoning;

      if (Object.keys(modelRuntime).length > 0) entry.modelRuntime = modelRuntime;
      else delete entry.modelRuntime;

      if (entry.model || entry.fallbackProfile || entry.modelRuntime) matrix[key] = entry;
      else delete matrix[key];

      setModelMatrix(matrix);
    },
    [localPrefs.modelMatrix, setModelMatrix],
  );

  const formatRouteTarget = (entry: (typeof localPrefs.modelMatrix)[string]) => {
    const modelRef =
      entry.provider && entry.model ? `${entry.provider}/${entry.model}` : entry.model;
    const reasoning = entry.modelRuntime?.reasoning;
    return [
      modelRef ?? (!entry.fallbackProfile && reasoning ? t('settings:agent.leaderModel') : ''),
      entry.fallbackProfile ? `profile:${entry.fallbackProfile}` : '',
      ...routeRuntimeParts(reasoning),
    ]
      .filter(Boolean)
      .join(' + ');
  };

  const customModelRouteKeys = Array.from(
    new Set(
      [...Object.keys(localPrefs.modelMatrix), newRouteKey].filter(
        (key) => key && !MODEL_MATRIX_KNOWN_ROUTE_SET.has(key),
      ),
    ),
  ).sort((a, b) => a.localeCompare(b));

  return (
    <div className="pt-2 border-t">
      <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
        <Layers className="h-4 w-4 text-muted-foreground" />
        {t('settings:agent.routingHeading')}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,180px)_1fr_auto]">
        <select
          aria-label={t('settings:agent.routingRouteKey')}
          value={newRouteKey}
          onChange={(e) => setNewRouteKey(e.target.value)}
          className="h-9 min-w-0 rounded-md border bg-background px-3 font-mono text-sm"
        >
          <option value={MODEL_MATRIX_DEFAULT_ROUTE}>
            {formatModelMatrixRouteLabel(MODEL_MATRIX_DEFAULT_ROUTE)}
          </option>
          <optgroup label={t('settings:agent.routingPhasesGroup')}>
            {MODEL_MATRIX_ROUTE_GROUPS.map((group) => (
              <option key={group.phase} value={group.phase}>
                {formatModelMatrixRouteLabel(group.phase)}
              </option>
            ))}
          </optgroup>
          {MODEL_MATRIX_ROUTE_GROUPS.map((group) => (
            <optgroup
              key={group.phase}
              label={t('settings:agent.routingRolesGroup', { label: group.label })}
            >
              {group.roles.map((role) => (
                <option key={role.role} value={role.role}>
                  {formatModelMatrixRouteLabel(role.role)}
                </option>
              ))}
            </optgroup>
          ))}
          {customModelRouteKeys.length > 0 ? (
            <optgroup label={t('settings:agent.routingCustomGroup')}>
              {customModelRouteKeys.map((key) => (
                <option key={key} value={key}>
                  {formatModelMatrixRouteLabel(key)}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <select
          aria-label={t('settings:agent.routingTargetAria')}
          value={newRouteTarget}
          onChange={(e) => setNewRouteTarget(e.target.value)}
          className="h-9 min-w-0 rounded-md border bg-background px-3 font-mono text-sm"
        >
          <option value="">{t('settings:agent.routingTargetEmpty')}</option>
          {Object.keys(localPrefs.fallbackProfiles).length > 0 && (
            <optgroup label={t('settings:agent.routingTargetProfilesGroup')}>
              {Object.keys(localPrefs.fallbackProfiles).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </optgroup>
          )}
          {candidates && candidates.length > 0 && (
            <optgroup label={t('settings:agent.routingTargetModelsGroup')}>
              {candidates.map((c) => (
                <option key={`${c.provider}/${c.model}`} value={`${c.provider}/${c.model}`}>
                  {c.provider}/{c.model}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <Button type="button" variant="outline" onClick={addModelRoute}>
          {t('settings:agent.routingSet')}
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select
          aria-label={t('settings:agent.routingReasoningModeAria')}
          value={newRouteReasoningMode}
          onChange={(e) => setNewRouteReasoningMode(e.target.value as RouteReasoningModeControl)}
          className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
        >
          {ROUTE_REASONING_MODES.map((opt) => (
            <option key={opt.value || 'inherit'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          aria-label={t('settings:agent.routingReasoningEffortAria')}
          value={newRouteReasoningEffort}
          onChange={(e) =>
            setNewRouteReasoningEffort(e.target.value as RouteReasoningEffortControl)
          }
          className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
        >
          {ROUTE_REASONING_EFFORTS.map((opt) => (
            <option key={opt.value || 'inherit'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <select
          aria-label={t('settings:agent.routingReasoningPreserveAria')}
          value={newRoutePreserve}
          onChange={(e) => setNewRoutePreserve(e.target.value as RoutePreserveControl)}
          className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
        >
          {ROUTE_PRESERVE_OPTIONS.map((opt) => (
            <option key={opt.value || 'inherit'} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>
      <div className="mt-3 space-y-1.5">
        {Object.keys(localPrefs.modelMatrix).length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('settings:agent.noRoutes')}</p>
        ) : (
          Object.entries(localPrefs.modelMatrix)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => (
              <div
                key={key}
                className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-40 shrink-0 break-words font-mono text-muted-foreground"
                    title={key}
                  >
                    {formatModelMatrixRouteLabel(key)}
                  </span>
                  <span className="min-w-0 flex-1 break-words font-mono">
                    {formatRouteTarget(entry)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeModelRoute(key)}
                  >
                    {t('common:action.remove')}
                  </Button>
                </div>
                <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <select
                    aria-label={t('settings:agent.routingReasoningModeFor', { key })}
                    value={entry.modelRuntime?.reasoning?.mode ?? ''}
                    onChange={(e) =>
                      updateModelRouteReasoning(
                        key,
                        'mode',
                        e.target.value as RouteReasoningModeControl,
                      )
                    }
                    className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                  >
                    {ROUTE_REASONING_MODES.map((opt) => (
                      <option key={opt.value || 'inherit'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('settings:agent.routingReasoningEffortFor', { key })}
                    value={entry.modelRuntime?.reasoning?.effort ?? ''}
                    onChange={(e) =>
                      updateModelRouteReasoning(
                        key,
                        'effort',
                        e.target.value as RouteReasoningEffortControl,
                      )
                    }
                    className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                  >
                    {ROUTE_REASONING_EFFORTS.map((opt) => (
                      <option key={opt.value || 'inherit'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={t('settings:agent.routingReasoningPreserveFor', { key })}
                    value={
                      entry.modelRuntime?.reasoning?.preserve === undefined
                        ? ''
                        : entry.modelRuntime.reasoning.preserve
                          ? 'on'
                          : 'off'
                    }
                    onChange={(e) =>
                      updateModelRouteReasoning(
                        key,
                        'preserve',
                        e.target.value as RoutePreserveControl,
                      )
                    }
                    className="h-8 min-w-0 rounded-md border bg-background px-2 text-xs"
                  >
                    {ROUTE_PRESERVE_OPTIONS.map((opt) => (
                      <option key={opt.value || 'inherit'} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ))
        )}
      </div>
    </div>
  );
}
