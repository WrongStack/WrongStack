/**
 * RequirementIntakeView — list project requirement intake records and file a
 * new one. Talks to the WebUI server's requirement-intake REST API:
 *   GET  /api/requirement-intakes                     (server-resolved list)
 *   POST /api/projects/:projectId/requirement-intakes (create draft)
 *   POST /api/requirement-intakes/:id/submit          (submit)
 * The submitted text is preserved verbatim as the record's original request.
 */
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';

interface IntakeRecord {
  id: string;
  title: string;
  requestType: string;
  status: string;
  priority: string;
  isVibeMode?: boolean;
  updatedAt: number;
  createdAt: number;
}

interface IntakeListResponse {
  projectId: string;
  intakes: IntakeRecord[];
}

const REQUEST_TYPES = [
  'feature',
  'bug_fix',
  'refactor',
  'performance',
  'security',
  'ui_change',
  'api_change',
  'infrastructure',
  'migration',
  'testing',
  'documentation',
  'maintenance',
  'other',
  'unspecified',
] as const;

const PRIORITIES = ['unspecified', 'low', 'medium', 'high', 'critical'] as const;

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  collecting_information: 'bg-warning/15 text-warning',
  submitted: 'bg-success/15 text-success',
  cancelled: 'bg-destructive/15 text-destructive',
  archived: 'bg-muted text-muted-foreground',
};

function relativeTime(timestamp: number): string {
  const elapsedMs = Date.now() - timestamp;
  if (elapsedMs < 60_000) return 'just now';
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function RequirementIntakeView(): React.ReactElement {
  const { t } = useAppTranslation();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [intakes, setIntakes] = useState<IntakeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [request, setRequest] = useState('');
  const [title, setTitle] = useState('');
  const [requestType, setRequestType] = useState<string>('unspecified');
  const [priority, setPriority] = useState<string>('unspecified');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formNotice, setFormNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/requirement-intakes');
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `List failed (HTTP ${res.status})`);
      }
      const data = (await res.json()) as IntakeListResponse;
      setProjectId(data.projectId);
      setIntakes(data.intakes);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const submit = useCallback(async () => {
    const text = request.trim();
    if (!text) {
      setFormError('Describe the request first — it is preserved verbatim.');
      return;
    }
    if (!projectId) {
      setFormError('No project identity available yet.');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    setFormNotice(null);
    try {
      const createRes = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/requirement-intakes`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // The schema (createIntakeSchema) requires projectId + requestedBy.
            // projectId is the panel-resolved one returned by the list endpoint;
            // requestedBy uses the same 'webui' sentinel the server applies for
            // its own actor (matches the techstack-create precedent). When a
            // user-identity surface exists, this becomes ctx.userId.
            projectId,
            requestedBy: 'webui',
            originalRequest: text,
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(requestType !== 'unspecified' ? { requestType } : {}),
            ...(priority !== 'unspecified' ? { priority } : {}),
          }),
        },
      );
      const createBody = (await createRes.json().catch(() => null)) as {
        record?: IntakeRecord;
        error?: { message?: string };
      } | null;
      if (!createRes.ok || !createBody?.record) {
        throw new Error(createBody?.error?.message ?? `Create failed (HTTP ${createRes.status})`);
      }
      const submitRes = await fetch(`/api/requirement-intakes/${createBody.record.id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!submitRes.ok) {
        const submitBody = (await submitRes.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(submitBody?.error?.message ?? `Submit failed (HTTP ${submitRes.status})`);
      }
      setFormNotice(`Intake recorded and submitted (${createBody.record.id}).`);
      setRequest('');
      setTitle('');
      setRequestType('unspecified');
      setPriority('unspecified');
      await load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [request, title, requestType, priority, projectId, load]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="border-b border-border/70 px-5 py-3">
        <div className="text-sm font-semibold text-foreground">
          {t('activity:reqIntake.requirementsIntake')}
        </div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">
          {t('activity:reqIntake.collectAndPreserveSoftwareDevelopmentRequests')}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
        {error ? (
          <div
            role="alert"
            className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
            <button
              type="button"
              className="ml-2 underline underline-offset-2"
              onClick={() => void load()}
            >
              {t('activity:reqIntake.retry')}
            </button>
          </div>
        ) : null}

        {/* Create form */}
        <section
          aria-label={t('activity:reqIntake.fileANewIntake')}
          className="mb-6 rounded-lg border border-border/70 bg-card/60 p-4"
        >
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {t('activity:reqIntake.fileANewRequest')}
          </div>
          <div className="space-y-3">
            <div>
              <label htmlFor="intake-request" className="mb-1 block text-xs text-foreground">
                {t('activity:reqIntake.requestText')} <span className="text-destructive">*</span>
              </label>
              <textarea
                id="intake-request"
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                placeholder={t('activity:reqIntake.describeTheFeatureBugFixRefactorOrChange')}
                rows={4}
                className={cn(
                  'w-full resize-y rounded-md border border-border/70 bg-background px-3 py-2',
                  'text-sm text-foreground placeholder:text-muted-foreground/70',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                )}
              />
              {/\[VIBE\]/i.test(request) ? (
                <div className="mt-1.5 flex items-center gap-1.5 rounded bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
                  <span>🌊</span>
                  <span>
                    <strong>VIBE Protocol Detected:</strong> Three-Stage Verification
                    (Spec-Synthesizer → Coder → Auditor) is active.
                  </span>
                </div>
              ) : null}
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t('activity:reqIntake.storedVerbatimAsTheRecordApos')}
              </p>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="intake-title" className="mb-1 block text-xs text-foreground">
                  {t('activity:reqIntake.titleOptional')}
                </label>
                <Input
                  id="intake-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder={t('activity:reqIntake.shortDisplayTitle')}
                />
              </div>
              <div>
                <label htmlFor="intake-type" className="mb-1 block text-xs text-foreground">
                  {t('activity:reqIntake.type')}
                </label>
                <select
                  id="intake-type"
                  value={requestType}
                  onChange={(event) => setRequestType(event.target.value)}
                  className={cn(
                    'w-full rounded-md border border-border/70 bg-background px-2 py-2',
                    'text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring',
                  )}
                >
                  {REQUEST_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="intake-priority" className="mb-1 block text-xs text-foreground">
                  {t('activity:reqIntake.priority')}
                </label>
                <select
                  id="intake-priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value)}
                  className={cn(
                    'w-full rounded-md border border-border/70 bg-background px-2 py-2',
                    'text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring',
                  )}
                >
                  {PRIORITIES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {formError ? (
              <div
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {formError}
              </div>
            ) : null}
            {formNotice ? (
              <div
                role="status"
                className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-xs text-success"
              >
                {formNotice}
              </div>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={submitting}
                onClick={() => {
                  setRequest('');
                  setFormError(null);
                  setFormNotice(null);
                }}
              >
                {t('activity:reqIntake.clear')}
              </Button>
              <Button
                size="sm"
                disabled={submitting || !request.trim()}
                onClick={() => void submit()}
              >
                {submitting ? 'Filing…' : 'File + submit'}
              </Button>
            </div>
          </div>
        </section>

        {/* List */}
        <section aria-label={t('activity:reqIntake.intakeRecords')} className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('activity:reqIntake.records')}
            </div>
            <div className="text-[11px] text-muted-foreground">{intakes.length} total</div>
          </div>
          {loading ? (
            <div className="py-8 text-center text-xs text-muted-foreground">
              {t('activity:reqIntake.loading')}
            </div>
          ) : intakes.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 py-10 text-center text-xs text-muted-foreground">
              {t('activity:reqIntake.noIntakeRecordsYetFileThe')}
            </div>
          ) : (
            <ul className="space-y-2">
              {intakes.map((intake) => (
                <li key={intake.id} className="rounded-md border border-border/70 bg-card/60 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div
                        className="truncate text-sm font-medium text-foreground"
                        title={intake.title}
                      >
                        {intake.title}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                        {intake.id}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {intake.isVibeMode ? (
                        <Badge
                          variant="outline"
                          className="border-primary/40 bg-primary/10 text-[10px] text-primary"
                        >
                          🌊 VIBE
                        </Badge>
                      ) : null}
                      <Badge variant="secondary" className="text-[10px]">
                        {intake.requestType}
                      </Badge>
                      <Badge
                        className={cn(
                          'text-[10px]',
                          STATUS_STYLE[intake.status] ?? 'bg-muted text-muted-foreground',
                        )}
                      >
                        {intake.status}
                      </Badge>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[11px] text-muted-foreground">
                    {intake.priority} · updated {relativeTime(intake.updatedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
