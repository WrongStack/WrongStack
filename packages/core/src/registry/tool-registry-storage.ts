import type { Tool } from '@wrongstack/contracts/types/tool';
import { applyToolDescriptionModeToTool } from '../utils/tool-description-mode.js';
import type { ToolRegistration } from './tool-registry-types.js';

/** Indexed identity and scoped registration lifetimes shared by registry mutations. */
export abstract class ToolRegistryStorage {
  protected readonly tools = new Map<string, ToolRegistration>();
  private readonly aliases = new Map<string, string>();
  protected _version = 0;
  protected abstract _prepareForStorage(tool: Tool): Tool;
  protected abstract _stampDefTokens(tool: Tool): void;
  protected clearAliasIndex(): void {
    this.aliases.clear();
  }

  protected validateAliases(tool: Tool): void {
    const names = [tool.name, ...(tool.aliases ?? [])];
    if (
      new Set(names).size !== names.length ||
      (tool.aliases ?? []).some((name) => !/^[a-zA-Z0-9_-]+$/.test(name))
    ) {
      throw new Error(`Invalid or duplicate alias for tool "${tool.name}"`);
    }
    for (const name of names) {
      const owner = this.tools.has(name) ? name : this.aliases.get(name);
      if (owner && owner !== tool.name) {
        throw new Error(
          `Tool name or alias for "${tool.name}" is already registered by "${owner}"`,
        );
      }
    }
  }

  protected storeRegistration(name: string, registration: ToolRegistration): void {
    this.deleteRegistration(name);
    this.tools.set(name, registration);
    for (const alias of registration.tool.aliases ?? []) this.aliases.set(alias, name);
  }

  protected deleteRegistration(name: string): boolean {
    for (const alias of this.tools.get(name)?.tool.aliases ?? []) {
      if (this.aliases.get(alias) === name) this.aliases.delete(alias);
    }
    return this.tools.delete(name);
  }

  /** Aliases retain the canonical contract for policy checks and execution. */
  resolveName(name: string): string {
    return this.aliases.get(name) ?? name;
  }

  protected removeRegistration(name: string, registration: ToolRegistration): () => void {
    return () => {
      if (registration.removed) return;
      registration.removed = true;
      const layers: ToolRegistration[] = [];
      let current = this.tools.get(name);
      let found = false;
      while (current) {
        layers.push(current);
        if (current === registration) found = true;
        current = current.previous;
      }
      if (!found) return;
      let base: ToolRegistration | undefined;
      for (const layer of layers.reverse()) {
        if (layer.removed) continue;
        if (!layer.wrapper) {
          let restored: Tool;
          try {
            restored = this._prepareForStorage(
              applyToolDescriptionModeToTool(layer.tool, 'extend'),
            );
          } catch (error) {
            this.deleteRegistration(name);
            this._version++;
            throw error;
          }
          restored._estDefTokens = undefined;
          this._stampDefTokens(restored);
          layer.tool = restored;
          base = layer;
          continue;
        }
        if (!base) continue;
        let wrapped: Tool;
        try {
          wrapped = this._prepareForStorage(
            layer.wrapper(applyToolDescriptionModeToTool(base.tool, 'extend')),
          );
        } catch (error) {
          // A broken surviving decorator must not leave unloaded code callable.
          this.deleteRegistration(name);
          this._version++;
          throw error;
        }
        wrapped._estDefTokens = undefined;
        this._stampDefTokens(wrapped);
        layer.tool = wrapped;
        layer.owner = `${base.owner}+${layer.wrapperOwner}`;
        layer.previous = base;
        base = layer;
      }
      if (base) this.storeRegistration(name, base);
      else this.deleteRegistration(name);
      this._version++;
    };
  }
}
