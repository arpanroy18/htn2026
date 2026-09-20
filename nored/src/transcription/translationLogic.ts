export function normalizeTranslatedText(
  translatedTexts: string | string[] | Record<string, string | string[]>,
): string | null {
  if (typeof translatedTexts === 'string') return translatedTexts;
  if (Array.isArray(translatedTexts)) return translatedTexts[0] ?? null;

  for (const value of Object.values(translatedTexts)) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && value[0]) return value[0];
  }

  return null;
}
