import type { ModelEntry, Settings } from '@atelier/contracts';

/**
 * Models chosen for the chat pickers. A provider with no saved choice shows everything we already
 * know about; otherwise only the chosen ids. The model currently in use always stays visible.
 */
export function isModelShown(settings: Settings, model: ModelEntry): boolean {
  const chosen = settings.visibleModels?.[model.provider];
  if (!chosen) return true;
  if (settings.provider === model.provider && settings.model === model.id) return true;
  return chosen.includes(model.id);
}

/** Same rule, but also keeps a specific model (e.g. the one an agent is already set to). */
export function shownModels(
  models: ModelEntry[],
  settings: Settings,
  keep?: { provider?: string | null; model?: string | null },
): ModelEntry[] {
  return models.filter(
    (m) =>
      isModelShown(settings, m) ||
      (Boolean(keep?.model) && keep?.provider === m.provider && keep?.model === m.id),
  );
}
