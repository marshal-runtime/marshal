export function normalizeModelOverride(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value || undefined;
}
