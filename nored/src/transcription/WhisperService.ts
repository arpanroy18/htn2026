import { File } from 'expo-file-system';
import * as Device from 'expo-device';
import { initWhisper, type WhisperContext } from 'whisper.rn';

import {
  ensureWavSidecar,
  isAudioConverterLinked,
  needsWavConversion,
  resolveVoiceNoteFile,
  transcriptionSidecarFor,
} from './audioSidecar';
import { extractPcm16FromWav, wavDurationSeconds } from './extractPcm16FromWav';
import {
  normalizeTranscriptionResult,
  type TranscriptionResult,
} from './normalizeTranscriptionResult';
import { detectSourceLanguageFromText } from './TranslationService';
import { inferSourceLocaleFromText } from './inferSourceLocaleFromText';
import { preferTextTranslation } from './preferTextTranslation';
import {
  resolveLanguageFromSignals,
  transcriptsDifferMeaningfully,
} from './resolveSpokenLanguage';
import { resolveWhisperResultLanguage } from './whisperResultLanguage';
import { normalizeLanguageCode, type LanguageCode } from './viewerLocale';

const IDLE_RELEASE_MS = 3 * 60 * 1000;
const MIN_CONFIRM_DURATION_SEC = 5;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const WHISPER_MODEL = require('../../assets/models/ggml-base-q5_1.bin') as number;

let context: WhisperContext | null = null;
let initPromise: Promise<WhisperContext | null> | null = null;
let queue = Promise.resolve<TranscriptionOutcome>({ result: null });
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let lastTranscriptionError: string | undefined;

export type TranscriptionOutcome = {
  result: TranscriptionResult | null;
  /** Speech-to-English via Whisper translate mode (audio-based, language agnostic). */
  whisperTranslation?: string;
  error?: string;
};

export function getLastTranscriptionError() {
  return lastTranscriptionError;
}

export { ensureWavSidecar } from './audioSidecar';

function setTranscriptionError(error: string | undefined) {
  lastTranscriptionError = error;
  if (error && __DEV__) {
    console.warn(`[WhisperService] ${error}`);
  }
}

function scheduleIdleRelease() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void releaseWhisper();
  }, IDLE_RELEASE_MS);
}

async function createWhisperContext(useGpu: boolean) {
  return initWhisper({
    filePath: WHISPER_MODEL,
    useGpu,
    useCoreMLIos: true,
  });
}

async function ensureWhisperReady(): Promise<WhisperContext | null> {
  if (context) return context;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      context = await createWhisperContext(true);
      return context;
    } catch (gpuError) {
      try {
        context = await createWhisperContext(false);
        return context;
      } catch (cpuError) {
        const message =
          cpuError instanceof Error
            ? cpuError.message
            : gpuError instanceof Error
              ? gpuError.message
              : 'Whisper failed to initialize.';
        setTranscriptionError(`Model init failed: ${message}`);
        return null;
      }
    }
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

async function resolveWavForTranscription(sourceFile: File): Promise<File> {
  const sidecar = transcriptionSidecarFor(sourceFile);
  if (sidecar.exists && sidecar.size > 44) return sidecar;

  const prepared = await ensureWavSidecar(sourceFile.uri);
  if (prepared) return prepared;

  if (!needsWavConversion(sourceFile.uri)) {
    return sourceFile;
  }

  if (!isAudioConverterLinked()) {
    throw new Error(
      'Audio conversion native module is missing. Rebuild with npm run ios:device.',
    );
  }

  throw new Error('Could not convert the voice note to WAV for transcription.');
}

type WhisperRunOptions = {
  language?: string;
  translate?: boolean;
};

async function runWhisperOnWav(
  whisperContext: WhisperContext,
  wavFile: File,
  options: WhisperRunOptions,
): Promise<TranscriptionResult | null> {
  const whisperOptions = {
    maxThreads: 4,
    language: options.language ?? 'auto',
    translate: options.translate ?? false,
  };

  try {
    const { promise } = whisperContext.transcribe(wavFile.uri, whisperOptions);
    const normalized = normalizeTranscriptionResult(await promise);
    if (!normalized) return null;
    return {
      ...normalized,
      language: resolveWhisperResultLanguage(normalized.language, options),
    };
  } catch (fileError) {
    if (__DEV__) {
      const message = fileError instanceof Error ? fileError.message : String(fileError);
      console.warn(`[WhisperService] transcribe(file) fallback to PCM: ${message}`);
    }
    const pcm = extractPcm16FromWav(await wavFile.bytes()).pcm;
    const { promise } = whisperContext.transcribeData(pcm, whisperOptions);
    const normalized = normalizeTranscriptionResult(await promise);
    if (!normalized) return null;
    return {
      ...normalized,
      language: resolveWhisperResultLanguage(normalized.language, options),
    };
  }
}

async function whisperSpeechToEnglish(
  whisperContext: WhisperContext,
  wavFile: File,
  sourceLanguage?: LanguageCode | null,
): Promise<string | null> {
  const result = await runWhisperOnWav(whisperContext, wavFile, {
    language: sourceLanguage ?? 'auto',
    translate: true,
  });
  return result?.text ?? null;
}

type SpokenLanguageResolution = {
  language: LanguageCode | null;
  translateProbeText?: string;
  transcriptsDiffer?: boolean;
};

async function resolveSpokenLanguage(
  whisperContext: WhisperContext,
  wavFile: File,
  auto: TranscriptionResult,
): Promise<SpokenLanguageResolution> {
  const whisperDetected = normalizeLanguageCode(auto.language);
  const textHint = inferSourceLocaleFromText(auto.text);

  let translateSource: LanguageCode | null = null;
  let translateProbeText: string | undefined;
  let transcriptsDiffer = false;
  if (!whisperDetected || whisperDetected === 'en') {
    const translateProbe = await runWhisperOnWav(whisperContext, wavFile, {
      language: 'auto',
      translate: true,
    });
    translateSource = normalizeLanguageCode(translateProbe?.language);
    translateProbeText = translateProbe?.text;
    if (translateProbe) {
      transcriptsDiffer = transcriptsDifferMeaningfully(auto.text, translateProbe.text);
    }
  }

  let platformSource: LanguageCode | null = null;
  if (
    (!whisperDetected || whisperDetected === 'en') &&
    (textHint || transcriptsDiffer)
  ) {
    platformSource = await detectSourceLanguageFromText(auto.text);
  }

  return {
    language: resolveLanguageFromSignals({
      whisperDetected,
      textHint,
      translateSource,
      platformSource,
      transcriptsDiffer,
    }),
    translateProbeText,
    transcriptsDiffer,
  };
}

async function transcribePreparedAudio(
  whisperContext: WhisperContext,
  wavFile: File,
): Promise<{ result: TranscriptionResult | null; translateProbeText?: string; transcriptsDiffer?: boolean }> {
  const auto = await runWhisperOnWav(whisperContext, wavFile, { language: 'auto' });
  if (!auto) return { result: null };

  const whisperDetected = normalizeLanguageCode(auto.language);
  const resolution = await resolveSpokenLanguage(whisperContext, wavFile, auto);
  const resolvedLanguage = resolution.language ?? whisperDetected;

  if (!resolvedLanguage) {
    return {
      result: auto,
      translateProbeText: resolution.translateProbeText,
      transcriptsDiffer: resolution.transcriptsDiffer,
    };
  }

  const duration = wavDurationSeconds(await wavFile.bytes());
  const shouldConfirm =
    resolvedLanguage !== whisperDetected || duration >= MIN_CONFIRM_DURATION_SEC;

  if (shouldConfirm) {
    const confirmed = await runWhisperOnWav(whisperContext, wavFile, {
      language: resolvedLanguage,
    });
    if (confirmed) {
      return {
        result: { ...confirmed, language: resolvedLanguage },
        translateProbeText: resolution.translateProbeText,
        transcriptsDiffer: resolution.transcriptsDiffer,
      };
    }
  }

  return {
    result: { ...auto, language: resolvedLanguage },
    translateProbeText: resolution.translateProbeText,
    transcriptsDiffer: resolution.transcriptsDiffer,
  };
}

async function runTranscription(fileUri: string): Promise<TranscriptionOutcome> {
  if (!Device.isDevice) {
    return { result: null, error: 'Transcription requires a physical device.' };
  }

  const whisperContext = await ensureWhisperReady();
  if (!whisperContext) {
    return {
      result: null,
      error: lastTranscriptionError ?? 'Whisper model is unavailable on this device.',
    };
  }

  try {
    const sourceFile = resolveVoiceNoteFile(fileUri);
    if (!sourceFile.exists) {
      throw new Error('The voice note file is no longer on this phone.');
    }

    const wavFile = await resolveWavForTranscription(sourceFile);
    const prepared = await transcribePreparedAudio(whisperContext, wavFile);
    const result = prepared.result;
    if (!result) {
      throw new Error(
        'Whisper could not transcribe this voice note. Try speaking for at least 5 seconds.',
      );
    }

    const sourceLocale = normalizeLanguageCode(result.language);
    let whisperTranslation: string | undefined;
    if (
      sourceLocale &&
      sourceLocale !== 'en' &&
      !preferTextTranslation(result.text)
    ) {
      const english = await whisperSpeechToEnglish(whisperContext, wavFile, sourceLocale);
      if (english && english.trim() !== result.text.trim()) {
        whisperTranslation = english.trim();
      }
    } else if (
      prepared.translateProbeText &&
      prepared.transcriptsDiffer &&
      prepared.translateProbeText.trim() !== result.text.trim()
    ) {
      whisperTranslation = prepared.translateProbeText.trim();
    }

    setTranscriptionError(undefined);
    return { result, whisperTranslation };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed.';
    setTranscriptionError(message);
    return { result: null, error: message };
  }
}

export async function transcribeVoiceNote(fileUri: string): Promise<TranscriptionOutcome> {
  const next = queue.then(() => runTranscription(fileUri));
  queue = next.catch(() => ({ result: null }));
  const outcome = await next;
  scheduleIdleRelease();
  return outcome;
}

export async function whisperTranslateAudioToEnglish(
  fileUri: string,
  sourceLanguage?: LanguageCode | null,
): Promise<string | null> {
  const next = queue.then(async () => {
    if (!Device.isDevice) return null;
    const whisperContext = await ensureWhisperReady();
    if (!whisperContext) return null;

    const sourceFile = resolveVoiceNoteFile(fileUri);
    if (!sourceFile.exists) return null;

    const wavFile = await resolveWavForTranscription(sourceFile);
    return whisperSpeechToEnglish(whisperContext, wavFile, sourceLanguage);
  });
  queue = next.catch(() => null);
  const outcome = await next;
  scheduleIdleRelease();
  return outcome;
}

export async function releaseWhisper(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (!context) return;
  await context.release();
  context = null;
}
