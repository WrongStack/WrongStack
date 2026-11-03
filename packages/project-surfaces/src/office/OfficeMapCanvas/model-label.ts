/** Preserve the full provider/model identity for detail views and tooltips. */
export function agentModelLabel(provider?: string, model?: string): string | undefined {
  if (!provider) return model || undefined;
  if (!model) return provider;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
