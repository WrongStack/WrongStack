import type { Config, PluginConfig, PluginManagerConfig } from '@wrongstack/contracts/types';

export interface PluginManagementDeps {
  config: Config;
  configPath: string;
  /** Override `~/.wrongstack` for tests. Defaults to the real home dir. */
  globalRoot?: string | undefined;
  /** Injectable package-manager runner for tests. */
  runPackageManager?:
    | ((pm: string, args: readonly string[], cwd: string) => Promise<PackageManagerRunResult>)
    | undefined;
}

export interface PackageManagerRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface PluginManagementResult {
  code: number;
  level: 'output' | 'info' | 'error';
  message: string;
  patch?: {
    plugins?: (string | PluginConfig)[] | undefined;
    features?: Record<string, unknown>;
    pluginManager?: PluginManagerConfig | undefined;
    /**
     * Full replacement `extensions` map (patchConfig is a SHALLOW merge,
     * so per-plugin llm overrides must ship the whole merged object).
     */
    extensions?: Record<string, Record<string, unknown>> | undefined;
  };
  restartRequired?: boolean | undefined;
}
