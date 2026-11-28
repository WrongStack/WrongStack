import type { AcpRuntimeValues } from '@wrongstack/contracts/types/acp-runtime';
import { useRef } from 'react';
import { useAppTranslation } from '../lib/i18n';
import {
  type AcpModeRequest,
  type AcpRuntimeRequest,
  isEffortOption,
  useAcpRuntime,
} from './use-acp-runtime';

export type { AcpModeRequest, AcpRuntimeRequest } from './use-acp-runtime';

/** Options come from a private agent session. Saving configures the next turn/spawn. */
export function AcpRuntimeControls({
  agentId,
  values = {},
  request,
  modeRequest,
  onChange,
  disabled = false,
}: {
  agentId: string;
  values?: AcpRuntimeValues | undefined;
  request: AcpRuntimeRequest;
  modeRequest?: AcpModeRequest | undefined;
  onChange: (values: AcpRuntimeValues) => void | Promise<void>;
  disabled?: boolean | undefined;
}) {
  const { t } = useAppTranslation();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const {
    result,
    modeSelectors,
    modeBusy,
    busy,
    saving,
    pendingValues,
    error,
    summary,
    load,
    loadModes,
    applySelection,
  } = useAcpRuntime({ agentId, values, request, modeRequest, onChange });

  return (
    <details
      ref={detailsRef}
      className="acp-runtime-controls min-w-0 max-w-full rounded-md border border-border/60 bg-card/60 px-2.5 py-1.5 text-xs"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && detailsRef.current?.open) {
          event.stopPropagation();
          detailsRef.current.open = false;
        }
      }}
      onToggle={(event) => {
        if (event.currentTarget.open && !result && !busy) {
          void load(values, false);
          void loadModes();
        }
      }}
    >
      <summary className="cursor-pointer select-none">
        <span>{t('activity:acp.runtimeTitle', { defaultValue: 'ACP · Model / effort' })}</span>
        {summary && <span className="opacity-80"> · {summary}</span>}
      </summary>
      <div className="grid min-w-0 gap-2.5 pt-2">
        <small className="text-muted-foreground">
          {t('activity:acp.runtimeHint', {
            defaultValue: 'Applies on the next turn or subagent start.',
          })}
        </small>
        {busy && (
          <span role="status" className="text-muted-foreground">
            {saving
              ? t('activity:acp.runtimeSaving', { defaultValue: 'Applying agent settings…' })
              : t('activity:acp.runtimeLoading', { defaultValue: 'Reading agent settings…' })}
          </span>
        )}
        {result?.options.map((option) => {
          const selectedValue = pendingValues?.[option.id] ?? option.currentValue;
          const showEffortPills =
            isEffortOption(option) && option.options.length >= 2 && option.options.length <= 6;
          return (
            <div key={option.id} className="grid min-w-0 gap-1">
              <label className="grid min-w-0 gap-1" title={option.description}>
                <span className="font-medium text-foreground/90">{option.name}</span>
                <select
                  className="w-full min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                  aria-label={`ACP ${option.name}`}
                  disabled={disabled || busy}
                  value={selectedValue}
                  onChange={(event) => applySelection(option, event.target.value)}
                >
                  {!option.options.some((x) => x.value === selectedValue) && (
                    <option className="bg-background text-foreground" value={selectedValue}>
                      {selectedValue}
                    </option>
                  )}
                  {option.options.map((x) => (
                    <option key={x.value} className="bg-background text-foreground" value={x.value}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              {showEffortPills && (
                <fieldset
                  className="acp-effort-pills m-0 flex flex-wrap gap-1 border-0 p-0 pt-0.5"
                  aria-label={`${option.name} quick select`}
                >
                  {option.options.map((choice) => {
                    const active = choice.value === selectedValue;
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        aria-pressed={active}
                        disabled={disabled || busy}
                        className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
                          active
                            ? 'border-primary bg-primary/15 font-medium text-foreground'
                            : 'border-border/60 bg-transparent text-muted-foreground hover:border-border hover:text-foreground'
                        }`}
                        onClick={() => {
                          if (choice.value !== selectedValue) applySelection(option, choice.value);
                        }}
                      >
                        {choice.name}
                      </button>
                    );
                  })}
                </fieldset>
              )}
              {option.description && (
                <small className="acp-option-desc text-[11px] text-muted-foreground">
                  {option.description}
                </small>
              )}
            </div>
          );
        })}
        {result && !result.options.length && (
          <span className="text-muted-foreground">
            {t('activity:acp.runtimeUnsupported', {
              defaultValue: 'This agent does not expose model or effort settings through ACP.',
            })}
          </span>
        )}
        {result?.capabilities && Object.values(result.capabilities).some(Boolean) && (
          <div className="flex flex-wrap gap-1 pt-0.5 text-[10px] text-muted-foreground">
            {result.capabilities.image && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Vision</span>
            )}
            {result.capabilities.audio && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Audio</span>
            )}
            {result.capabilities.embeddedContext && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Context</span>
            )}
            {result.capabilities.resume && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Resume</span>
            )}
            {result.capabilities.fork && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Fork</span>
            )}
            {result.capabilities.steering && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Steer</span>
            )}
            {result.capabilities.additionalDirectories && (
              <span className="rounded border border-border/50 px-1.5 py-0.5">Multi-dir</span>
            )}
          </div>
        )}
        {modeSelectors && modeSelectors.length > 0 ? (
          <div className="grid min-w-0 gap-2">
            {modeSelectors.map((selector) => {
              const selectable = new Set(selector.selectableValues);
              return (
                <label
                  key={selector.id}
                  className="grid min-w-0 gap-1"
                  title={selector.description}
                >
                  <span className="font-medium text-foreground/90">
                    {t('activity:acp.modeLabel', {
                      defaultValue: 'ACP {{name}}',
                      name: selector.name,
                    })}
                  </span>
                  <select
                    className="w-full min-w-0 max-w-full rounded border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
                    aria-label={`ACP ${selector.name}`}
                    disabled={disabled || busy || modeBusy || selectable.size === 0}
                    value={selector.currentValue}
                    onChange={(event) =>
                      void loadModes({ optionId: selector.id, value: event.target.value })
                    }
                  >
                    {!selector.options.some((x) => x.value === selector.currentValue) && (
                      <option
                        className="bg-background text-foreground"
                        value={selector.currentValue}
                      >
                        {selector.currentValue}
                      </option>
                    )}
                    {selector.options.map((x) => (
                      <option
                        key={x.value}
                        className="bg-background text-foreground"
                        value={x.value}
                        disabled={!selectable.has(x.value)}
                      >
                        {x.name}
                        {!selectable.has(x.value) ? ' (managed)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        ) : (
          result?.modes &&
          result.modes.length > 0 && (
            <div className="grid gap-1 text-[11px] text-muted-foreground">
              <span>
                Modes:{' '}
                {result.modes
                  .map((m) => (m.id === result.currentModeId ? `${m.name} (active)` : m.name))
                  .join(' · ')}
              </span>
            </div>
          )
        )}
        {result?.commands && result.commands.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <span>Commands:</span>
            {result.commands.slice(0, 12).map((cmd) => (
              <code
                key={cmd.name}
                title={cmd.description}
                className="rounded border border-border/50 px-1 py-0.5 font-mono text-[10px]"
              >
                /{cmd.name.replace(/^\//, '')}
              </code>
            ))}
          </div>
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-50"
            disabled={busy || disabled}
            onClick={() => void load(values, false)}
          >
            {t('activity:acp.runtimeRefresh', { defaultValue: 'Refresh' })}
          </button>
          <button
            type="button"
            className="rounded border border-border/60 px-2 py-1 text-xs hover:bg-accent/50 disabled:opacity-50"
            disabled={busy || disabled || !Object.keys(values).length}
            onClick={() => void load({}, true)}
          >
            {t('activity:acp.runtimeDefaults', { defaultValue: 'Use defaults' })}
          </button>
        </div>
      </div>
    </details>
  );
}
