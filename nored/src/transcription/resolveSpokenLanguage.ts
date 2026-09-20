import type { LanguageCode } from './viewerLocale.ts';

export function transcriptsDifferMeaningfully(a: string, b: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\s\u0900-\u097F]/g, '')
      .replace(/\s+/g, ' ');

  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right || left === right) return false;

  const leftWordList = left.split(' ').filter(Boolean);
  const rightWordList = right.split(' ').filter(Boolean);
  const leftWords = new Set(leftWordList);
  const overlap = rightWordList.filter((word) => leftWords.has(word)).length;
  const ratio = overlap / Math.max(leftWordList.length, rightWordList.length, 1);
  return ratio < 0.5;
}

type LanguageSignals = {
  whisperDetected?: LanguageCode | null;
  textHint?: LanguageCode | null;
  translateSource?: LanguageCode | null;
  platformSource?: LanguageCode | null;
  transcriptsDiffer?: boolean;
};

/** Merge acoustic + text + translate probes into one spoken language. */
export function resolveLanguageFromSignals(signals: LanguageSignals): LanguageCode | null {
  const {
    whisperDetected,
    textHint,
    translateSource,
    platformSource,
    transcriptsDiffer = false,
  } = signals;

  if (textHint && whisperDetected && textHint !== whisperDetected) {
    return textHint;
  }

  if (translateSource && translateSource !== 'en') {
    return translateSource;
  }

  if (textHint && textHint !== 'en') {
    return textHint;
  }

  if (whisperDetected === 'en') {
    if (transcriptsDiffer && platformSource && platformSource !== 'en') {
      return platformSource;
    }
    if (platformSource && platformSource !== 'en') {
      return platformSource;
    }
  }

  return whisperDetected ?? textHint ?? platformSource ?? null;
}
