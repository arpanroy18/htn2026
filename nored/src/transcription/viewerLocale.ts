export type LanguageCode = string;

const LANGUAGE_ALIASES: Record<string, LanguageCode> = {
  eng: 'en',
  english: 'en',
  fra: 'fr',
  fre: 'fr',
  french: 'fr',
  hin: 'hi',
  hindi: 'hi',
  spa: 'es',
  spanish: 'es',
  deu: 'de',
  ger: 'de',
  german: 'de',
  por: 'pt',
  portuguese: 'pt',
  jpn: 'ja',
  japanese: 'ja',
  zho: 'zh',
  chinese: 'zh',
};

export function normalizeLanguageCode(raw: string | undefined | null): LanguageCode | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed === 'auto' || trimmed === 'und') return null;

  const token = trimmed.split(/[-_]/)[0];
  if (/^[a-z]{2}$/.test(token)) return token;

  const alias = LANGUAGE_ALIASES[token];
  if (alias) return alias;

  for (const [key, code] of Object.entries(LANGUAGE_ALIASES)) {
    if (token.startsWith(key)) return code;
  }

  return null;
}

export function resolveViewerLocale(languageCode: string | undefined | null): LanguageCode {
  return normalizeLanguageCode(languageCode) ?? 'en';
}

let cachedDeviceLanguage: string | undefined;

function readDeviceLanguageCode(): string | undefined {
  if (cachedDeviceLanguage !== undefined) {
    return cachedDeviceLanguage || undefined;
  }

  try {
    // Lazy load — native module may be missing until a dev-client rebuild.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getLocales } = require('expo-localization') as typeof import('expo-localization');
    cachedDeviceLanguage = getLocales()[0]?.languageCode ?? '';
  } catch {
    try {
      cachedDeviceLanguage =
        Intl.DateTimeFormat().resolvedOptions().locale.split(/[-_]/)[0] ?? '';
    } catch {
      cachedDeviceLanguage = '';
    }
  }

  return cachedDeviceLanguage || undefined;
}

export function getViewerLocale(): LanguageCode {
  return resolveViewerLocale(readDeviceLanguageCode());
}

export function sameLanguage(
  left: string | undefined | null,
  right: string | undefined | null,
): boolean {
  const normalizedLeft = normalizeLanguageCode(left);
  const normalizedRight = normalizeLanguageCode(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight;
}

export function needsTranslation(
  sourceLang: string | undefined | null,
  targetLocale: string,
): boolean {
  const source = normalizeLanguageCode(sourceLang);
  const target = normalizeLanguageCode(targetLocale) ?? targetLocale;
  if (!source) return true;
  return source !== target;
}

const ISO2_TO_ABBREV: Record<string, string> = {
  en: 'eng',
  fr: 'fra',
  hi: 'hin',
  es: 'spa',
  de: 'deu',
  pt: 'por',
  ja: 'jpn',
  zh: 'zho',
  ko: 'kor',
  kr: 'kor',
  ar: 'ara',
  ru: 'rus',
  it: 'ita',
};

export function languageCodeAbbrev(code: string | undefined | null): string {
  const normalized = normalizeLanguageCode(code);
  if (!normalized) return '???';
  return ISO2_TO_ABBREV[normalized] ?? normalized.slice(0, 3).padEnd(3, '?');
}

export function localeDisplayName(locale: string): string {
  const code = normalizeLanguageCode(locale) ?? locale;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    if (name) {
      return name.charAt(0).toUpperCase() + name.slice(1);
    }
  } catch {
    // Intl may be unavailable in some test environments.
  }
  return code.toUpperCase();
}
