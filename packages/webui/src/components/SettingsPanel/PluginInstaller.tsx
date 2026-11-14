import { Download, ListChecks, PackagePlus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { invokePortableCommand } from '@/lib/portable-command-rpc';

/** A plugin an engine command can name: an official alias or a package name, never an option. */
const PLUGIN_SPEC = /^[@A-Za-z0-9][A-Za-z0-9@._/-]*$/;

/**
 * The plugin a field names, or undefined when it is not one. An option such as `--install`
 * would make `/plugin install` run a package manager, so a spec never starts with a dash and
 * never holds a space. The desktop's installer (`plugin-installer-model.ts`) checks the same.
 */
export function pluginSpec(input: string): string | undefined {
  const spec = input.trim();
  return PLUGIN_SPEC.test(spec) ? spec : undefined;
}

/**
 * Adds a plugin to the profile or removes one through the engine's `/plugin` command, which
 * writes the profile config (backing it up first) and applies the change to the running
 * engine. It never runs a package manager: installing by name only registers the plugin.
 * Plugin code loads when the engine starts; the command's own message says when a restart is
 * needed and is shown as it came.
 */
export function PluginInstaller() {
  const { t } = useAppTranslation();
  const [spec, setSpec] = useState('');
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const run = async (args: string) => {
    setBusy(true);
    setError('');
    const result = await invokePortableCommand('plugin', args, { timeoutMs: 20_000 });
    setBusy(false);
    if (result.error) {
      setOutput('');
      setError(result.error);
    } else setOutput(result.message ?? result.runText ?? '');
  };
  const act = (verb: 'install' | 'remove') => {
    const named = pluginSpec(spec);
    if (!named) {
      setError(t('settings:context.pluginInstaller.specInvalid'));
      return;
    }
    void run(`${verb} ${named}`);
  };
  const button =
    'inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-sm disabled:opacity-50';
  return (
    <section className="pt-2 border-t" aria-label={t('settings:context.pluginInstaller.title')}>
      <h3 className="text-sm font-semibold mb-3 mt-3 flex items-center gap-2">
        <PackagePlus className="h-4 w-4 text-muted-foreground" />
        {t('settings:context.pluginInstaller.title')}
      </h3>
      <p className="text-xs text-muted-foreground mb-2">
        {t('settings:context.pluginInstaller.intro')}
      </p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={spec}
          placeholder={t('settings:context.pluginInstaller.placeholder')}
          aria-label={t('settings:context.pluginInstaller.placeholder')}
          onChange={(event) => setSpec(event.target.value)}
          className="min-w-[160px] flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => act('install')}
          className={`${button} bg-primary text-primary-foreground border-transparent`}
        >
          <Download className="h-4 w-4" /> {t('settings:context.pluginInstaller.install')}
        </button>
        <button type="button" disabled={busy} onClick={() => act('remove')} className={button}>
          <Trash2 className="h-4 w-4" /> {t('settings:context.pluginInstaller.remove')}
        </button>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void run('list')} className={button}>
          <ListChecks className="h-4 w-4" /> {t('settings:context.pluginInstaller.showConfigured')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run('official')}
          className={button}
        >
          {t('settings:context.pluginInstaller.showOfficial')}
        </button>
      </div>
      {busy && (
        <p className="text-xs text-muted-foreground">
          {t('settings:context.pluginInstaller.working')}
        </p>
      )}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {output && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-2 text-xs">
          {output}
        </pre>
      )}
    </section>
  );
}
