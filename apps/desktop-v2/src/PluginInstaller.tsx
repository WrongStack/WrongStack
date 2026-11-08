import { Download, ListChecks, Puzzle, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { runEngineText } from './engine-command-run';
import type { EngineCommand } from './engine-operations';
import { pluginSpec } from './plugin-installer-model';
import './plugin-installer.css';

/**
 * Adds a plugin to the profile or removes one, through the engine's `/plugin` command, which
 * writes the profile config (with a backup first) and applies the change to the running
 * engine. It never runs a package manager: installing by name only registers the plugin.
 * Plugin code loads when the engine starts, so the command's own message says when a restart
 * is needed; it is shown as it came.
 */
export function PluginInstaller({ command }: { command: EngineCommand }) {
  const { t } = useDesktopText();
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const run = async (args: string) => {
    setBusy(true);
    setError('');
    const outcome = await runEngineText(command, 'plugin', args);
    setBusy(false);
    if (outcome.error) {
      setOutput('');
      setError(outcome.error);
    } else setOutput(outcome.text);
  };
  const named = pluginSpec(spec);
  const act = (verb: 'install' | 'remove') => {
    if (!named) return setError(t('pluginInstaller.specInvalid'));
    void run(`${verb} ${named}`);
  };
  return (
    <section className="plugin-installer" aria-label={t('pluginInstaller.title')}>
      <h3>
        <Puzzle size={15} /> {t('pluginInstaller.title')}
      </h3>
      <p className="field-help">{t('pluginInstaller.intro')}</p>
      <div className="plugin-installer-row">
        <input
          type="text"
          value={spec}
          placeholder={t('pluginInstaller.placeholder')}
          aria-label={t('pluginInstaller.placeholder')}
          onChange={(event) => setSpec(event.target.value)}
        />
        <button
          type="button"
          className="button primary"
          disabled={busy}
          onClick={() => act('install')}
        >
          <Download size={14} /> {t('pluginInstaller.install')}
        </button>
        <button type="button" className="button" disabled={busy} onClick={() => act('remove')}>
          <Trash2 size={14} /> {t('pluginInstaller.remove')}
        </button>
      </div>
      <div className="plugin-installer-row">
        <button type="button" className="button" disabled={busy} onClick={() => void run('list')}>
          <ListChecks size={14} /> {t('pluginInstaller.showConfigured')}
        </button>
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void run('official')}
        >
          {t('pluginInstaller.showOfficial')}
        </button>
      </div>
      {busy && <p className="field-help">{t('pluginInstaller.working')}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {output && <pre className="plugin-installer-output">{output}</pre>}
    </section>
  );
}
