import { normalizeLanguageCode } from './viewerLocale.ts';

export function resolveWhisperResultLanguage(
  payloadLanguage: string,
  options: { language?: string; translate?: boolean },
): string {
  const detected = normalizeLanguageCode(payloadLanguage);
  if (detected) return detected;
  if (options.language && options.language !== 'auto') {
    return normalizeLanguageCode(options.language) ?? options.language;
  }
  return payloadLanguage;
}
