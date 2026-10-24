import { ERROR_CODES, PluginError } from '@wrongstack/contracts/types/errors';
import type { Plugin, PluginAPI } from '@wrongstack/contracts/types/plugin';

/**
 * Wrap the PluginAPI so calls that contradict the plugin's declared
 * capabilities are caught. By default violations are logged as warnings
 * (backward-compatible). When `enforce` is true, violations throw a
 * PluginError so the host can reject misbehaving plugins at setup time.
 */
export function wrapApiForCapabilityCheck(
  plugin: Plugin,
  api: PluginAPI,
  log: {
    error(msg: string, ctx?: unknown): void | undefined;
    warn?(msg: string, ctx?: unknown): void | undefined;
    info?(msg: string, ctx?: unknown): void | undefined;
  },
  enforce = false,
): PluginAPI {
  const caps = plugin.capabilities ?? {};
  const violate = (subsystem: string, detail: string) => {
    const msg = `Plugin "${plugin.name}" used ${subsystem} without declaring capabilities.${subsystem} — ${detail}`;
    if (enforce) {
      throw new PluginError({
        message: msg,
        code: ERROR_CODES.PLUGIN_LOAD_FAILED,
        pluginName: plugin.name,
        context: { subsystem, detail },
      });
    }
    if (typeof log.warn === 'function') log.warn(msg);
    else log.error(msg);
  };

  // Wrap tools.register
  const wrappedTools =
    caps.tools !== false
      ? api.tools
      : new Proxy(api.tools, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (t: unknown) => {
                violate(
                  'tools',
                  `register(${(t as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(t);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap providers.register
  const wrappedProviders =
    caps.providers !== false
      ? api.providers
      : new Proxy(api.providers, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (f: unknown) => {
                violate(
                  'providers',
                  `register(${(f as { type?: string | undefined })?.type ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(f);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  const wrappedProviderAuth =
    caps.providerAuth !== false
      ? api.providerAuth
      : new Proxy(api.providerAuth, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (strategy: unknown) => {
                violate(
                  'providerAuth',
                  `register(${(strategy as { id?: string | undefined })?.id ?? '<unknown>'})`,
                );
                return (target.register as (value: unknown) => unknown)(strategy);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap slashCommands.register
  const wrappedSlash =
    caps.slashCommands !== false
      ? api.slashCommands
      : new Proxy(api.slashCommands, {
          get(target, prop, receiver) {
            if (prop === 'register') {
              return (c: unknown) => {
                violate(
                  'slashCommands',
                  `register(${(c as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.register as (x: unknown) => unknown)(c);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap mcp.start
  const wrappedMcp =
    caps.mcp !== false
      ? api.mcp
      : new Proxy(api.mcp, {
          get(target, prop, receiver) {
            if (prop === 'start') {
              return (cfg: unknown) => {
                violate(
                  'mcp',
                  `start(${(cfg as { name?: string | undefined })?.name ?? '<unknown>'})`,
                );
                return (target.start as (x: unknown) => unknown)(cfg);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap api.llm.complete. The facade is optional on minimal hosts; when it
  // exists, an explicit `llm: false` declaration is treated like the other
  // capability contradictions while still preserving warn-only compatibility.
  const wrappedLlm =
    caps.llm !== false || !api.llm
      ? api.llm
      : new Proxy(api.llm, {
          get(target, prop, receiver) {
            if (prop === 'complete' || prop === 'council') {
              return (prompt: string, options?: unknown) => {
                violate('llm', `${String(prop)}(${prompt.length} chars)`);
                const method = target[prop] as ((p: string, o?: unknown) => unknown) | undefined;
                if (!method) return undefined;
                return options === undefined
                  ? method.call(target, prompt)
                  : method.call(target, prompt, options);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
  // Wrap registerHook — same pattern as the other subsystems. A plugin that
  // explicitly declared `hooks: false` gets warned/throws on registerHook.
  // Per-hook matchers and payloads are unchanged; only the call is gated.
  const wrappedHooks =
    caps.hooks !== false
      ? api
      : new Proxy(api, {
          get(target, prop, receiver) {
            if (prop === 'registerHook') {
              return (event: unknown, matcher: unknown, hook: unknown, options?: unknown) => {
                const ev = typeof event === 'string' ? event : '<unknown>';
                const m = typeof matcher === 'string' ? matcher : '*';
                violate('hooks', `registerHook(${ev}, ${m})`);
                const register = target.registerHook as (
                  e: unknown,
                  m: unknown,
                  h: unknown,
                  o?: unknown,
                ) => unknown;
                return options === undefined
                  ? register(event, matcher, hook)
                  : register(event, matcher, hook, options);
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });

  return new Proxy(api, {
    get(target, prop, receiver) {
      switch (prop) {
        case 'tools':
          return wrappedTools;
        case 'providers':
          return wrappedProviders;
        case 'providerAuth':
          return wrappedProviderAuth;
        case 'slashCommands':
          return wrappedSlash;
        case 'mcp':
          return wrappedMcp;
        case 'llm':
          return wrappedLlm;
        case 'registerHook':
          // The hooks gate wraps the API itself (because registerHook is on
          // the API, not on a sub-registry). Forward to wrappedHooks so the
          // capability check fires.
          return (wrappedHooks as unknown as Record<PropertyKey, unknown>)[prop];
        default:
          return Reflect.get(target, prop, receiver);
      }
    },
  });
}
