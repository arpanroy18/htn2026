import type { LanguageCode } from './viewerLocale.ts';

const FRENCH_WORDS =
  /\b(bonjour|bonsoir|salut|merci|oui|non|comment|allez|vous|tu|je|nous|avec|pour|dans|une|des|les|est|suis|parle|aujourd|francais|français|madame|monsieur|très|bien|chez)\b/i;

const ENGLISH_WORDS =
  /\b(hello|how|are|you|today|the|and|what|where|when|good|morning|thanks|please|doing|going|have|this|that)\b/i;

const HINDI_WORDS =
  /\b(namaste|namaskar|kaise|kya|hai|hain|main|aap|aapka|dhanyavaad|shukriya|theek|achha|accha|nahi|nahin|haan|kripya|kyun|kahan|kal|aaj)\b/i;

const DEVANAGARI = /[\u0900-\u097F]/;
const FRENCH_DIACRITICS = /[àâæçéèêëîïôùûüœ]/i;

/** Last-resort text hint when platform or Whisper language metadata is missing. */
export function inferSourceLocaleFromText(text: string): LanguageCode | null {
  const sample = text.trim();
  if (!sample) return null;
  if (DEVANAGARI.test(sample)) return 'hi';
  if (FRENCH_DIACRITICS.test(sample)) return 'fr';

  const hindi = HINDI_WORDS.test(sample);
  const french = FRENCH_WORDS.test(sample);
  const english = ENGLISH_WORDS.test(sample);

  const hits = [
    hindi ? 'hi' : null,
    french ? 'fr' : null,
    english ? 'en' : null,
  ].filter(Boolean) as LanguageCode[];

  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    if (hindi) return 'hi';
    if (french) return 'fr';
    return 'en';
  }
  return null;
}
