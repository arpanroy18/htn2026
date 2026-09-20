import { Platform } from 'react-native';
import {
  onPrepareTranslation,
  onTranslateTask,
  TranslationError,
} from 'expo-translate-text';

import { inferSourceLocaleFromText } from './inferSourceLocaleFromText';
import { isWhisperArtifactText } from './normalizeTranscriptionResult';
import { normalizeTranslatedText } from './translationLogic';
import {
  getViewerLocale,
  normalizeLanguageCode,
  sameLanguage,
  type LanguageCode,
} from './viewerLocale';

let queue = Promise.resolve<TranslationOutcome>({ result: null });
let lastTranslationError: string | undefined;
const preparedPairs = new Set<string>();

export type TranslationOutcome = {
  result: {
    text: string;
    targetLocale: LanguageCode;
    sourceLocale?: LanguageCode | null;
  } | null;
  skipped?: boolean;
  detectedSourceLanguage?: LanguageCode | null;
  error?: string;
};

export function getLastTranslationError() {
  return lastTranslationError;
}

function setTranslationError(error: string | undefined) {
  lastTranslationError = error;
  if (error && __DEV__) {
    console.warn(`[TranslationService] ${error}`);
  }
}

function pairKey(source: LanguageCode, target: LanguageCode) {
  return `${source}->${target}`;
}

function isCancellationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensurePairPrepared(source: LanguageCode, target: LanguageCode) {
  if (Platform.OS !== 'ios' || sameLanguage(source, target)) return;

  const key = pairKey(source, target);
  if (preparedPairs.has(key)) return;

  const result = await onPrepareTranslation({
    sourceLangCode: source,
    targetLangCode: target,
  });
  if (result.status === 'cancelled') {
    throw new Error('Language pack download was cancelled.');
  }
  preparedPairs.add(key);
}

async function runTranslation(
  text: string,
  targetLocale: LanguageCode,
  sourceHint?: LanguageCode | null,
): Promise<TranslationOutcome> {
  if (isWhisperArtifactText(text)) {
    const message = 'Transcription did not capture spoken words. Try a longer voice note.';
    setTranslationError(message);
    return { result: null, error: message };
  }

  const hintedSource = normalizeLanguageCode(sourceHint);

  try {
    if (hintedSource && !sameLanguage(hintedSource, targetLocale)) {
      await ensurePairPrepared(hintedSource, targetLocale);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await onTranslateTask({
          input: text,
          targetLangCode: targetLocale,
          preferredStrategy: 'lowLatency',
        });

        const detectedSource =
          normalizeLanguageCode(response.sourceLanguage) ??
          hintedSource ??
          inferSourceLocaleFromText(text);

        if (detectedSource && sameLanguage(detectedSource, targetLocale)) {
          return { result: null, skipped: true, detectedSourceLanguage: detectedSource };
        }

        const translated = normalizeTranslatedText(response.translatedTexts);
        if (!translated?.trim()) {
          throw new Error('Translation returned empty text.');
        }
        if (translated.trim() === text.trim()) {
          return { result: null, skipped: true, detectedSourceLanguage: detectedSource };
        }

        if (detectedSource && !sameLanguage(detectedSource, targetLocale)) {
          await ensurePairPrepared(detectedSource, targetLocale);
        }

        setTranslationError(undefined);
        return {
          result: { text: translated.trim(), targetLocale, sourceLocale: detectedSource },
          detectedSourceLanguage: detectedSource,
        };
      } catch (error) {
        lastError = error;
        if (attempt < 2 && isCancellationError(error)) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw error;
      }
    }

    throw lastError ?? new Error('Translation failed.');
  } catch (error) {
    const message =
      error instanceof TranslationError
        ? `${error.message} (${error.code})`
        : error instanceof Error
          ? error.message
          : 'Translation failed.';
    setTranslationError(message);
    return { result: null, error: message, detectedSourceLanguage: hintedSource };
  }
}

export async function translateTranscript(
  text: string,
  targetLocale?: LanguageCode,
  sourceHint?: LanguageCode | null,
): Promise<TranslationOutcome> {
  const target = targetLocale ?? getViewerLocale();
  const next = queue.then(() => runTranslation(text, target, sourceHint));
  queue = next.catch(() => ({ result: null }));
  return next;
}

/** Platform language ID from transcript text (no sourceLangCode). */
export async function detectSourceLanguageFromText(
  text: string,
): Promise<LanguageCode | null> {
  const sample = text.trim();
  if (!sample) return null;

  try {
    const response = await onTranslateTask({
      input: sample,
      targetLangCode: 'fr',
      preferredStrategy: 'lowLatency',
    });
    return (
      normalizeLanguageCode(response.sourceLanguage) ?? inferSourceLocaleFromText(text)
    );
  } catch {
    return inferSourceLocaleFromText(text);
  }
}
