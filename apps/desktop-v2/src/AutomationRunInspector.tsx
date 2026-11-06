import type {
  AutomationRunRecord,
  AutomationValidation,
  EnvironmentReceipt,
} from '@wrongstack/webui-protocol';
import { Copy, RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { AutomationPublication } from './AutomationPublication';
import {
  type AutomationArtifact as Artifact,
  AUTOMATION_ARTIFACTS as artifacts,
  parseAutomationEnvironmentReceipt,
  parseAutomationVerification,
} from './automation-evidence';
import { useDesktopText } from './desktop-i18n';
import { displayDateTime } from './display-dates';
import type { EngineHttp } from './engine-http';
import { record } from './engine-values';
import { MarkdownContent } from './MarkdownContent';
import { Modal } from './Modal';

export function AutomationRunInspector({
  run,
  http,
  onClose,
}: {
  run: AutomationRunRecord;
  http: EngineHttp;
  onClose: () => void;
}) {
  const { t } = useDesktopText();
  const label = (name: Artifact) => t(`autoRun.artifact.${artifacts[name]}`);
  const [artifact, setArtifact] = useState<{ name: Artifact; text: string } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const alive = useRef(true),
    sequence = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
    };
  }, []);
  const read = async (name: Artifact) => {
    const version = ++sequence.current;
    setBusy(true);
    setArtifact(null);
    setError('');
    setNotice('');
    try {
      const value = await http(
        `/api/automation/runs/${run.id}/artifact?name=${encodeURIComponent(name)}`,
      );
      if (alive.current && version === sequence.current)
        setArtifact({ name, text: String(record(value)['content'] ?? '') });
    } catch (error) {
      if (alive.current && version === sequence.current) {
        const message = error instanceof Error ? error.message : String(error);
        setError(
          /ENOENT|no such file or directory/i.test(message)
            ? t('autoRun.notRecordedEvidence')
            : message,
        );
      }
    } finally {
      if (alive.current && version === sequence.current) setBusy(false);
    }
  };
  const result = run.result;
  return (
    <Modal title={t('autoRun.title', { id: run.id })} onClose={onClose}>
      <div className="automation-run-inspector">
        <header>
          <div>
            <span className="eyebrow">{t('autoRun.eyebrow', { id: run.id.slice(0, 8) })}</span>
            <h2>{t('autoRun.heading')}</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label={t('autoRun.close')}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="automation-run-status">
          <strong>{t(`automation.runStatus.${run.status}`, { defaultValue: run.status })}</strong>
          <span>{t(`automation.trigger.${run.trigger}`, { defaultValue: run.trigger })}</span>
          <span>{displayDateTime(run.createdAt)}</span>
        </div>
        {run.error && <p className="session-error">{run.error}</p>}
        {run.exitCode !== undefined && <p>{t('autoRun.exitCode', { code: run.exitCode })}</p>}
        {result ? (
          <>
            <div className="automation-run-metrics">
              <div>
                <small>{t('autoRun.duration')}</small>
                <strong>{(result.durationMs / 1000).toFixed(1)} s</strong>
              </div>
              <div>
                <small>{t('autoRun.tokens')}</small>
                <strong>
                  {result.usage.inputTokens ?? t('autoRun.unknown')} /{' '}
                  {result.usage.outputTokens ?? t('autoRun.unknown')}
                </strong>
              </div>
              <div>
                <small>{t('autoRun.iterations')}</small>
                <strong>{result.usage.iterations ?? t('autoRun.unknown')}</strong>
              </div>
              <div>
                <small>
                  {result.usage.costSource === 'catalog-estimate'
                    ? t('autoRun.costEstimate')
                    : t('autoRun.cost')}
                </small>
                <strong>
                  {result.usage.costUsd === null
                    ? t('autoRun.unknown')
                    : `$${result.usage.costUsd.toFixed(4)}`}
                </strong>
              </div>
            </div>
            <section>
              <h3>{t('autoRun.agentResult')}</h3>
              <p>
                {t('autoRun.agentStatus', {
                  status: result.agentStatus ?? t('autoRun.notRecorded'),
                })}
              </p>
              <MarkdownContent text={result.finalText || t('autoRun.noFinal')} />
            </section>
            <VerificationReport value={result.validation} />
            <section>
              <h3>
                {result.changedFilesTruncated
                  ? t('autoRun.changedFirst')
                  : t('autoRun.changedFiles')}
              </h3>
              {result.changedFiles.length ? (
                <ul>
                  {result.changedFiles.map((path) => (
                    <li key={path}>
                      <code>{path}</code>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t('autoRun.noChanges')}</p>
              )}
            </section>
          </>
        ) : (
          <p className="quiet-state">{t('autoRun.noResult')}</p>
        )}
        <section>
          <h3>{t('autoRun.evidence')}</h3>
          <div className="feature-actions">
            {(Object.keys(artifacts) as Artifact[]).map((name) => (
              <button
                type="button"
                key={name}
                className="button secondary"
                disabled={busy}
                onClick={() => void read(name)}
              >
                {label(name)}
              </button>
            ))}
          </div>
          <p>{t('autoRun.evidenceHelp')}</p>
          {error && (
            <p className="session-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {busy && <p role="status">{t('autoRun.reading')}</p>}
          {artifact && (
            <section className="automation-recorded-artifact" aria-label={label(artifact.name)}>
              <header>
                <h3>{label(artifact.name)}</h3>
                <div className="feature-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void read(artifact.name)}
                  >
                    <RefreshCw size={13} />
                    {t('autoRun.refreshEvidence')}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(artifact.text)
                        .then(() => setNotice(t('autoRun.copied')))
                        .catch((error) => setError(String(error)))
                    }
                  >
                    <Copy size={13} />
                    {t('autoRun.copy')}
                  </button>
                </div>
              </header>
              <ArtifactContent name={artifact.name} text={artifact.text} />
            </section>
          )}
        </section>
        <AutomationPublication run={run} http={http} />
      </div>
    </Modal>
  );
}

function ArtifactContent({ name, text }: { name: Artifact; text: string }) {
  const { t } = useDesktopText();
  if (!text) return <p>{t('autoRun.noContent')}</p>;
  const kind = artifacts[name];
  if (kind === 'verificationJson' || kind === 'environmentJson') {
    try {
      if (kind === 'verificationJson') {
        return <VerificationReport value={parseAutomationVerification(text)} />;
      }
      return <EnvironmentReport value={parseAutomationEnvironmentReceipt(text)} />;
    } catch (error) {
      return (
        <p role="alert" className="session-error">
          {t('autoRun.unreadable', { error: String(error) })}
        </p>
      );
    }
  }
  if (kind === 'changesPatch')
    return (
      <pre className="automation-patch">
        {text.split('\n').map((line, index) => (
          <span
            key={index}
            className={
              line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')
                ? 'patch-file'
                : line.startsWith('+')
                  ? 'patch-add'
                  : line.startsWith('-')
                    ? 'patch-remove'
                    : line.startsWith('@@')
                      ? 'patch-hunk'
                      : ''
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
    );
  return <pre className="automation-run-log">{text}</pre>;
}

function VerificationReport({ value }: { value: AutomationValidation }) {
  const { t } = useDesktopText();
  return (
    <section className="automation-verification-report">
      <h3>
        {t('autoRun.checks', {
          status: t(`autoRun.verify.${value.status}`, { defaultValue: value.status }),
        })}
      </h3>
      <p>
        {value.reason ||
          (value.status === 'not-verified'
            ? t('autoRun.noCheckEvidence')
            : t('autoRun.hostStatus'))}
      </p>
      {value.evidence.length > 0 && (
        <p>{t('autoRun.evidenceList', { list: value.evidence.join(', ') })}</p>
      )}
      {value.checks?.length ? (
        <div className="automation-check-list">
          {value.checks.map((check, index) => (
            <article key={index}>
              <strong>{check.argv.join(' ')}</strong>
              <span>{t('autoRun.exit', { code: check.exitCode, ms: check.durationMs })}</span>
              <small>
                {check.binding?.checkId} · {check.binding?.evidenceKind}
              </small>
              <details>
                <summary>{t('autoRun.identity')}</summary>
                <dl>
                  <dt>{t('autoRun.outputSha')}</dt>
                  <dd>
                    <code>{check.outputSha256}</code>
                  </dd>
                  <dt>{t('autoRun.handler')}</dt>
                  <dd>{check.binding?.handlerVersion}</dd>
                  <dt>{t('autoRun.registry')}</dt>
                  <dd>
                    <code>{check.binding?.registryFingerprint}</code>
                  </dd>
                </dl>
              </details>
            </article>
          ))}
        </div>
      ) : null}
      {(value.imageId || value.workspaceTree || value.planFingerprint) && (
        <details>
          <summary>{t('autoRun.workspaceIdentity')}</summary>
          <dl>
            <dt>{t('autoRun.image')}</dt>
            <dd>{codeOr(value.imageId, t('autoRun.notRecorded'))}</dd>
            <dt>{t('autoRun.tree')}</dt>
            <dd>{codeOr(value.workspaceTree, t('autoRun.notRecorded'))}</dd>
            <dt>{t('autoRun.planFingerprint')}</dt>
            <dd>{codeOr(value.planFingerprint, t('autoRun.notRecorded'))}</dd>
          </dl>
        </details>
      )}
    </section>
  );
}

/** A recorded identifier in code type; a placeholder for a missing one stays plain text. */
const codeOr = (value: string | null | undefined, missing: string) =>
  value ? <code>{value}</code> : missing;

function EnvironmentReport({ value }: { value: EnvironmentReceipt }) {
  const { t } = useDesktopText();
  return (
    <section className="automation-environment-report">
      <h3>
        {value.name} ·{' '}
        {t(
          value.phase === 'candidate'
            ? 'autoRun.envPhaseCandidate'
            : 'autoRun.envPhaseVerification',
        )}
      </h3>
      <p>
        {t('autoRun.environmentStatus', {
          status: t(`autoRun.envStatus.${value.status}`, { defaultValue: value.status }),
        })}
        {value.failure ? ` · ${value.failure}` : ''}
      </p>
      <dl>
        <dt>{t('autoRun.workspaceImage')}</dt>
        <dd>{codeOr(value.imageId, t('autoRun.notCaptured'))}</dd>
        <dt>{t('autoRun.network')}</dt>
        <dd>{value.network ?? t('autoRun.noneRecorded')}</dd>
        <dt>{t('autoRun.fingerprint')}</dt>
        <dd>
          <code>{value.fingerprint}</code>
        </dd>
      </dl>
      <h4>{t('autoRun.services')}</h4>
      {value.services.length ? (
        value.services.map((service) => (
          <p key={service.name}>
            <strong>{service.name}</strong> · <code>{service.imageId}</code> ·{' '}
            {t('autoRun.container')} <code>{service.containerId}</code>
          </p>
        ))
      ) : (
        <p>{t('autoRun.noServices')}</p>
      )}
      <h4>{t('autoRun.caches')}</h4>
      {value.caches.length ? (
        value.caches.map((cache) => (
          <p key={cache.name}>
            {cache.name} · <code>{cache.target}</code> ·{' '}
            {cache.persistent ? t('autoRun.persistent') : t('autoRun.ephemeral')}
            {cache.volume ? ` · ${cache.volume}` : ''}
          </p>
        ))
      ) : (
        <p>{t('autoRun.noCaches')}</p>
      )}
      <h4>{t('autoRun.localPorts')}</h4>
      {value.ports.length ? (
        value.ports.map((port) => (
          <p key={port.name}>
            {t('autoRun.portLine', {
              name: port.name,
              port: port.port,
              host: port.hostPort,
              protocol: port.protocol,
            })}
          </p>
        ))
      ) : (
        <p>{t('autoRun.noPorts')}</p>
      )}
      <h4>{t('autoRun.setupSteps')}</h4>
      {value.setup.length ? (
        value.setup.map((step, index) => (
          <details key={index}>
            <summary>
              {t('autoRun.stepLine', {
                command: step.argv.join(' '),
                code: step.exitCode,
                ms: step.durationMs,
              })}
            </summary>
            <p>
              {t('autoRun.outputSha')}: <code>{step.outputSha256}</code>
            </p>
            <pre className="automation-run-log">{step.output}</pre>
          </details>
        ))
      ) : (
        <p>{t('autoRun.noSetup')}</p>
      )}
    </section>
  );
}
